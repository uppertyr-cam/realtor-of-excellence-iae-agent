// ============================================================
// AI Response Send + Keyword Routing
// Instant Appointment Engine
//
// Entry: triggered by Inbound Reply Handler when AI response is ready
// Handles: killswitch check → send → keyword detection → CRM
// ============================================================

import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { writeToCrm } from '../crm/adapter'
import { sendWhatsAppMessage } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'
import { logger } from '../utils/logger'
import { updateDashboard } from '../reports/dashboard'
import { buildWeeklyReport, updateMetrics } from '../reports/weekly-report'
import { generateContactNote } from '../ai/generate'
import type { DetectedKeyword, SendResult } from '../utils/types'
import { scheduleBumps, cancelBumps, cancelPendingBumps } from './bump-handler'

// ─── ENTRY POINT ─────────────────────────────────────────────
export async function handleAIResponseReady(contactId: string, routedKeyword?: DetectedKeyword, scheduledAt?: string | null, chatHistory?: string) {
  logger.info('AI Response Send + Keyword Routing triggered', { contactId })

  // Load pending AI response
  const responseRes = await db.query(
    `SELECT * FROM ai_responses WHERE contact_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  )
  if (responseRes.rowCount === 0) {
    logger.warn('No pending AI response found', { contactId })
    return
  }

  const aiResponse = responseRes.rows[0]
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [contactId])
  if (contactRes.rowCount === 0) return

  const contact = contactRes.rows[0]
  const config = await getClientConfig(contact.client_id)

  // ── Step 1: Remove "reply_generating" tag ─────────────────
  await db.query(
    `UPDATE contacts SET tags=array_remove(tags,'reply_generating') WHERE id=$1`,
    [contactId]
  )

  // ── Step 2: Killswitch check — does message contain "Goodbye"? ──
  const responseText: string = aiResponse.response_text
  if (responseText.toLowerCase().includes('goodbye')) {
    logger.info('Goodbye killswitch triggered', { contactId })
    await handleGoodbyeKillswitch(contact, config, responseText)
    return
  }

  // ── Step 3: Send the AI message ───────────────────────────
  const channel = aiResponse.channel || contact.channel || config.channel
  const sendResult = await sendWithRetry(() => sendMessage(contact, config, responseText, channel))

  if (!sendResult.success) {
    logger.error('AI Response Send + Keyword Routing: send failed after retries', { contactId })
    await db.query(
      `UPDATE ai_responses SET status='failed' WHERE id=$1`,
      [aiResponse.id]
    )
    await writeToCrm(
      { contact_id: contactId, tags_add: ['send_failed'], note: `IAE: AI message send failed — ${sendResult.error}` },
      config, contact.crm_callback_url
    )
    return
  }

  // ── Step 3b: Clear stale send_failed tag (cleanup from earlier failed attempts) ──
  await db.query(
    `UPDATE contacts SET tags=array_remove(tags,'send_failed') WHERE id=$1`,
    [contactId]
  )

  // Inbound Reply Handler already persisted this AI response to ai_memory before handing off here.
  const updatedMemory = contact.ai_memory || ''

  // ── Step 5: Add note to CRM ───────────────────────────────
  await writeToCrm(
    {
      contact_id: contactId,
      note: `IAE: AI message sent via ${channel}.\n\nMessage: ${responseText}\n\nTimestamp: ${new Date().toISOString()}`,
      fields: { ai_memory: updatedMemory },
    },
    config, contact.crm_callback_url
  )

  // ── Mark AI response as sent ──────────────────────────────
  await db.query(
    `UPDATE ai_responses SET status='sent', sent_at=NOW() WHERE id=$1`,
    [aiResponse.id]
  )

  // ── Step 5b: Reset bump clock — cancel any pending bumps and schedule 3 new ones ──
  await cancelBumps(contactId)
  await scheduleBumps(contactId, config.id)

  // Increment bump_variation_index for next cycle (rotates 0→1→2→0...)
  await db.query(
    `UPDATE contacts SET bump_variation_index = (bump_variation_index + 1) % 3 WHERE id=$1`,
    [contactId]
  )

  // ── Log to message_log ────────────────────────────────────
  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type)
     VALUES ($1,$2,'outbound',$3,$4,'ai_reply')`,
    [contactId, config.id, channel, responseText]
  )

  // ── Add "qualifying_questions" tag if starting qualification ──
  const startsQualifying = responseText.toLowerCase().includes('which area') ||
    responseText.toLowerCase().includes('what type of property') ||
    responseText.toLowerCase().includes('price range') ||
    responseText.toLowerCase().includes('how many bedrooms')
  if (startsQualifying && !contact.tags.includes('qualifying_questions')) {
    await db.query(
      `UPDATE contacts SET tags=array_append(tags,'qualifying_questions') WHERE id=$1`,
      [contactId]
    )
  }

  // ── Step 6: Keyword detection ─────────────────────────────
  // Prefer the tool-signalled keyword from Claude; fall back to text scanning as a safety net
  const keyword = routedKeyword && routedKeyword !== 'none' ? routedKeyword : detectKeyword(responseText)
  logger.info('Keyword detected', { contactId, keyword, source: routedKeyword ? 'tool' : 'text_scan' })
  await handleKeyword(keyword, contact, config, responseText, scheduledAt ?? null, chatHistory ?? updatedMemory)
}

// ─── GOODBYE KILLSWITCH ──────────────────────────────────────
async function handleGoodbyeKillswitch(contact: any, config: any, responseText: string) {
  await db.query(
    `UPDATE contacts SET
       workflow_stage='closed',
       tags=array_append(tags,'goodbye_killswitch'),
       updated_at=NOW()
     WHERE id=$1`,
    [contact.id]
  )

  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: ['goodbye_killswitch'],
      note: `IAE: Goodbye killswitch activated. AI determined conversation is complete.\n\nFinal AI message: ${responseText}`,
      fields: { trigger_field: '', ai_response: '' },
    },
    config, contact.crm_callback_url
  )

  // Cancel all queued follow-ups and bumps
  await db.query(
    `UPDATE outbound_queue SET status='cancelled'
     WHERE contact_id=$1 AND status='pending'
     AND message_type IN ('followup1','followup2','followup3','bump','bump_close')`,
    [contact.id]
  )

  updateDashboard(contact.client_id).catch(() => {})
  updateMetrics(contact.client_id).catch(() => {})
  buildWeeklyReport().catch(() => {})
  logger.info('Goodbye killswitch complete', { contactId: contact.id })
}

// ─── KEYWORD DETECTION ───────────────────────────────────────
function detectKeyword(text: string): DetectedKeyword {
  const lower = text.toLowerCase()
  if (lower.includes('not interested'))              return 'not_interested'
  if (lower.includes('renting'))                     return 'renting'
  if (lower.includes("i'll reach back out") ||
      lower.includes("i will reach back out"))       return 'reach_back_out'
  if (lower.includes('senior team member') ||
      lower.includes('more senior'))                 return 'senior_team_member'
  if (lower.includes('interested in purchasing') ||
      lower.includes('want to purchase') ||
      lower.includes('looking to buy') ||
      lower.includes("i'll forward your details") ||
      lower.includes('forward your details to the realtor'))  return 'interested_in_purchasing'
  if (lower.includes('already purchased') ||
      lower.includes('already bought'))              return 'already_purchased'
  return 'none'
}

// ─── KEYWORD ROUTING ─────────────────────────────────────────
async function handleKeyword(
  keyword: DetectedKeyword,
  contact: any,
  config: any,
  responseText: string,
  scheduledAt: string | null = null,
  chatHistory: string = ''
) {
  const contactId = contact.id

  switch (keyword) {
    case 'not_interested':
      await db.query(`UPDATE contacts SET workflow_stage='closed', tags=array_append(array_append(tags,'not_interested'),'manual_takeover') WHERE id=$1`, [contactId])
      await writeToCrm({
        contact_id: contactId,
        tags_add: ['not-interested', 'manual-takeover'],
        note: `IAE: Lead is not interested.\n\nAI message: ${responseText}`,
        opportunity: config.pipeline_id ? { pipeline_id: config.pipeline_id, stage_id: config.pipeline_stage_id, name: 'Not Interested' } : undefined,
      }, config, contact.crm_callback_url)
      await cancelPendingBumps(contactId)
      writeContactNote(contact, config, chatHistory, 'Not Interested').catch(() => {})
      break

    case 'renting':
      await db.query(`UPDATE contacts SET tags=array_append(array_append(tags,'renting'),'manual_takeover') WHERE id=$1`, [contactId])
      await writeToCrm({
        contact_id: contactId,
        tags_add: ['renting', 'manual-takeover'],
        note: `IAE: Lead is renting.\n\nAI message: ${responseText}`,
        opportunity: config.pipeline_id ? { pipeline_id: config.pipeline_id, stage_id: config.pipeline_stage_id, name: 'Interested in Renting' } : undefined,
      }, config, contact.crm_callback_url)
      writeContactNote(contact, config, chatHistory, 'Interested in Renting').catch(() => {})
      break

    case 'reach_back_out': {
      await db.query(`UPDATE contacts SET tags=array_append(tags,'reach_back_out') WHERE id=$1`, [contactId])
      await writeToCrm({
        contact_id: contactId,
        tags_add: ['reach-back-out'],
        note: `IAE: Lead asked to be reached back out to.\n\nScheduled: ${scheduledAt ?? 'not specified'}\n\nAI message: ${responseText}`,
        opportunity: config.pipeline_id ? { pipeline_id: config.pipeline_id, stage_id: config.pipeline_stage_id, name: 'Reach Back Out' } : undefined,
      }, config, contact.crm_callback_url)
      await cancelPendingBumps(contactId)
      writeContactNote(contact, config, chatHistory, 'Reach Back Out').catch(() => {})

      if (!scheduledAt) {
        logger.warn('reach_back_out: no scheduledAt provided — skipping queue insert', { contactId })
        break
      }

      const scheduledDate = new Date(scheduledAt)
      if (isNaN(scheduledDate.getTime())) {
        logger.warn('reach_back_out: invalid scheduledAt value — skipping queue insert', { contactId, scheduledAt })
        break
      }

      await db.query(
        `INSERT INTO outbound_queue (client_id, contact_id, message_type, status, scheduled_at)
         VALUES ($1, $2, 'reach_back_out', 'pending', $3)`,
        [config.id, contactId, scheduledDate.toISOString()]
      )
      logger.info('reach_back_out queued', { contactId, scheduled_at: scheduledDate.toISOString() })
      break
    }

    case 'senior_team_member':
      await db.query(`UPDATE contacts SET tags=array_append(tags,'manual_takeover') WHERE id=$1`, [contactId])
      await writeToCrm({
        contact_id: contactId,
        tags_add: ['manual-takeover', 'over-to-senior'],
        note: `IAE: Escalated to senior team member.\n\nAI message: ${responseText}`,
        opportunity: config.pipeline_id ? { pipeline_id: config.pipeline_id, stage_id: config.pipeline_stage_id, name: 'Over to Senior Team Member' } : undefined,
      }, config, contact.crm_callback_url)
      await cancelPendingBumps(contactId)
      writeContactNote(contact, config, chatHistory, 'Escalated to Senior Team Member').catch(() => {})
      break

    case 'interested_in_purchasing':
      // Remove qualifying_questions, add interested_in_purchasing, manual_takeover, qualified (prevent duplicates)
      await db.query(
        `UPDATE contacts SET tags=array_remove(tags,'qualifying_questions') WHERE id=$1`,
        [contactId]
      )
      await db.query(
        `UPDATE contacts SET tags=ARRAY(SELECT DISTINCT UNNEST(tags || ARRAY['interested_in_purchasing', 'manual_takeover', 'qualified'])) WHERE id=$1`,
        [contactId]
      )
      await writeToCrm({
        contact_id: contactId,
        tags_add: ['interested-in-purchasing', 'manual-takeover', 'qualified'],
        note: `IAE: Lead is interested in purchasing.\n\nAI message: ${responseText}`,
        opportunity: config.pipeline_id ? { pipeline_id: config.pipeline_id, stage_id: config.pipeline_stage_id, name: 'Interested in Purchasing' } : undefined,
      }, config, contact.crm_callback_url)
      await cancelPendingBumps(contactId)
      writeContactNote(contact, config, chatHistory, 'Interested in Purchasing').catch(() => {})
      break

    case 'already_purchased':
      await db.query(`UPDATE contacts SET tags=array_append(array_append(tags,'already_purchased'),'manual_takeover') WHERE id=$1`, [contactId])
      await writeToCrm({
        contact_id: contactId,
        tags_add: ['already-purchased', 'manual-takeover'],
        note: `IAE: Lead has already purchased.\n\nAI message: ${responseText}`,
        opportunity: config.pipeline_id ? { pipeline_id: config.pipeline_id, stage_id: config.pipeline_stage_id, name: 'Already Purchased' } : undefined,
      }, config, contact.crm_callback_url)
      await cancelPendingBumps(contactId)
      writeContactNote(contact, config, chatHistory, 'Already Purchased').catch(() => {})
      break

    case 'none':
    default:
      // No keyword — clear fields and let bump workflow handle follow up
      await writeToCrm(
        { contact_id: contactId, fields: { trigger_field: '', ai_response: '' } },
        config, contact.crm_callback_url
      )
      break
  }

  logger.info('Keyword routing complete', { contactId, keyword })

  // Update live dashboard + metrics — fire and forget (non-fatal)
  updateDashboard(contact.client_id).catch(() => {})
  updateMetrics(contact.client_id).catch(() => {})

  // Update weekly report sheet when conversation reaches a terminal outcome
  if (keyword !== 'none') {
    buildWeeklyReport().catch(() => {})
  }
}

// ─── CONTACT NOTE WRITER ──────────────────────────────────────
async function writeContactNote(contact: any, config: any, chatHistory: string, outcome: string) {
  try {
    const note = await generateContactNote(chatHistory)
    await db.query(`UPDATE contacts SET ai_note=$1 WHERE id=$2`, [note, contact.id])
    await writeToCrm(
      { contact_id: contact.id, note: `Cameron AI System — Conversation Summary:###${note}` },
      config, contact.crm_callback_url
    )
    logger.info('Contact note written', { contactId: contact.id, outcome })
  } catch (err: any) {
    logger.warn('Contact note generation failed — non-fatal', { contactId: contact.id, error: err.message })
  }
}

// ─── HELPERS ─────────────────────────────────────────────────
async function sendMessage(contact: any, config: any, text: string, channel: string): Promise<SendResult> {
  text = text.replace(/[\u2013\u2014]/g, ' - ').replace(/[\u0430]/g, 'a').replace(/[^\x00-\x7F]/g, '')
  if (channel === 'whatsapp') {
    return sendWhatsAppMessage(contact.phone_number, text, config.wa_phone_number_id, config.wa_access_token)
  }
  return sendSmsMessage(contact.phone_number, text, config.sms_account_sid, config.sms_auth_token, config.sms_from_number)
}

async function sendWithRetry(fn: () => Promise<SendResult>, maxRetries = 3): Promise<SendResult> {
  for (let i = 1; i <= maxRetries; i++) {
    const result = await fn()
    if (result.success) return result
    if (i < maxRetries) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i - 1)))
  }
  return { success: false, error: 'Max retries exceeded' }
}
