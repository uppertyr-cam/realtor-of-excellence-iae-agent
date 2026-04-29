// ============================================================
// Bump Handler
// Instant Appointment Engine — 03
//
// Owns: bump scheduling, bump sending (24h/48h/72h), bump close (73h)
// Called by: scheduler.ts (tick), ai-send-router.ts (schedule/cancel)
// ============================================================

import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { sendWhatsAppMessage, sendWhatsAppTemplate } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'
import { writeToCrm } from '../crm/adapter'
import { updateDashboard } from '../reports/dashboard'
import { buildWeeklyReport, updateMetrics } from '../reports/weekly-report'
import { generateBumpMessage } from '../ai/generate'
import { calcHaikuCost, countLegacyTokens, getWhatsAppMarketingTemplateCostUsd } from '../config/pricing'
import { logger } from '../utils/logger'
import { alertEmail } from '../utils/alert'
import { publishInboxEvent } from '../inbox/live-events'

// ─── SCHEDULE 3 BUMPS + BUMP_CLOSE ───────────────────────────
// Called after every AI reply (ai-send-router) and after reach-back-out send (scheduler)
export async function scheduleBumps(contactId: string, clientId: string): Promise<void> {
  await db.query(
    `INSERT INTO outbound_queue (client_id, contact_id, message_type, status, scheduled_at)
     VALUES
       ($1,$2,'bump','pending', NOW() + INTERVAL '24 hours'),
       ($1,$2,'bump','pending', NOW() + INTERVAL '48 hours'),
       ($1,$2,'bump','pending', NOW() + INTERVAL '72 hours'),
       ($1,$2,'bump_close','pending', NOW() + INTERVAL '73 hours')`,
    [clientId, contactId]
  )
}

// ─── CANCEL BUMP CLOCK (reset after each AI reply) ───────────
export async function cancelBumps(contactId: string): Promise<void> {
  await db.query(
    `UPDATE outbound_queue SET status='cancelled'
     WHERE contact_id=$1 AND status='pending'
     AND message_type IN ('bump','bump_close')`,
    [contactId]
  )
}

// ─── CANCEL ALL JOBS (used on terminal outcomes) ─────────────
export async function cancelPendingBumps(contactId: string): Promise<void> {
  await db.query(
    `UPDATE outbound_queue SET status='cancelled'
     WHERE contact_id=$1 AND status='pending'
     AND message_type IN ('followup1','followup2','followup3','bump','bump_close')`,
    [contactId]
  )
}

// ─── BUMP QUEUE PROCESSOR (24h / 48h / 72h after each AI reply) ─────────────
export async function processBumpQueue() {
  const res = await db.query(
    `UPDATE outbound_queue SET status='processing'
     WHERE id IN (
       SELECT id FROM outbound_queue
       WHERE status='pending'
       AND scheduled_at <= NOW()
       AND message_type = 'bump'
       ORDER BY scheduled_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`
  )

  for (const job of res.rows) {
    try {
      await processBumpJob(job)
    } catch (err: any) {
      logger.error('Bump job error', { job_id: job.id, error: err.message })
      alertEmail('Bump job error', { job_id: job.id, error: err.message })
      await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [err.message, job.id])
    }
  }
}

async function processBumpJob(job: any) {
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [job.contact_id])
  if (contactRes.rowCount === 0) return
  const contact = contactRes.rows[0]

  // Skip if contact has replied, been closed, or gone to manual takeover
  if (
    ['replied', 'closed', 'completed'].includes(contact.workflow_stage) ||
    contact.tags?.includes('manual_takeover')
  ) {
    await db.query(`UPDATE outbound_queue SET status='cancelled' WHERE id=$1`, [job.id])
    return
  }

  const config = await getClientConfig(contact.client_id)
  const waBumpTemplateNamesGroups: string[][] = config.wa_bump_template_names || []

  const bumpIndex: number = contact.bump_index || 0
  if (bumpIndex >= 3) {
    await db.query(`UPDATE outbound_queue SET status='cancelled' WHERE id=$1`, [job.id])
    return
  }

  const bumpNumber = bumpIndex + 1
  const firstName = contact.first_name || ''

  const aiPhrase = await generateBumpMessage({
    bumpNumber,
    conversationHistory: contact.ai_memory || '',
  })

  const bumpMessages: Record<number, string> = {
    1: `Hey ${firstName}, just checking in — we were chatting about ${aiPhrase.text} and I didn't want to leave you hanging.`,
    2: `Wanted to circle back, ${firstName} — we were busy discussing ${aiPhrase.text}. Let me know if you've got questions.`,
    3: `Won't keep nudging after this, ${firstName} - just didn't want you to get stuck on ${aiPhrase.text}. Reply whenever it suits.`,
  }
  const message = bumpMessages[bumpNumber]

  const waTemplateName = waBumpTemplateNamesGroups[bumpIndex]?.[0] ?? null
  const channel = contact.channel || config.channel

  let result
  if (channel === 'whatsapp' && waTemplateName) {
    result = await sendWhatsAppTemplate(
      contact.phone_number,
      waTemplateName,
      [firstName, aiPhrase.text],
      config.wa_phone_number_id!,
      config.wa_access_token!
    )
  } else if (channel === 'whatsapp') {
    result = await sendWhatsAppMessage(contact.phone_number, message, config.wa_phone_number_id!, config.wa_access_token!)
  } else {
    result = await sendSmsMessage(contact.phone_number, message, config.sms_account_sid!, config.sms_auth_token!, config.sms_from_number!)
  }

  if (!result.success) {
    await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [result.error, job.id])
    return
  }

  const now = new Date()
  const templateCostUsd = channel === 'whatsapp' && waTemplateName
    ? getWhatsAppMarketingTemplateCostUsd(config)
    : 0

  await db.query(
    `UPDATE contacts SET bump_index=$1,
       total_tokens_used=total_tokens_used+$2,
       total_cost_usd=total_cost_usd+$3
     WHERE id=$4`,
    [bumpIndex + 1, countLegacyTokens(aiPhrase.usage), calcHaikuCost(aiPhrase.usage) + templateCostUsd, contact.id]
  )
  await db.query(`UPDATE outbound_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [job.id])

  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: ['bump_sent'],
      note: `IAE: Bump ${bumpNumber} sent via ${channel}.\n\nMessage: ${message}\n\nTimestamp: ${now.toISOString()}`,
      fields: { ai_memory: (contact.ai_memory || '') + `\nAI (bump): ${message}` },
    },
    config, contact.crm_callback_url
  )

  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type)
     VALUES ($1,$2,'outbound',$3,$4,'bump')`,
    [contact.id, config.id, channel, message]
  )
  publishInboxEvent({
    type: 'message_created',
    contactId: contact.id,
    clientId: config.id,
    timestamp: new Date().toISOString(),
  })

  updateDashboard(contact.client_id).catch(() => {})
  updateMetrics(contact.client_id).catch(() => {})
  logger.info('Bump sent', { contact_id: contact.id, channel, bump_number: bumpNumber })
}

// ─── BUMP CLOSE QUEUE PROCESSOR (73h — no reply after 3 bumps) ──────────────
export async function processBumpCloseQueue() {
  const res = await db.query(
    `UPDATE outbound_queue SET status='processing'
     WHERE id IN (
       SELECT id FROM outbound_queue
       WHERE status='pending'
       AND scheduled_at <= NOW()
       AND message_type = 'bump_close'
       ORDER BY scheduled_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`
  )

  for (const job of res.rows) {
    try {
      await processBumpCloseJob(job)
    } catch (err: any) {
      logger.error('Bump close job error', { job_id: job.id, error: err.message })
      alertEmail('Bump close job error', { job_id: job.id, error: err.message })
      await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [err.message, job.id])
    }
  }
}

async function processBumpCloseJob(job: any) {
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [job.contact_id])
  if (contactRes.rowCount === 0) return
  const contact = contactRes.rows[0]

  // If lead replied since bumps were scheduled, nothing to do
  const jobScheduledAt = new Date(job.created_at).getTime()
  const lastReplyAt = contact.last_reply_at ? new Date(contact.last_reply_at).getTime() : 0
  if (lastReplyAt > jobScheduledAt) {
    await db.query(`UPDATE outbound_queue SET status='cancelled' WHERE id=$1`, [job.id])
    return
  }

  const config = await getClientConfig(contact.client_id)

  await db.query(
    `UPDATE contacts SET tags=array_append(tags,'bump_no_reply') WHERE id=$1`,
    [contact.id]
  )

  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: ['bump_no_reply'],
      note: `IAE: No reply after 3 bumps (72h window).\n\nConversation history:\n${contact.ai_memory || 'No conversation recorded.'}\n\nTimestamp: ${new Date().toISOString()}`,
    },
    config, contact.crm_callback_url
  )

  await db.query(`UPDATE outbound_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [job.id])

  updateDashboard(contact.client_id).catch(() => {})
  updateMetrics(contact.client_id).catch(() => {})
  buildWeeklyReport().catch(() => {})

  logger.info('Bump close fired — no reply after 3 bumps', { contact_id: contact.id })
}
