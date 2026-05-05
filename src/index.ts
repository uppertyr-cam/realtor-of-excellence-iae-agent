import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import { handleCrmWebhook, forceSendContact } from './workflows/outbound-first-message'
import { sendWeeklyReport } from './reports/weekly-report'
import { updateDashboard } from './reports/dashboard'
import { handleInboundMessage } from './workflows/inbound-reply-handler'
import { startScheduler } from './queue/scheduler'
import { logger } from './utils/logger'
import crypto from 'crypto'
import { buildInboxHtml } from './inbox/ui'
import { createInboxUser, getInboxUserFromRequest, listInboxUsers, loginInboxUser, logoutInboxUser, requireInboxAuth, setInboxUserActive } from './inbox/auth'
import { getConversationCounts, getConversationDetail, listConversations } from './inbox/queries'
import { listEmailInbox } from './inbox/email-queries'
import { publishInboxEvent, subscribeInboxEvents } from './inbox/live-events'
import { approvePendingAiReply, assignConversation, sendManualReply, setAutomationPaused, setConversationResolved } from './inbox/actions'
import { alertEmail, noNumberEmail } from './utils/alert'
import { startTelegramBot } from './telegram/index'

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

app.get('/inbox', (_req, res) => {
  res.type('html').send(buildInboxHtml())
})

app.post('/inbox/api/login', async (req, res) => {
  try {
    const user = await loginInboxUser(req, String(req.body?.email || ''), String(req.body?.password || ''), res)
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    res.json({ user })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/inbox/api/logout', async (req, res) => {
  await logoutInboxUser(req, res)
  res.json({ success: true })
})

app.get('/inbox/api/me', async (req, res) => {
  const user = await getInboxUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Unauthorised' })
  res.json({ user })
})

app.get('/inbox/api/conversations', requireInboxAuth, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all'
  res.json({
    conversations: await listConversations(q, filter),
    counts: await getConversationCounts(q),
  })
})

app.get('/inbox/api/conversations/:contactId', requireInboxAuth, async (req, res) => {
  const detail = await getConversationDetail(req.params.contactId)
  if (!detail) return res.status(404).json({ error: 'Not found' })
  res.json(detail)
})

app.get('/inbox/api/emails', requireInboxAuth, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  res.json({ emails: await listEmailInbox(q) })
})

app.post('/inbox/api/conversations/:contactId/reply', requireInboxAuth, async (req, res) => {
  try {
    await sendManualReply(
      req.params.contactId,
      String(req.body?.message || ''),
      Boolean(req.body?.pauseAutomationAfterSend)
    )
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/inbox/api/conversations/:contactId/approve-ai', requireInboxAuth, async (req, res) => {
  try {
    const message = req.body?.message
    await approvePendingAiReply(
      req.params.contactId,
      typeof message === 'string' ? message : undefined
    )
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/inbox/api/conversations/:contactId/resolve', requireInboxAuth, async (req, res) => {
  try {
    await setConversationResolved(req.params.contactId)
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/inbox/api/conversations/:contactId/automation', requireInboxAuth, async (req, res) => {
  try {
    await setAutomationPaused(req.params.contactId, Boolean(req.body?.paused))
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/inbox/api/conversations/:contactId/assign', requireInboxAuth, async (req, res) => {
  try {
    const assignedTo = typeof req.body?.assignedTo === 'string' ? req.body.assignedTo : null
    await assignConversation(req.params.contactId, assignedTo)
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

// Fetch alternate phone numbers for a contact from FUB
app.get('/inbox/api/conversations/:contactId/phones', requireInboxAuth, async (req, res) => {
  try {
    const { db } = await import('./db/client')
    const { getClientConfig } = await import('./config/client-config')
    const contactId = req.params.contactId

    const contactRes = await db.query(
      `SELECT phone_number, client_id FROM contacts WHERE id=$1`, [contactId]
    )
    if (contactRes.rowCount === 0) return res.status(404).json({ error: 'Contact not found' })

    const { phone_number, client_id } = contactRes.rows[0]
    const config = await getClientConfig(client_id)
    if (!config.crm_api_key) return res.json({ phones: [] })

    const fubBase = config.crm_base_url || 'https://api.followupboss.com/v1'
    const fubRes = await axios.get(`${fubBase}/people/${contactId}`, {
      auth: { username: config.crm_api_key, password: '' },
      timeout: 10_000,
    })

    const phones: string[] = ((fubRes.data?.phones || []) as Array<{ value?: string }>)
      .map((p) => p.value?.trim())
      .filter((p): p is string => !!p && p !== phone_number)

    res.json({ current: phone_number, phones: [...new Set(phones)] })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

// Swap to a different phone number and re-queue the first message
app.post('/inbox/api/conversations/:contactId/use-phone', requireInboxAuth, async (req, res) => {
  try {
    const { db } = await import('./db/client')
    const contactId = req.params.contactId
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : ''
    if (!phone) return res.status(400).json({ error: 'phone required' })

    const contactRes = await db.query(`SELECT client_id FROM contacts WHERE id=$1`, [contactId])
    if (contactRes.rowCount === 0) return res.status(404).json({ error: 'Contact not found' })
    const { client_id } = contactRes.rows[0]

    await db.query(`UPDATE contacts SET phone_number=$1, updated_at=NOW() WHERE id=$2`, [phone, contactId])
    // Clear any failed/pending first_message entries and re-queue fresh
    await db.query(
      `DELETE FROM outbound_queue WHERE contact_id=$1 AND message_type='first_message'`, [contactId]
    )
    await db.query(
      `INSERT INTO outbound_queue (client_id, contact_id, message_type, status, scheduled_at)
       VALUES ($1, $2, 'first_message', 'pending', NOW())`,
      [client_id, contactId]
    )
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

// Mark contact as non-WhatsApp number and notify the agent
app.post('/inbox/api/conversations/:contactId/mark-no-number', requireInboxAuth, async (req, res) => {
  try {
    const { db } = await import('./db/client')
    const { getClientConfig } = await import('./config/client-config')
    const contactId = req.params.contactId

    const contactRes = await db.query(
      `SELECT c.id, c.client_id, c.phone_number,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.phone_number) AS contact_name
       FROM contacts c WHERE c.id=$1`, [contactId]
    )
    if (contactRes.rowCount === 0) return res.status(404).json({ error: 'Contact not found' })
    const contact = contactRes.rows[0]
    const config = await getClientConfig(contact.client_id)

    // Tag the contact and clear pending first_message queue
    await db.query(
      `UPDATE contacts
       SET tags = ARRAY(SELECT DISTINCT UNNEST(tags || ARRAY['non_whatsapp_number'])),
           updated_at = NOW()
       WHERE id=$1`,
      [contactId]
    )
    await db.query(
      `DELETE FROM outbound_queue WHERE contact_id=$1 AND message_type='first_message'`, [contactId]
    )

    // Notify Charmaine with styled email
    noNumberEmail({ name: contact.contact_name, phone: contact.phone_number, id: contactId })

    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/inbox/api/conversations/:contactId', requireInboxAuth, async (req, res) => {
  try {
    const { db } = await import('./db/client')
    const contactId = req.params.contactId
    await db.query(`DELETE FROM outbound_queue WHERE contact_id=$1`, [contactId])
    await db.query(`DELETE FROM ai_responses WHERE contact_id=$1`, [contactId])
    await db.query(`DELETE FROM message_log WHERE contact_id=$1`, [contactId])
    await db.query(`DELETE FROM contacts WHERE id=$1`, [contactId])
    res.json({ success: true })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.get('/inbox/api/events', requireInboxAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.flushHeaders?.()
  const unsubscribe = subscribeInboxEvents(res)
  req.on('close', unsubscribe)
})

// ════════════════════════════════════════════════════════════
// Outbound First Message Entry — CRM Webhook
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

    // Run Outbound First Message in background
    handleCrmWebhook(payload, crm_type || 'generic').catch((err) => {
      logger.error('Outbound First Message error', { error: err.message, contact_id: payload.contact_id })
    })

  } catch (err: any) {
    logger.error('CRM webhook handler error', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════════
// Inbound Reply Handler Entry — Inbound WhatsApp Message
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
           WHERE phone_number LIKE $2
           RETURNING id, client_id`,
          [deliveryStatus, `%${recipientPhone}%`]
        ).then((result) => {
          for (const row of result.rows) {
            publishInboxEvent({
              type: 'status_updated',
              contactId: row.id,
              clientId: row.client_id,
              timestamp: new Date().toISOString(),
            })
          }
        }).catch(() => {})
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

        // Trigger Inbound Reply Handler with transcribed text
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

    // Trigger Inbound Reply Handler
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
// Inbound Reply Handler Entry — Inbound SMS Message
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

    // Trigger Inbound Reply Handler
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

app.get('/admin/inbox-users', requireAdminSecret, async (_req, res) => {
  res.json(await listInboxUsers())
})

app.post('/admin/inbox-users', requireAdminSecret, async (req, res) => {
  try {
    const user = await createInboxUser(
      String(req.body?.email || ''),
      String(req.body?.password || ''),
      req.body?.display_name ? String(req.body.display_name) : null
    )
    res.json({ success: true, user })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/admin/inbox-users/:id/active', requireAdminSecret, async (req, res) => {
  const userId = Number(req.params.id)
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' })
  const raw = req.body?.is_active
  const isActive = raw === true || raw === 'true' || raw === 1 || raw === '1'
  const user = await setInboxUserActive(userId, isActive)
  if (!user) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true, user })
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
      if (c.wa_first_message_template_name !== undefined) { updates.push(`wa_first_message_template_name = $${paramIndex++}`); params.push(c.wa_first_message_template_name) }
      if (c.wa_followup1_template_name !== undefined) { updates.push(`wa_followup1_template_name = $${paramIndex++}`); params.push(c.wa_followup1_template_name) }
      if (c.wa_followup2_template_name !== undefined) { updates.push(`wa_followup2_template_name = $${paramIndex++}`); params.push(c.wa_followup2_template_name) }
      if (c.wa_followup3_template_name !== undefined) { updates.push(`wa_followup3_template_name = $${paramIndex++}`); params.push(c.wa_followup3_template_name) }
      if (c.wa_bump_template_names !== undefined) { updates.push(`wa_bump_template_names = $${paramIndex++}`); params.push(JSON.stringify(c.wa_bump_template_names)) }
      if (c.wa_reach_back_out_template_name !== undefined) { updates.push(`wa_reach_back_out_template_name = $${paramIndex++}`); params.push(c.wa_reach_back_out_template_name) }
      if (c.wa_marketing_template_cost_usd !== undefined) { updates.push(`wa_marketing_template_cost_usd = $${paramIndex++}`); params.push(c.wa_marketing_template_cost_usd) }
      if (c.agent_name !== undefined) { updates.push(`agent_name = $${paramIndex++}`); params.push(c.agent_name) }
      if (c.agent_question_template !== undefined) { updates.push(`agent_question_template = $${paramIndex++}`); params.push(c.agent_question_template) }
      if (c.test_phone_numbers !== undefined) { updates.push(`test_phone_numbers = $${paramIndex++}`); params.push(c.test_phone_numbers) }
      if (c.workflow_prompts !== undefined) { updates.push(`workflow_prompts = $${paramIndex++}`); params.push(JSON.stringify(c.workflow_prompts)) }

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

// Fetch contact(s) from FUB and feed into Outbound First Message
// Body: { search?, contact_id?, limit?, client_id? }
// - search: find by name/email (triggers first match)
// - contact_id: fetch exact FUB person ID
// - limit: pull latest N contacts (default 1, max 100)
// - client_id: defaults to "realtor_of_excellence"
app.post('/admin/trigger-contact', requireAdminSecret, async (req, res) => {
  const client_id = req.body.client_id || 'realtor_of_excellence'
  const { contact_id, search, dry_run } = req.body
  const limit = Math.min(parseInt(req.body.limit) || 1, 100)

  try {
    const { getClientConfig } = await import('./config/client-config')
    const config = await getClientConfig(client_id)
    if (!config.crm_api_key) return res.status(400).json({ error: 'No crm_api_key on client' })

    const base = config.crm_base_url || 'https://api.followupboss.com/v1'
    const auth = { username: config.crm_api_key, password: '' }

    let people: any[] = []

    if (contact_id) {
      const r = await axios.get(`${base}/people/${contact_id}`, { auth })
      people = [r.data]
    } else if (search) {
      const r = await axios.get(`${base}/people`, { auth, params: { q: search, limit: 1 } })
      people = r.data?.people || []
      if (!people.length) return res.status(404).json({ error: `No contact found for: ${search}` })
    } else {
      const r = await axios.get(`${base}/people`, { auth, params: { limit, sort: '-created' } })
      people = r.data?.people || []
    }

    const triggered: { contact_id: string; name: string; phone: string; raw?: any }[] = []
    const skipped: { contact_id: string; reason: string }[] = []

    for (const person of people) {
      const phones: string[] = (person.phones || []).map((p: any) => p.value).filter(Boolean)
      if (!phones.length) {
        skipped.push({ contact_id: person.id?.toString(), reason: 'no phone number' })
        continue
      }
      const payload = {
        contact_id:    person.id?.toString(),
        phone_number:  phones[0],
        phone_numbers: phones.length > 1 ? phones : undefined,
        first_name:    person.firstName || '',
        last_name:     person.lastName,
        email:         person.emails?.[0]?.value,
        client_id,
        assigned_to:   person.assignedTo || undefined,
      }
      triggered.push({ contact_id: payload.contact_id!, name: `${payload.first_name} ${payload.last_name || ''}`.trim(), phone: payload.phone_number, ...(dry_run ? { raw: person } : {}) })
      if (!dry_run) {
        handleCrmWebhook(payload, 'followupboss').catch((err) => {
          logger.error('trigger-contact workflow error', { error: err.message, contact_id: payload.contact_id })
        })
      }
    }

    res.json({ dry_run: !!dry_run, triggered, skipped })
  } catch (err: any) {
    const detail = err.response?.data || err.message
    logger.error('trigger-contact error', { error: err.message, detail })
    res.status(500).json({ error: err.message, detail })
  }
})

// ─── BULK IMPORT ─────────────────────────────────────────────
const DEFAULT_BULK_IMPORT_STAGES = [
  'Lead', 'Buyer', 'Hot Buyer', 'Warm Buyer',
  'Cold Buyer', 'Future Buyer', 'Buyer Nurture',
]

// Pull today's batch of Property24 Leads from FUB — pages through contacts, filters by
// source/stage/lastContacted in app code, stops as soon as daily_limit new contacts are found.
// Body: { client_id, dry_run, source, stages, last_contacted_empty, min_days, max_days, daily_limit, batch_delay_ms }
app.post('/admin/bulk-import', requireAdminSecret, async (req, res) => {
  const client_id          = req.body.client_id || 'realtor_of_excellence'
  const dry_run            = !!req.body.dry_run
  // FUB stores this source as "Property24 Leads" (no space)
  const source: string     = req.body.source || 'Property24 Leads'
  const stages: string[]   = req.body.stages || DEFAULT_BULK_IMPORT_STAGES
  const lastContactedEmpty = !!req.body.last_contacted_empty
  const minDays: number | undefined = req.body.min_days !== undefined ? Number(req.body.min_days) : undefined
  const maxDays: number | undefined = req.body.max_days !== undefined ? Number(req.body.max_days) : undefined
  const dailyLimit: number | undefined = req.body.daily_limit !== undefined ? Number(req.body.daily_limit) : undefined
  const batchDelayMs       = req.body.batch_delay_ms !== undefined ? Number(req.body.batch_delay_ms) : 200

  try {
    const { getClientConfig } = await import('./config/client-config')
    const { db } = await import('./db/client')
    const config = await getClientConfig(client_id)
    if (!config.crm_api_key) return res.status(400).json({ error: 'No crm_api_key on client' })

    const fubBase = config.crm_base_url || 'https://api.followupboss.com/v1'
    const auth    = { username: config.crm_api_key, password: '' }
    const limit   = dailyLimit ?? 50
    const PAGE    = 100

    const triggered: { contact_id: string; name: string; phone: string }[] = []
    const skipped:   { contact_id: string; name: string; reason: string }[] = []
    let totalFetched = 0
    let offset = 0
    let done = false

    // FUB doesn't support source/stage query params — fetch pages and filter in app code
    while (!done) {
      const r = await axios.get(`${fubBase}/people`, {
        auth,
        params: { limit: PAGE, offset, sort: '-created' },
      })
      const page: any[] = r.data?.people || []
      totalFetched += page.length

      for (const person of page) {
        if (triggered.length >= limit) { done = true; break }

        // Source filter
        if (person.source !== source) continue

        // Stage filter
        if (!stages.includes(person.stage)) continue

        // Last contacted filter
        const lc: string | null = person.lastContacted || null
        if (lastContactedEmpty) {
          if (!(lc === null || lc === '')) continue
        } else if (minDays !== undefined && maxDays !== undefined) {
          if (!lc) continue
          const days = (Date.now() - new Date(lc).getTime()) / 86_400_000
          if (!(days >= minDays && days <= maxDays)) continue
        }

        const id    = person.id?.toString()
        const phones: string[] = (person.phones || []).map((p: any) => p.value).filter(Boolean)

        // Split full name if FUB put everything in firstName with empty lastName
        let firstName: string = (person.firstName || '').trim()
        let lastName: string  = (person.lastName  || '').trim()
        if (firstName && !lastName && firstName.includes(' ')) {
          const spaceIdx = firstName.indexOf(' ')
          lastName  = firstName.slice(spaceIdx + 1).trim()
          firstName = firstName.slice(0, spaceIdx).trim()
        }
        const name = `${firstName} ${lastName}`.trim()

        if (!phones.length) {
          skipped.push({ contact_id: id, name, reason: 'no phone number' })
          continue
        }

        // Skip contacts already in DB
        const existing = await db.query(
          'SELECT id FROM contacts WHERE client_id = $1 AND id = $2',
          [client_id, id],
        )
        if (existing.rows.length > 0) {
          skipped.push({ contact_id: id, name, reason: 'already imported' })
          continue
        }

        // If we split the name, write the corrected fields back to FUB
        if (lastName && lastName !== (person.lastName || '').trim()) {
          axios.put(`${fubBase}/people/${id}`, { firstName, lastName }, { auth }).catch(() => {})
        }

        const payload = {
          contact_id:    id,
          phone_number:  phones[0],
          phone_numbers: phones.length > 1 ? phones : undefined,
          first_name:    firstName,
          last_name:     lastName || undefined,
          email:         person.emails?.[0]?.value,
          client_id,
          assigned_to:   person.assignedTo || undefined,
        }

        triggered.push({ contact_id: id, name, phone: phones[0] })

        if (!dry_run) {
          handleCrmWebhook(payload, 'followupboss').catch((err) => {
            logger.error('bulk-import workflow error', { error: err.message, contact_id: id })
          })
          if (batchDelayMs > 0) await new Promise(r => setTimeout(r, batchDelayMs))
        }
      }

      if (page.length < PAGE) break  // reached end of FUB contacts
      offset += PAGE
    }

    res.json({
      dry_run,
      source,
      stages_processed: stages,
      filter: { last_contacted_empty: lastContactedEmpty, min_days: minDays, max_days: maxDays },
      daily_limit: dailyLimit ?? null,
      stats: {
        total_fetched: totalFetched,
        triggered:     triggered.length,
        skipped:       skipped.length,
      },
      triggered,
      skipped,
    })
  } catch (err: any) {
    const detail = err.response?.data || err.message
    logger.error('bulk-import error', { error: err.message, detail })
    res.status(500).json({ error: err.message, detail })
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
  startTelegramBot()
})

export default app
