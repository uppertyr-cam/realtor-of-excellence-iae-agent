import 'dotenv/config'
import express from 'express'
import { handleCrmWebhook, forceSendContact } from './workflows/outbound-first-message'
import { sendWeeklyReport } from './reports/weekly-report'
import { updateDashboard } from './reports/dashboard'
import { handleInboundMessage } from './workflows/inbound-reply-handler'
import { startScheduler } from './queue/scheduler'
import { logger } from './utils/logger'
import crypto from 'crypto'

const app = express()
const PORT = process.env.PORT || 3000

// ─── MIDDLEWARE ───────────────────────────────────────────────
// Capture raw body for Meta signature verification
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf.toString() }
}))
app.use(express.urlencoded({ extended: true }))

// Request logger
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip })
  next()
})

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ════════════════════════════════════════════════════════════
// WORKFLOW 00 ENTRY — CRM Webhook
// Any CRM POSTs here to start the reactivation sequence
// POST /webhook/crm
// Expected body: { contact_id, phone_number, first_name,
//                  client_id, crm_type, crm_callback_url, ...}
// ════════════════════════════════════════════════════════════
app.post('/webhook/crm', async (req, res) => {
  try {
    // Validate internal secret so only authorised CRMs can trigger
    const secret = req.headers['x-iae-secret']
    if (secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
      logger.warn('Unauthorised CRM webhook attempt', { ip: req.ip })
      return res.status(401).json({ error: 'Unauthorised' })
    }

    const { crm_type, ...payload } = req.body

    if (!payload.contact_id || !payload.phone_number || !payload.client_id) {
      return res.status(400).json({
        error: 'Missing required fields: contact_id, phone_number, client_id',
      })
    }

    // Respond immediately — process async so CRM doesn't time out
    res.json({ received: true, contact_id: payload.contact_id })

    // Run Workflow 00 in background
    handleCrmWebhook(payload, crm_type || 'generic').catch((err) => {
      logger.error('Workflow 00 error', { error: err.message, contact_id: payload.contact_id })
    })

  } catch (err: any) {
    logger.error('CRM webhook handler error', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════════
// WORKFLOW 01 ENTRY — Inbound WhatsApp Message
// Meta calls this when a contact replies on WhatsApp
// GET  /webhook/whatsapp  — Meta verification challenge
// POST /webhook/whatsapp  — Inbound message
// ════════════════════════════════════════════════════════════

// Meta webhook verification (required for WhatsApp Business API setup)
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    logger.info('Meta webhook verified')
    return res.status(200).send(challenge)
  }
  res.status(403).send('Forbidden')
})

// Inbound WhatsApp message
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    // Verify Meta signature against raw body
    const signature = req.headers['x-hub-signature-256'] as string
    if (!verifyMetaSignature((req as any).rawBody || JSON.stringify(req.body), signature)) {
      logger.warn('Invalid Meta signature')
      return res.status(401).json({ error: 'Invalid signature' })
    }

    // Meta expects 200 immediately
    res.status(200).json({ received: true })

    // Parse Meta webhook payload
    const entry = req.body?.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value

    // Handle delivery/read status callbacks
    if (value?.statuses?.length && !value?.messages?.length) {
      const status = value.statuses[0]
      const recipientPhone: string = status.recipient_id || ''
      const deliveryStatus: string = status.status || ''
      if (recipientPhone && ['sent', 'delivered', 'read', 'failed'].includes(deliveryStatus)) {
        const { db: statusDb } = await import('./db/client')
        statusDb.query(
          `UPDATE contacts SET
             last_delivery_status=$1,
             last_read_at=CASE WHEN $1='read' THEN NOW() ELSE last_read_at END,
             updated_at=NOW()
           WHERE phone_number LIKE $2`,
          [deliveryStatus, `%${recipientPhone}%`]
        ).catch(() => {})
      }
      return
    }

    if (!value?.messages?.length) return // Not a message event

    const msg = value.messages[0]
    const contact = value.contacts?.[0]

    const phone = msg.from               // E.164 format e.g. "61412345678"
    const waId = msg.id

    // Look up contact_id by phone number in our DB (get full contact row)
    const { db } = await import('./db/client')
    const { getClientConfig } = await import('./config/client-config')
    const { notifyStageAgent } = await import('./workflows/inbound-reply-handler')
    const { downloadWhatsAppAudio, transcribeAudio } = await import('./channels/transcription')

    // Agent detection — only intercept if this number is a registered agent AND
    // either there's a contact waiting for an answer, or the message is "APPROVE".
    // This allows the same number to act as both lead and agent in tests.
    if (msg.type === 'text') {
      const earlyText = msg.text?.body || ''
      const isApprove = earlyText.trim().toUpperCase() === 'APPROVE'
      if (earlyText) {
        const agentCheck = await db.query(
          `SELECT c.id FROM clients c
           WHERE EXISTS (
             SELECT 1 FROM jsonb_each(COALESCE(c.stage_agents, '{}'::jsonb)) kv
             WHERE kv.value->>'target' = $1
           )
           AND (
             $2
             OR EXISTS (
               SELECT 1 FROM contacts ct
               WHERE ct.client_id = c.id
                 AND (
                   'awaiting_agent_answer' = ANY(ct.tags)
                   OR 'awaiting_faq_approval' = ANY(ct.tags)
                 )
             )
           )
           LIMIT 1`,
          [phone.replace(/^\+/, ''), isApprove]
        )
        if (agentCheck.rows.length > 0) {
          const { handleAgentReply } = await import('./workflows/agent-reply-handler')
          await handleAgentReply({ senderPhone: phone, message: earlyText, clientId: agentCheck.rows[0].id })
          return
        }
      }
    }

    const contactRes = await db.query(
      `SELECT * FROM contacts WHERE phone_number LIKE $1 LIMIT 1`,
      [`%${phone.replace(/^\+/, '')}%`]
    )

    if (contactRes.rowCount === 0) {
      logger.warn('Inbound WhatsApp from unknown number', { phone })
      return
    }

    const contactRow = contactRes.rows[0]
    const contactId = contactRow.id
    const config = await getClientConfig(contactRow.client_id)

    // Handle audio messages (voice notes)
    if (msg.type === 'audio') {
      try {
        logger.info('Voice note received', { contactId, mediaId: msg.audio?.id })

        const { buffer, mimeType } = await downloadWhatsAppAudio(
          msg.audio.id,
          config.wa_phone_number_id!,
          config.wa_access_token!
        )

        const transcribedText = await transcribeAudio(buffer, mimeType, config.openai_api_key!)
        const messageWithPrefix = `[Voice note]: ${transcribedText}`

        logger.info('Voice note transcribed successfully', { contactId, length: transcribedText.length })

        // Trigger Workflow 01 with transcribed text
        await handleInboundMessage({
          contact_id:   contactId,
          message:      messageWithPrefix,
          channel:      'whatsapp',
          phone_number: phone,
        })
      } catch (err: any) {
        logger.error('Voice note transcription failed', { contactId, error: err.message })

        // Notify the appropriate agent
        await notifyStageAgent(
          contactRow,
          config,
          `⚠️ Voice note from ${contactRow.first_name || phone} could not be transcribed.\n\nContact: ${phone}\nStage: ${contactRow.workflow_stage}\n\nPlease reply manually.`
        )
      }
      return
    }

    // Handle text messages
    if (msg.type !== 'text') {
      logger.info('Non-text WhatsApp message ignored', { type: msg.type })
      return
    }

    const messageText = msg.text?.body || ''
    if (!messageText) return

    logger.info('WhatsApp message received', { from: phone, preview: messageText.slice(0, 50) })

    // Trigger Workflow 01
    await handleInboundMessage({
      contact_id:   contactId,
      message:      messageText,
      channel:      'whatsapp',
      phone_number: phone,
    })

  } catch (err: any) {
    logger.error('WhatsApp webhook handler error', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════════
// WORKFLOW 01 ENTRY — Inbound SMS Message
// Twilio calls this when a contact replies via SMS
// POST /webhook/sms
// ════════════════════════════════════════════════════════════
app.post('/webhook/sms', async (req, res) => {
  try {
    // Verify Twilio signature
    const twilioSignature = req.headers['x-twilio-signature'] as string
    if (!verifyTwilioSignature(req)) {
      logger.warn('Invalid Twilio signature')
      return res.status(401).send('Unauthorised')
    }

    // Twilio sends form-encoded data
    const from    = req.body.From    // e.g. "+61412345678"
    const body    = req.body.Body    // message text
    const smsSid  = req.body.SmsSid

    if (!from || !body) {
      return res.status(400).send('Missing From or Body')
    }

    // Respond immediately with empty TwiML
    res.set('Content-Type', 'text/xml')
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')

    logger.info('SMS received', { from, preview: body.slice(0, 50) })

    // Look up contact
    const { db } = await import('./db/client')
    const contactRes = await db.query(
      `SELECT id FROM contacts WHERE phone_number LIKE $1 LIMIT 1`,
      [`%${from.replace(/\D/g, '')}%`]
    )

    if (contactRes.rowCount === 0) {
      logger.warn('Inbound SMS from unknown number', { from })
      return
    }

    const contactId = contactRes.rows[0].id

    // Trigger Workflow 01
    await handleInboundMessage({
      contact_id:   contactId,
      message:      body,
      channel:      'sms',
      phone_number: from,
    })

  } catch (err: any) {
    logger.error('SMS webhook handler error', { error: err.message })
    res.status(500).send('Internal server error')
  }
})

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES — Client management
// ════════════════════════════════════════════════════════════

// Get all clients
app.get('/admin/clients', requireAdminSecret, async (_req, res) => {
  const { db } = await import('./db/client')
  const result = await db.query('SELECT id, name, channel, timezone, created_at FROM clients ORDER BY created_at DESC')
  res.json(result.rows)
})

// Create or update a client
app.post('/admin/clients', requireAdminSecret, async (req, res) => {
  const { db } = await import('./db/client')
  const c = req.body
  try {
    // Check if client exists
    const existing = await db.query('SELECT id FROM clients WHERE id = $1', [c.id])

    if (existing.rows.length > 0) {
      // Update only provided fields
      const updates: string[] = []
      const params: any[] = [c.id]
      let paramIndex = 2

      if (c.name !== undefined) { updates.push(`name = $${paramIndex++}`); params.push(c.name) }
      if (c.openai_api_key !== undefined) { updates.push(`openai_api_key = $${paramIndex++}`); params.push(c.openai_api_key) }
      if (c.stage_agents !== undefined) { updates.push(`stage_agents = $${paramIndex++}`); params.push(JSON.stringify(c.stage_agents)) }
      if (c.wa_access_token !== undefined) { updates.push(`wa_access_token = $${paramIndex++}`); params.push(c.wa_access_token) }
      if (c.wa_phone_number_id !== undefined) { updates.push(`wa_phone_number_id = $${paramIndex++}`); params.push(c.wa_phone_number_id) }
      if (c.crm_type !== undefined) { updates.push(`crm_type = $${paramIndex++}`); params.push(c.crm_type) }
      if (c.crm_api_key !== undefined) { updates.push(`crm_api_key = $${paramIndex++}`); params.push(c.crm_api_key) }

      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`)
        await db.query(`UPDATE clients SET ${updates.join(', ')} WHERE id = $1`, params)
      }
    } else {
      // Insert with defaults
      await db.query(
        `INSERT INTO clients (
           id, name, timezone, working_hours_start, working_hours_end,
           working_days, channel, daily_send_limit, send_interval_minutes,
           first_message_template, followup1_message_template, followup2_message_template, followup3_message_template,
           bump_templates, reach_back_out_message_template,
           wa_phone_number_id, wa_access_token,
           openai_api_key, stage_agents
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
         )`,
        [
          c.id,
          c.name || c.id,
          c.timezone || 'UTC',
          c.working_hours_start || '09:00',
          c.working_hours_end || '17:00',
          c.working_days || ['Mon','Tue','Wed','Thu','Fri'],
          c.channel || 'whatsapp',
          c.daily_send_limit || 50,
          c.send_interval_minutes || 10,
          c.first_message_template || 'Hi {{first_name}}, ...',
          c.followup1_message_template || 'Hi {{first_name}}, just following up...',
          c.followup2_message_template || 'Hi {{first_name}}, checking in again...',
          c.followup3_message_template || 'Hi {{first_name}}, last time reaching out...',
          c.bump_templates || null,
          c.reach_back_out_message_template || 'Hi {{first_name}}, just checking in as you had asked us to reach back out today. Are you still looking at getting into the property market?',
          c.wa_phone_number_id || null,
          c.wa_access_token || null,
          c.openai_api_key || null,
          c.stage_agents || {}
        ]
      )
    }
    res.json({ success: true, client_id: c.id })
  } catch (err: any) {
    logger.error('Admin clients error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// Get contact status
app.get('/admin/contacts/:id', requireAdminSecret, async (req, res) => {
  const { db } = await import('./db/client')
  const result = await db.query(
    `SELECT id, phone_number, first_name, workflow_stage, tags,
            loop_counter, first_message_at, last_reply_at, channel
     FROM contacts WHERE id=$1`,
    [req.params.id]
  )
  if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
  res.json(result.rows[0])
})

// Force-send first message for a contact (bypasses working hours / rate limits)
app.post('/admin/contacts/:id/force-send', requireAdminSecret, async (req, res) => {
  try {
    await forceSendContact(req.params.id)
    res.json({ success: true, contact_id: req.params.id })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

// Force-trigger a follow-up immediately (bypasses scheduled time)
// :type = followup1 | followup2 | followup3 | bump
app.post('/admin/contacts/:id/force-followup/:type', requireAdminSecret, async (req, res) => {
  const { db } = await import('./db/client')
  const valid = ['followup1', 'followup2', 'followup3', 'bump']
  if (!valid.includes(req.params.type)) {
    return res.status(400).json({ error: `type must be one of: ${valid.join(', ')}` })
  }
  const result = await db.query(
    `UPDATE outbound_queue SET scheduled_at=NOW(), status='pending'
     WHERE contact_id=$1 AND message_type=$2
     RETURNING id`,
    [req.params.id, req.params.type]
  )
  if (result.rowCount === 0) return res.status(404).json({ error: 'No matching queued job found' })
  res.json({ success: true, contact_id: req.params.id, type: req.params.type, note: 'Scheduler will send within 60s' })
})

// Manually trigger the weekly report email
app.post('/admin/report/send', requireAdminSecret, async (_req, res) => {
  try {
    await sendWeeklyReport()
    res.json({ success: true, message: 'Report sent' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Manually refresh the live dashboard for a client
app.post('/admin/dashboard/refresh/:clientId', requireAdminSecret, async (req, res) => {
  try {
    await updateDashboard(req.params.clientId)
    res.json({ success: true, message: 'Dashboard refreshed' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Reset a contact's loop counter manually
app.post('/admin/contacts/:id/reset-loop', requireAdminSecret, async (req, res) => {
  const { db } = await import('./db/client')
  const result = await db.query(
    `UPDATE contacts SET loop_counter=0, loop_counter_reset_at=NOW() WHERE id=$1 RETURNING id`,
    [req.params.id]
  )
  if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true, contact_id: req.params.id })
})

// ─── HELPERS ─────────────────────────────────────────────────
function verifyMetaSignature(payload: string, signature: string): boolean {
  if (!process.env.META_APP_SECRET || !signature) return false
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(payload)
    .digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

function verifyTwilioSignature(req: express.Request): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN || ''
  const signature = (req.headers['x-twilio-signature'] as string) || ''
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  const params = (req.body as Record<string, string>) || {}
  const stringToSign = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url)
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(stringToSign, 'utf8')).digest('base64')
  if (!signature) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

function requireAdminSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const secret = req.headers['x-iae-secret']
  if (secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  next()
}

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`IAE Agent running on port ${PORT}`)
  startScheduler()
})

export default app
