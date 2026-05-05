// ============================================================
// Outbound First Message
// Instant Appointment Engine — Outbound First Message
//
// Entry: POST /webhook/crm  (from any CRM)
// Handles: normalise → queue → send → fallback
// ============================================================

import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { normalizeWebhook } from '../crm/normalizer'
import { writeToCrm } from '../crm/adapter'
import { sendWhatsAppMessage, sendWhatsAppTemplate } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'
import { isWithinWorkingHours } from '../utils/working-hours'
import { logger } from '../utils/logger'
import { alertEmail, noNumberEmail } from '../utils/alert'
import { updateDashboard } from '../reports/dashboard'
import { updateMetrics } from '../reports/weekly-report'
import { getWhatsAppMarketingTemplateCostUsd } from '../config/pricing'
import { publishInboxEvent } from '../inbox/live-events'
import type { Contact, InboundWebhook, SendResult } from '../utils/types'
import axios from 'axios'


// ─── ENTRY POINT ─────────────────────────────────────────────
export async function handleCrmWebhook(rawPayload: any, crmType: string) {
  logger.info('Outbound First Message triggered', { crmType })

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
    `SELECT id, workflow_stage, phone_number, tags FROM contacts WHERE id = $1`,
    [webhook.contact_id]
  )
  if (existing.rowCount! > 0) {
    const row = existing.rows[0]
    const stage = row.workflow_stage

    // Non-WhatsApp gate: only allow re-entry if phone number has changed
    if (row.tags?.includes('non_whatsapp_number')) {
      if (row.phone_number === webhook.phone_number) {
        logger.info('CRM webhook rejected — same non-WhatsApp number', { contact_id: webhook.contact_id })
        return
      }
      logger.info('CRM webhook re-entry — new number detected, clearing non_whatsapp_number', { contact_id: webhook.contact_id })
      // Falls through to upsert which strips the tag
    } else if (stage !== 'pending' && stage !== 'closed') {
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
       phone_number, first_name, last_name, email, workflow_stage,
       webhook_received_at, assigned_to, tags
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW(),$9,ARRAY['ai_database_reactivation'])
     ON CONFLICT (id) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       crm_source = EXCLUDED.crm_source,
       crm_callback_url = EXCLUDED.crm_callback_url,
       phone_number = EXCLUDED.phone_number,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       email = EXCLUDED.email,
       workflow_stage = 'pending',
       assigned_to = EXCLUDED.assigned_to,
       tags = ARRAY(SELECT DISTINCT UNNEST(array_remove(contacts.tags, 'non_whatsapp_number') || ARRAY['ai_database_reactivation'])),
       updated_at = NOW()`,
    [
      webhook.contact_id, webhook.client_id, webhook.crm_type,
      webhook.crm_callback_url, webhook.phone_number,
      webhook.first_name, webhook.last_name, webhook.email,
      webhook.assigned_to || null,
    ]
  )

  // ── Step 5: Channel decision ────────────────────────────────
  const channel = config.channel

  // ── Step 6: Channel selection ───────────────────────────────
  if (channel === 'whatsapp' || channel === 'whatsapp_sms_fallback') {
    if (!config.wa_phone_number_id || !config.wa_access_token) {
      logger.error('WhatsApp credentials missing', { client_id: config.id })
      return
    }
    await db.query(`UPDATE contacts SET channel='whatsapp' WHERE id=$1`, [webhook.contact_id])
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
    `SELECT DISTINCT client_id FROM outbound_queue WHERE status='pending' AND scheduled_at <= NOW() AND message_type='first_message'`
  )

  for (const row of clientsRes.rows) {
    try {
      const config = await getClientConfig(row.client_id)

      // ── Test contact pre-pass (bypass all rate limits) ──────
      if (config.test_phone_numbers?.length) {
        const testJobRes = await db.query(
          `UPDATE outbound_queue SET status='processing'
           WHERE id = (
             SELECT oq.id FROM outbound_queue oq
             JOIN contacts c ON c.id = oq.contact_id
             WHERE oq.client_id=$1 AND oq.status='pending' AND oq.scheduled_at<=NOW()
               AND oq.message_type='first_message'
               AND c.phone_number = ANY($2)
             ORDER BY oq.created_at ASC LIMIT 1
             FOR UPDATE SKIP LOCKED
           ) RETURNING *`,
          [config.id, config.test_phone_numbers]
        )
        if (testJobRes.rowCount! > 0) {
          await sendFirstMessage(testJobRes.rows[0], config)
          continue
        }
      }

      // ── Working hours check ─────────────────────────────────
      if (!isWithinWorkingHours(config)) continue

      // ── Daily limit + interval check (DB-persisted) ─────────
      const today = new Date().toISOString().split('T')[0]
      const rateRes = await db.query(
        `SELECT daily_send_count, daily_send_date, last_sent_at FROM clients WHERE id=$1`,
        [config.id]
      )
      const rate = rateRes.rows[0]
      const todayCount = rate.daily_send_date && new Date(rate.daily_send_date).toISOString().split('T')[0] === today
        ? rate.daily_send_count : 0
      if (todayCount >= config.daily_send_limit) continue
      const intervalMs = config.send_interval_minutes * 60_000
      const lastMs = rate.last_sent_at ? new Date(rate.last_sent_at).getTime() : 0
      if (Date.now() - lastMs < intervalMs) continue

      // ── Get next contact in queue ───────────────────────────
      const queueRes = await db.query(
        `UPDATE outbound_queue SET status='processing'
         WHERE id = (
           SELECT id FROM outbound_queue
           WHERE client_id=$1 AND status='pending' AND scheduled_at<=NOW() AND message_type='first_message'
           ORDER BY created_at ASC LIMIT 1
           FOR UPDATE SKIP LOCKED
         ) RETURNING *`,
        [config.id]
      )
      if (queueRes.rowCount === 0) continue

      const job = queueRes.rows[0]
      await sendFirstMessage(job, config)

      // Persist rate limit counters to DB
      await db.query(
        `UPDATE clients SET
           daily_send_count = CASE WHEN daily_send_date = CURRENT_DATE THEN daily_send_count + 1 ELSE 1 END,
           daily_send_date = CURRENT_DATE,
           last_sent_at = NOW()
         WHERE id=$1`,
        [config.id]
      )
    } catch (err: any) {
      logger.error('processDripQueue client error', { client_id: row.client_id, error: err.message })
      alertEmail('processDripQueue client error', { client_id: row.client_id, error: err.message })
    }
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

  // Build personalised message — use only the first word of first_name
  const firstName = (contact.first_name || '').split(' ')[0]
  const message = config.first_message_template
    .replace(/{{first_name}}/g, firstName)
    .replace(/{{last_name}}/g, contact.last_name || '')
    .replace(/{{phone_number}}/g, contact.phone_number)

  // Send via correct channel
  const channel = contact.channel || config.channel
  const originalPhone = contact.phone_number
  let targetPhone = contact.phone_number
  let deliveryChannel: 'whatsapp' | 'sms' = channel === 'sms' ? 'sms' : 'whatsapp'
  let result: SendResult

  if (channel === 'whatsapp' && config.wa_first_message_template_name) {
    result = await sendWithRetry(() =>
      sendWhatsAppTemplate(
        targetPhone,
        config.wa_first_message_template_name!,
        [contact.first_name || '', config.agent_name || ''],
        config.wa_phone_number_id!,
        config.wa_access_token!
      )
    )
  } else if (channel === 'whatsapp') {
    result = await sendWithRetry(() =>
      sendWhatsAppMessage(
        targetPhone, message,
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

  if (!result.success && channel === 'whatsapp') {
    const fallback = await tryAlternateFollowUpBossNumbers(contact, config, message)
    if (fallback) {
      targetPhone = fallback.phoneNumber
      result = fallback.result

      await db.query(
        `UPDATE contacts SET phone_number=$1, updated_at=NOW() WHERE id=$2`,
        [targetPhone, contact.id]
      )

      await writeToCrm(
        {
          contact_id: contact.id,
          note: `Cameron AI System: Primary WhatsApp number failed for first message. Switched to alternate Follow Up Boss number ${targetPhone}.`,
        },
        config,
        contact.crm_callback_url
      )
    }
  }

  if (!result.success && channel === 'whatsapp' && config.channel === 'whatsapp_sms_fallback') {
    if (!config.sms_account_sid || !config.sms_auth_token || !config.sms_from_number) {
      logger.error('WhatsApp failed but SMS credentials are not configured — cannot fall back', {
        contact_id: contact.id,
      })
      result = { success: false, error: 'SMS credentials not configured' }
    } else {
    logger.warn('WhatsApp send failed — falling back to SMS', {
      contact_id: contact.id,
      phone_number: originalPhone,
      error: result.error,
    })

    const smsResult = await sendWithRetry(() =>
      sendSmsMessage(
        originalPhone,
        message,
        config.sms_account_sid!,
        config.sms_auth_token!,
        config.sms_from_number!
      )
    )

    if (smsResult.success) {
      result = smsResult
      deliveryChannel = 'sms'
      await db.query(
        `UPDATE contacts
         SET channel='sms',
             tags=ARRAY(SELECT DISTINCT UNNEST(tags || ARRAY['non_whatsapp_number'])),
             updated_at=NOW()
         WHERE id=$1`,
        [contact.id]
      )
      await writeToCrm(
        {
          contact_id: contact.id,
          tags_add: ['non_whatsapp_number'],
          note: `Outbound First Message: WhatsApp delivery failed on all available numbers, so the first message was sent via SMS instead.`,
        },
        config,
        contact.crm_callback_url
      )
    }
    } // end else (SMS credentials present)
  }

  if (!result.success) {
    logger.error('First message send failed after retries', { contact_id: contact.id })
    alertEmail('First message failed', { contact_id: contact.id })
    await db.query(
      `UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`,
      [result.error, job.id]
    )

    const exhaustedFollowUpBossNumbers = channel === 'whatsapp' && isFollowUpBossContact(contact)
    const failedTags = exhaustedFollowUpBossNumbers
      ? ['send_failed', 'non_whatsapp_number']
      : ['send_failed']

    await db.query(
      `UPDATE contacts
       SET workflow_stage='closed',
           tags=ARRAY(SELECT DISTINCT UNNEST(tags || $2::text[]))
       WHERE id=$1`,
      [contact.id, failedTags]
    )
    await writeToCrm(
      {
        contact_id: contact.id,
        tags_add: failedTags,
        note: exhaustedFollowUpBossNumbers
          ? `IAE: First message failed on all Follow Up Boss WhatsApp numbers — ${result.error}`
          : `IAE: First message failed — ${result.error}`,
      },
      config,
      contact.crm_callback_url
    )

    // Notify Charmaine with styled email
    const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.phone_number
    noNumberEmail({ name: contactName, phone: contact.phone_number, id: contact.id })
    return
  }

  // ── Post-send updates ─────────────────────────────────────
  const now = new Date()
  const firstMessageTemplateCostUsd =
    deliveryChannel === 'whatsapp' && !!config.wa_first_message_template_name
      ? getWhatsAppMarketingTemplateCostUsd(config)
      : 0
  await db.query(
    `UPDATE contacts SET
       workflow_stage='active',
       tags=ARRAY(
         SELECT DISTINCT UNNEST(tags || ARRAY['first_message_sent', 'database_reactivation', 'ai_database_reactivation'])
       ),
       first_message_sent=$1,
       first_message_at=$2,
       ai_memory=$4,
       total_cost_usd=total_cost_usd+$5,
       updated_at=NOW()
     WHERE id=$3`,
    [message, now, contact.id, `AI: ${message}`, firstMessageTemplateCostUsd]
  )

  await db.query(
    `UPDATE outbound_queue SET status='sent', sent_at=NOW() WHERE id=$1`,
    [job.id]
  )

  // Log to message_log
  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type, wa_message_id)
     VALUES ($1,$2,'outbound',$3,$4,'first_message',$5)`,
    [contact.id, config.id, deliveryChannel, message, result.message_id || null]
  )
  publishInboxEvent({
    type: 'message_created',
    contactId: contact.id,
    clientId: config.id,
    timestamp: new Date().toISOString(),
  })

  // ── CRM Callback ──────────────────────────────────────────
  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: ['first_message_sent', 'database_reactivation', 'ai_database_reactivation', 'follow_ups_scheduled'],
      note: `Outbound First Message: First message sent via ${deliveryChannel}.\n\nMessage: ${message}\n\nTimestamp: ${now.toISOString()}\nCRM Source: ${contact.crm_source}`,
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
    contact_id: contact.id, channel: deliveryChannel, message_id: result.message_id,
  })

  updateDashboard(contact.client_id).catch(() => {})
  updateMetrics(contact.client_id).catch(() => {})
}

function isFollowUpBossContact(contact: Contact): boolean {
  const source = (contact.crm_source || '').toLowerCase()
  return source === 'followupboss' || source === 'fub'
}

async function tryAlternateFollowUpBossNumbers(
  contact: Contact,
  config: any,
  message: string
): Promise<{ phoneNumber: string; result: SendResult } | null> {
  if (!isFollowUpBossContact(contact) || !config.crm_api_key) {
    return null
  }

  const base = config.crm_base_url || 'https://api.followupboss.com/v1'
  const auth = { username: config.crm_api_key, password: '' }

  try {
    let response
    try {
      response = await axios.get(`${base}/people/${contact.id}`, { auth, timeout: 15_000 })
    } catch {
      await new Promise((r) => setTimeout(r, 2_000))
      response = await axios.get(`${base}/people/${contact.id}`, { auth, timeout: 15_000 })
    }
    const alternateNumbers = ((response.data?.phones || []) as Array<{ value?: string }>)
      .map((phone) => phone.value?.trim())
      .filter((phone): phone is string => !!phone && phone !== contact.phone_number)

    for (const phoneNumber of [...new Set(alternateNumbers)]) {
      logger.info('Trying alternate Follow Up Boss number after WhatsApp send failure', {
        contact_id: contact.id,
        phone_number: phoneNumber,
      })

      const send = config.wa_first_message_template_name
        ? () => sendWhatsAppTemplate(
            phoneNumber,
            config.wa_first_message_template_name!,
            [contact.first_name || '', config.agent_name || ''],
            config.wa_phone_number_id!,
            config.wa_access_token!
          )
        : () => sendWhatsAppMessage(
            phoneNumber,
            message,
            config.wa_phone_number_id!,
            config.wa_access_token!
          )

      const result = await sendWithRetry(send)
      if (result.success) {
        return { phoneNumber, result }
      }
    }
  } catch (err: any) {
    logger.warn('Could not fetch alternate Follow Up Boss numbers', {
      contact_id: contact.id,
      error: err.message,
    })
  }

  return null
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
