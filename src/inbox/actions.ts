import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { writeToCrm } from '../crm/adapter'
import { sendWhatsAppMessage } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'
import { scheduleBumps } from '../workflows/bump-handler'
import { handleAIResponseReady } from '../workflows/ai-send-router'
import { publishInboxEvent } from './live-events'

const AUTOMATION_MESSAGE_TYPES = ['followup1', 'followup2', 'followup3', 'bump', 'bump_close', 'reach_back_out']

type ContactContext = {
  id: string
  client_id: string
  crm_callback_url: string | null
  phone_number: string
  channel: string | null
  ai_memory: string | null
  workflow_stage: string
  pending_question: string | null
  pending_answer: string | null
}

type WhatsAppWindowState = {
  isOpen: boolean
  lastInboundAt: string | null
}

async function getContactContext(contactId: string): Promise<{ contact: ContactContext; config: any }> {
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [contactId])
  if (contactRes.rowCount === 0) throw new Error('Conversation not found')
  const contact = contactRes.rows[0] as ContactContext
  const config = await getClientConfig(contact.client_id)
  return { contact, config }
}

async function sendMessage(contact: ContactContext, config: any, text: string): Promise<void> {
  const sanitized = text.replace(/[\u2013\u2014]/g, ' - ').replace(/[\u0430]/g, 'a').replace(/[^\x00-\x7F]/g, '')
  const channel = contact.channel || config.channel

  if (channel === 'whatsapp') {
    const result = await sendWhatsAppMessage(contact.phone_number, sanitized, config.wa_phone_number_id!, config.wa_access_token!)
    if (!result.success) throw new Error(result.error || 'WhatsApp send failed')
    return
  }

  const result = await sendSmsMessage(contact.phone_number, sanitized, config.sms_account_sid!, config.sms_auth_token!, config.sms_from_number!)
  if (!result.success) throw new Error(result.error || 'SMS send failed')
}

async function getWhatsAppWindowState(contactId: string): Promise<WhatsAppWindowState> {
  const result = await db.query(
    `SELECT created_at
     FROM message_log
     WHERE contact_id=$1
       AND direction='inbound'
       AND channel='whatsapp'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [contactId]
  )

  if (result.rowCount === 0) {
    return { isOpen: false, lastInboundAt: null }
  }

  const lastInboundAt = result.rows[0].created_at
  const isOpen = Date.now() - new Date(lastInboundAt).getTime() <= 24 * 60 * 60 * 1000
  return { isOpen, lastInboundAt }
}

function dedupeTags(tags: string[], additions: string[] = [], removals: string[] = []) {
  return Array.from(new Set([...(tags || []), ...additions])).filter((tag) => !removals.includes(tag))
}

async function notifyConversationUpdated(contactId: string, clientId: string) {
  publishInboxEvent({
    type: 'conversation_updated',
    contactId,
    clientId,
    timestamp: new Date().toISOString(),
  })
}

export async function sendManualReply(contactId: string, message: string, pauseAutomationAfterSend = false) {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Message is required')

  const { contact, config } = await getContactContext(contactId)
  const channel = contact.channel || config.channel
  if (channel === 'whatsapp') {
    const windowState = await getWhatsAppWindowState(contactId)
    if (!windowState.isOpen) {
      const detail = windowState.lastInboundAt
        ? `Last inbound WhatsApp message was ${new Date(windowState.lastInboundAt).toISOString()}.`
        : 'No inbound WhatsApp message is recorded for this conversation.'
      throw new Error(`WhatsApp freeform replies only work within 24 hours of the lead's last message. ${detail}`)
    }
  }

  await sendMessage(contact, config, trimmed)

  const nextTags = dedupeTags(
    (await db.query(`SELECT tags FROM contacts WHERE id=$1`, [contactId])).rows[0]?.tags || [],
    [],
    ['reply_generating', 'awaiting_agent_answer', 'awaiting_faq_approval']
  )

  await db.query(
    `UPDATE contacts SET
       ai_memory = COALESCE(ai_memory, '') || $1,
       workflow_stage = 'active',
       pending_question = NULL,
       pending_answer = NULL,
       tags = $2,
       updated_at = NOW()
     WHERE id = $3`,
    [`\nMANUAL: ${trimmed}`, nextTags, contactId]
  )

  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type)
     VALUES ($1,$2,'outbound',$3,$4,'manual_reply')`,
    [contactId, config.id, channel, trimmed]
  )

  await db.query(`DELETE FROM ai_responses WHERE contact_id=$1 AND status='pending'`, [contactId])

  if (pauseAutomationAfterSend) {
    await setAutomationPaused(contactId, true, false)
  } else {
    await db.query(
      `UPDATE outbound_queue SET status='cancelled'
       WHERE contact_id=$1 AND status IN ('pending','paused')
       AND message_type IN ('followup1','followup2','followup3','reach_back_out','bump','bump_close')`,
      [contactId]
    )
    await scheduleBumps(contactId, config.id)
  }

  await writeToCrm(
    {
      contact_id: contactId,
      note: `IAE inbox: Manual reply sent via ${channel}.\n\nMessage: ${trimmed}\n\nTimestamp: ${new Date().toISOString()}`,
      fields: { ai_memory: (contact.ai_memory || '') + `\nMANUAL: ${trimmed}` },
    },
    config,
    contact.crm_callback_url
  )

  publishInboxEvent({
    type: 'message_created',
    contactId,
    clientId: config.id,
    timestamp: new Date().toISOString(),
  })
}

export async function approvePendingAiReply(contactId: string, editedMessage?: string) {
  const pendingRes = await db.query(
    `SELECT id FROM ai_responses
     WHERE contact_id=$1 AND status='pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [contactId]
  )
  if (pendingRes.rowCount === 0) throw new Error('No pending AI reply found')

  if (editedMessage !== undefined) {
    const trimmed = editedMessage.trim()
    if (!trimmed) throw new Error('Message is required')
    await db.query(`UPDATE ai_responses SET response_text=$1 WHERE id=$2`, [trimmed, pendingRes.rows[0].id])
  }

  await handleAIResponseReady(contactId)
}

export async function setConversationResolved(contactId: string) {
  const { contact, config } = await getContactContext(contactId)
  const currentTagsRes = await db.query(`SELECT tags FROM contacts WHERE id=$1`, [contactId])
  const nextTags = dedupeTags(currentTagsRes.rows[0]?.tags || [], ['resolved_manual'], [
    'reply_generating',
    'awaiting_agent_answer',
    'awaiting_faq_approval',
  ])

  await db.query(
    `UPDATE contacts SET
       workflow_stage='completed',
       pending_question=NULL,
       pending_answer=NULL,
       tags=$1,
       updated_at=NOW()
     WHERE id=$2`,
    [nextTags, contactId]
  )

  await db.query(
    `UPDATE outbound_queue SET status='cancelled'
     WHERE contact_id=$1 AND status IN ('pending','paused')`,
    [contactId]
  )
  await db.query(`DELETE FROM ai_responses WHERE contact_id=$1 AND status='pending'`, [contactId])

  await writeToCrm(
    {
      contact_id: contactId,
      note: `IAE inbox: Conversation marked resolved.\n\nTimestamp: ${new Date().toISOString()}`,
    },
    config,
    contact.crm_callback_url
  )

  await notifyConversationUpdated(contactId, config.id)
}

export async function setAutomationPaused(contactId: string, paused: boolean, publishEvent = true) {
  const { contact, config } = await getContactContext(contactId)
  const fromStatus = paused ? 'pending' : 'paused'
  const toStatus = paused ? 'paused' : 'pending'

  await db.query(
    `UPDATE outbound_queue SET status=$2
     WHERE contact_id=$1
       AND status=$3
       AND message_type = ANY($4::text[])`,
    [contactId, toStatus, fromStatus, AUTOMATION_MESSAGE_TYPES]
  )

  await writeToCrm(
    {
      contact_id: contactId,
      note: `IAE inbox: Follow-up automation ${paused ? 'paused' : 'resumed'}.\n\nTimestamp: ${new Date().toISOString()}`,
    },
    config,
    contact.crm_callback_url
  )

  if (publishEvent) {
    await notifyConversationUpdated(contactId, contact.client_id)
  }
}

export async function assignConversation(contactId: string, assignedTo: string | null) {
  const { contact, config } = await getContactContext(contactId)
  const normalized = assignedTo?.trim() || null
  await db.query(
    `UPDATE contacts SET assigned_to=$1, updated_at=NOW() WHERE id=$2`,
    [normalized, contactId]
  )

  await writeToCrm(
    {
      contact_id: contactId,
      note: normalized
        ? `IAE inbox: Conversation assigned to ${normalized}.`
        : `IAE inbox: Conversation assignment cleared.`,
      fields: normalized ? { assignedTo: normalized } : {},
    },
    config,
    contact.crm_callback_url
  )

  await notifyConversationUpdated(contactId, contact.client_id)
}
