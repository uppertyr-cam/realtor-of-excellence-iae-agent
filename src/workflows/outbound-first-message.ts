// ============================================================
// WORKFLOW 00 — Conversational Starter
// Instant Appointment Engine — 00 — Conversational Starter
//
// Entry: POST /webhook/crm  (from any CRM)
// Handles: normalise → validate → hours → drip queue → send
// ============================================================

import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { normalizeWebhook } from '../crm/normalizer'
import { writeToCrm } from '../crm/adapter'
import { validateWhatsAppNumber, sendWhatsAppMessage, sendWhatsAppTemplate } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'
import { isWithinWorkingHours } from '../utils/working-hours'
import { logger } from '../utils/logger'
import type { Contact, InboundWebhook, SendResult } from '../utils/types'

// ─── DRIP STATE ──────────────────────────────────────────────
// Per-client daily counters stored in memory
// (for production: move to Redis or Postgres)
const dailyCounts = new Map<string, { count: number; date: string }>()
const lastSentAt = new Map<string, number>() // client_id → timestamp

// ─── ENTRY POINT ─────────────────────────────────────────────
export async function handleCrmWebhook(rawPayload: any, crmType: string) {
  logger.info('Workflow 00 triggered', { crmType })

  // ── Step 1: Normalise payload ───────────────────────────────
  let webhook: InboundWebhook
  try {
    webhook = normalizeWebhook(rawPayload, crmType)
  } catch (err: any) {
    logger.error('Webhook normalisation failed', { error: err.message })
    return
  }

  // ── Step 2: Load client config ──────────────────────────────
  const config = await getClientConfig(webhook.client_id)

  // ── Step 3: Duplicate check ─────────────────────────────────
  const existing = await db.query(
    `SELECT id, workflow_stage FROM contacts WHERE id = $1`,
    [webhook.contact_id]
  )
  if (existing.rowCount! > 0) {
    const stage = existing.rows[0].workflow_stage
    if (stage !== 'pending' && stage !== 'closed') {
      logger.warn('Duplicate webhook — contact already active', {
        contact_id: webhook.contact_id, stage,
      })
      return
    }
  }

  // ── Step 4: Upsert contact record ───────────────────────────
  await db.query(
    `INSERT INTO contacts (
       id, client_id, crm_source, crm_callback_url,
       phone_number, first_name, last_name, email, workflow_stage
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     ON CONFLICT (id) DO UPDATE SET
       crm_callback_url = EXCLUDED.crm_callback_url,
       workflow_stage = 'pending',
       updated_at = NOW()`,
    [
      webhook.contact_id, webhook.client_id, webhook.crm_type,
      webhook.crm_callback_url, webhook.phone_number,
      webhook.first_name, webhook.last_name, webhook.email,
    ]
  )

  // ── Step 5: Channel decision ────────────────────────────────
  const channel = config.channel

  // ── Step 6: WhatsApp validation ─────────────────────────────
  if (channel === 'whatsapp' || channel === 'whatsapp_sms_fallback') {
    if (!config.wa_phone_number_id || !config.wa_access_token) {
      logger.error('WhatsApp credentials missing', { client_id: config.id })
      return
    }

    // Try all numbers — use first one that is on WhatsApp
    const numbersToTry = webhook.phone_numbers?.length
      ? webhook.phone_numbers
      : [webhook.phone_number]

    let validNumber: string | null = null
    for (const num of numbersToTry) {
      const isValid = await validateWhatsAppNumber(num, config.wa_phone_number_id, config.wa_access_token)
      if (isValid) {
        validNumber = num
        break
      }
      logger.info('Number not on WhatsApp — trying next', { contact_id: webhook.contact_id, number: num })
    }

    if (!validNumber) {
      if (channel === 'whatsapp') {
        // Hard fail — tag and update CRM
        logger.info('No numbers on WhatsApp — tagging', { contact_id: webhook.contact_id })
        await db.query(
          `UPDATE contacts SET workflow_stage='closed', tags=array_append(tags,'non_whatsapp_number') WHERE id=$1`,
          [webhook.contact_id]
        )
        await writeToCrm(
          {
            contact_id: webhook.contact_id,
            tags_add: ['non_whatsapp_number'],
            note: `IAE: No numbers registered on WhatsApp. Tried: ${numbersToTry.join(', ')}. Webhook received from ${webhook.crm_type}.`,
          },
          config,
          webhook.crm_callback_url
        )
        return
      }
      // Fallback to SMS using original primary number
      logger.info('No numbers on WhatsApp — falling back to SMS', { contact_id: webhook.contact_id })
      await db.query(`UPDATE contacts SET channel='sms' WHERE id=$1`, [webhook.contact_id])
    } else {
      // If the winning number differs from the primary, update it on the contact
      if (validNumber !== webhook.phone_number) {
        logger.info('Switched to alternate WhatsApp number', { contact_id: webhook.contact_id, number: validNumber })
        await db.query(
          `UPDATE contacts SET phone_number=$1, channel='whatsapp' WHERE id=$2`,
          [validNumber, webhook.contact_id]
        )
        await writeToCrm(
          {
            contact_id: webhook.contact_id,
            note: `Cameron AI System: WhatsApp validation completed. The primary number on file (${webhook.phone_number}) is not registered on WhatsApp. The following number was used instead: ${validNumber}. All messages will be sent to this number going forward.`,
          },
          config,
          webhook.crm_callback_url
        )
      } else {
        await db.query(`UPDATE contacts SET channel='whatsapp' WHERE id=$1`, [webhook.contact_id])
      }
    }
  } else {
    await db.query(`UPDATE contacts SET channel='sms' WHERE id=$1`, [webhook.contact_id])
  }

  // ── Step 7: Add to drip queue ───────────────────────────────
  await db.query(
    `INSERT INTO outbound_queue (client_id, contact_id, message_type, status, scheduled_at)
     VALUES ($1, $2, 'first_message', 'pending', NOW())`,
    [config.id, webhook.contact_id]
  )

  logger.info('Contact queued for first message', { contact_id: webhook.contact_id })
}

// ─── DRIP QUEUE PROCESSOR ────────────────────────────────────
// Called by the scheduler every minute
export async function processDripQueue() {
  // Get all clients that have pending items
  const clientsRes = await db.query(
    `SELECT DISTINCT client_id FROM outbound_queue WHERE status='pending' AND scheduled_at <= NOW()`
  )

  for (const row of clientsRes.rows) {
    const config = await getClientConfig(row.client_id)

    // ── Working hours check ─────────────────────────────────
    if (!isWithinWorkingHours(config)) continue

    // ── Daily limit check ───────────────────────────────────
    const today = new Date().toISOString().split('T')[0]
    const daily = dailyCounts.get(config.id)
    if (daily?.date === today && daily.count >= config.daily_send_limit) continue

    // ── Interval check (1 per 10 min) ──────────────────────
    const last = lastSentAt.get(config.id) || 0
    const intervalMs = config.send_interval_minutes * 60_000
    if (Date.now() - last < intervalMs) continue

    // ── Get next contact in queue ───────────────────────────
    const queueRes = await db.query(
      `UPDATE outbound_queue SET status='processing'
       WHERE id = (
         SELECT id FROM outbound_queue
         WHERE client_id=$1 AND status='pending' AND scheduled_at<=NOW()
         ORDER BY created_at ASC LIMIT 1
         FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [config.id]
    )
    if (queueRes.rowCount === 0) continue

    const job = queueRes.rows[0]
    await sendFirstMessage(job, config)

    // Update counters
    const count = (daily?.date === today ? daily.count : 0) + 1
    dailyCounts.set(config.id, { count, date: today })
    lastSentAt.set(config.id, Date.now())
  }
}

// ─── FORCE SEND (bypasses working hours / rate limits) ───────
export async function forceSendContact(contactId: string) {
  const queueRes = await db.query(
    `UPDATE outbound_queue SET status='processing'
     WHERE id = (
       SELECT id FROM outbound_queue
       WHERE contact_id=$1 AND status='pending' AND message_type='first_message'
       ORDER BY created_at ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [contactId]
  )
  if (queueRes.rowCount === 0) {
    throw new Error('No pending first_message job found for this contact')
  }
  const job = queueRes.rows[0]
  const config = await getClientConfig(job.client_id)
  await sendFirstMessage(job, config)
}

// ─── SEND FIRST MESSAGE ──────────────────────────────────────
async function sendFirstMessage(job: any, config: any) {
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [job.contact_id])
  if (contactRes.rowCount === 0) return
  const contact: Contact = contactRes.rows[0]

  // Build personalised message
  const message = config.first_message_template
    .replace(/{{first_name}}/g, contact.first_name || '')
    .replace(/{{last_name}}/g, contact.last_name || '')
    .replace(/{{phone_number}}/g, contact.phone_number)

  // Send via correct channel
  const channel = contact.channel || config.channel
  let result: SendResult

  if (channel === 'whatsapp' && config.wa_first_message_template_name) {
    result = await sendWithRetry(() =>
      sendWhatsAppTemplate(
        contact.phone_number,
        config.wa_first_message_template_name!,
        [contact.first_name || '', contact.last_name || ''],
        config.wa_phone_number_id!,
        config.wa_access_token!
      )
    )
  } else if (channel === 'whatsapp') {
    result = await sendWithRetry(() =>
      sendWhatsAppMessage(
        contact.phone_number, message,
        config.wa_phone_number_id, config.wa_access_token
      )
    )
  } else {
    result = await sendWithRetry(() =>
      sendSmsMessage(
        contact.phone_number, message,
        config.sms_account_sid, config.sms_auth_token, config.sms_from_number
      )
    )
  }

  if (!result.success) {
    logger.error('First message send failed after retries', { contact_id: contact.id })
    await db.query(
      `UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`,
      [result.error, job.id]
    )
    await db.query(
      `UPDATE contacts SET workflow_stage='closed', tags=array_append(tags,'send_failed') WHERE id=$1`,
      [contact.id]
    )
    await writeToCrm({ contact_id: contact.id, tags_add: ['send_failed'], note: `IAE: First message failed — ${result.error}` }, config, contact.crm_callback_url)
    return
  }

  // ── Post-send updates ─────────────────────────────────────
  const now = new Date()
  await db.query(
    `UPDATE contacts SET
       workflow_stage='active',
       tags=array_append(array_append(tags,'first_message_sent'),'database_reactivation'),
       first_message_sent=$1,
       first_message_at=$2,
       ai_memory=$4,
       updated_at=NOW()
     WHERE id=$3`,
    [message, now, contact.id, `AI: ${message}`]
  )

  await db.query(
    `UPDATE outbound_queue SET status='sent', sent_at=NOW() WHERE id=$1`,
    [job.id]
  )

  // Log to message_log
  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type)
     VALUES ($1,$2,'outbound',$3,$4,'first_message')`,
    [contact.id, config.id, channel, message]
  )

  // ── CRM Callback ──────────────────────────────────────────
  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: ['first_message_sent', 'database_reactivation', 'follow_ups_scheduled'],
      note: `IAE: First message sent via ${channel}.\n\nMessage: ${message}\n\nTimestamp: ${now.toISOString()}\nCRM Source: ${contact.crm_source}`,
      fields: {
        first_message_sent: message,
        ai_memory: message,
      },
      opportunity: config.pipeline_id ? {
        pipeline_id: config.pipeline_id,
        stage_id: config.pipeline_stage_id,
        name: `IAE - ${contact.first_name} - Message Sent No Response`,
      } : undefined,
    },
    config,
    contact.crm_callback_url
  )

  // ── Schedule follow-ups at 7, 14, and 21 days ─────────────
  await db.query(
    `INSERT INTO outbound_queue (client_id, contact_id, message_type, status, scheduled_at)
     VALUES
       ($1,$2,'followup1','pending', NOW() + INTERVAL '7 days'),
       ($1,$2,'followup2','pending', NOW() + INTERVAL '14 days'),
       ($1,$2,'followup3','pending', NOW() + INTERVAL '21 days')`,
    [config.id, contact.id]
  )

  logger.info('First message sent + CRM updated', {
    contact_id: contact.id, channel, message_id: result.message_id,
  })
}

// ─── RETRY WRAPPER ───────────────────────────────────────────
async function sendWithRetry(fn: () => Promise<SendResult>, maxRetries = 3): Promise<SendResult> {
  for (let i = 1; i <= maxRetries; i++) {
    const result = await fn()
    if (result.success) return result
    if (i < maxRetries) await sleep(1000 * Math.pow(2, i - 1))
  }
  return { success: false, error: 'Max retries exceeded' }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
