// ============================================================
// AGENT REPLY HANDLER
// Handles inbound messages from the real estate agent:
//   1. Agent answers a lead's question  → forward to lead + offer FAQ save
//   2. Agent sends "APPROVE"            → append Q&A to prompt file
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { db } from '../db/client'
import { logger } from '../utils/logger'
import { sendWhatsAppMessage } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'

// ─── SEND TEMPLATE TO AGENT ──────────────────────────────────
// Uses an approved WhatsApp template to notify the agent — works
// even outside the 24-hour session window.
export async function sendTemplateToAgent(
  config: any,
  templateName: string,
  variables: string[]
): Promise<void> {
  const agentPhone = config.stage_agents?.default?.target
  if (!agentPhone) {
    logger.warn('sendTemplateToAgent: no default agent phone in stage_agents', { clientId: config.id })
    return
  }
  const { sendWhatsAppTemplate } = await import('../channels/whatsapp')
  const result = await sendWhatsAppTemplate(
    agentPhone,
    templateName,
    variables,
    config.wa_phone_number_id!,
    config.wa_access_token!
  )
  if (!result.success) {
    logger.error('sendTemplateToAgent: template send failed', { templateName, error: result.error })
  }
}

// ─── HANDLE AGENT REPLY ──────────────────────────────────────
export async function handleAgentReply({
  senderPhone,
  message,
  clientId,
}: {
  senderPhone: string
  message: string
  clientId: string
}): Promise<void> {
  logger.info('Agent reply received', { clientId, preview: message.slice(0, 60) })

  const normMsg = message.trim().toUpperCase()

  // ── APPROVE flow ─────────────────────────────────────────────
  if (normMsg === 'APPROVE') {
    const res = await db.query(
      `SELECT * FROM contacts
       WHERE client_id = $1
         AND 'awaiting_faq_approval' = ANY(tags)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [clientId]
    )

    if (res.rows.length === 0) {
      logger.info('APPROVE received but no pending FAQ approval found', { clientId })
      return
    }

    const contact = res.rows[0]

    // Insert as a knowledge fact into the FAQ section — before the test deployment marker if present.
    // Plain fact format so the AI applies it to any phrasing, not just the exact question asked.
    const promptPath = path.join(process.cwd(), 'prompts', 'conversation.txt')
    const current = await fs.readFile(promptPath, 'utf-8')
    const faqEntry = `\n${contact.pending_answer} (Applies when leads ask about: ${contact.pending_question})`
    const markerIndex = current.indexOf('\n# Test deployment marker')
    let updated: string
    if (markerIndex !== -1) {
      updated = current.slice(0, markerIndex) + faqEntry + current.slice(markerIndex)
    } else {
      updated = current + faqEntry
    }
    await fs.writeFile(promptPath, updated, 'utf-8')

    // Clear state
    await db.query(
      `UPDATE contacts SET pending_question = NULL, pending_answer = NULL WHERE id = $1`,
      [contact.id]
    )
    await db.query(
      `UPDATE contacts SET tags = array_remove(tags, 'awaiting_faq_approval') WHERE id = $1`,
      [contact.id]
    )

    // Confirm to agent
    const clientRes = await db.query(`SELECT * FROM clients WHERE id = $1`, [clientId])
    const config = clientRes.rows[0]
    await sendToAgent(senderPhone, `✅ FAQ updated. I'll answer that question automatically next time.`, config)

    logger.info('FAQ updated from agent APPROVE', { contactId: contact.id, question: contact.pending_question })
    return
  }

  // ── Answer flow ───────────────────────────────────────────────
  const res = await db.query(
    `SELECT * FROM contacts
     WHERE client_id = $1
       AND 'awaiting_agent_answer' = ANY(tags)
     ORDER BY updated_at DESC
     LIMIT 1`,
    [clientId]
  )

  if (res.rows.length === 0) {
    logger.info('Agent reply received but no awaiting_agent_answer contact found', { clientId, senderPhone })
    return
  }

  const contact = res.rows[0]
  const clientRes = await db.query(`SELECT * FROM clients WHERE id = $1`, [clientId])
  const config = clientRes.rows[0]

  // Forward answer to lead
  await sendToLead(contact, message, config)

  // Save answer + swap tags
  await db.query(
    `UPDATE contacts SET pending_answer = $1 WHERE id = $2`,
    [message, contact.id]
  )
  await db.query(
    `UPDATE contacts SET
       tags = array_append(array_remove(tags, 'awaiting_agent_answer'), 'awaiting_faq_approval')
     WHERE id = $1`,
    [contact.id]
  )

  // Prompt agent for FAQ approval
  const approvePrompt = `📝 Add to FAQ? Reply APPROVE to save:\n\nQ: ${contact.pending_question}\nA: ${message}`
  await sendToAgent(senderPhone, approvePrompt, config)

  logger.info('Agent answer forwarded to lead', { contactId: contact.id })
}

// ─── INTERNAL HELPERS ─────────────────────────────────────────

async function sendToLead(contact: any, message: string, config: any): Promise<void> {
  const channel = contact.channel || config.channel
  if (channel === 'whatsapp') {
    await sendWhatsAppMessage(
      contact.phone_number,
      message,
      config.wa_phone_number_id!,
      config.wa_access_token!
    )
  } else if (channel === 'sms') {
    await sendSmsMessage(
      contact.phone_number,
      message,
      config.sms_account_sid!,
      config.sms_auth_token!,
      config.sms_from_number!
    )
  } else {
    logger.warn('sendToLead: unknown channel', { channel, contactId: contact.id })
  }
}

async function sendToAgent(agentPhone: string, message: string, config: any): Promise<void> {
  try {
    await sendWhatsAppMessage(
      agentPhone,
      message,
      config.wa_phone_number_id!,
      config.wa_access_token!
    )
  } catch (err: any) {
    logger.error('sendToAgent: failed to send', { agentPhone, error: err.message })
  }
}
