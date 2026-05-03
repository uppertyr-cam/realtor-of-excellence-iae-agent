// ============================================================
// Inbound Reply Handler
// Instant Appointment Engine — Inbound Reply Handler
//
// Entry: POST /webhook/inbound  (WhatsApp or SMS reply)
// Handles: debounce → data capture → route → generate AI reply
// ============================================================

import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { generateAIResponse } from '../ai/generate'
import { calcSonnetCost, countLegacyTokens, getWhatsAppMarketingTemplateCostUsd } from '../config/pricing'
import { writeToCrm } from '../crm/adapter'
import { logger } from '../utils/logger'
import { alertEmail } from '../utils/alert'
import { publishInboxEvent } from '../inbox/live-events'
import { updateDashboard } from '../reports/dashboard'
import { updateMetrics } from '../reports/weekly-report'

const DEBOUNCE_MS = 5_000
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ─── ENTRY POINT ─────────────────────────────────────────────
// Called when an inbound WhatsApp or SMS message arrives
export async function handleInboundMessage(params: {
  contact_id: string
  message: string
  channel: 'whatsapp' | 'sms'
  phone_number: string
}) {
  logger.info('Inbound Reply Handler triggered', {
    contact_id: params.contact_id, channel: params.channel,
  })

  // ── Step 1: Store message in buffer ──────────────────────
  await db.query(
    `INSERT INTO message_buffer (contact_id, message, channel, received_at)
     VALUES ($1, $2, $3, NOW())`,
    [params.contact_id, params.message, params.channel]
  )

  // ── Step 2: Debounce — cancel existing timer if any ──────
  const existing = debounceTimers.get(params.contact_id)
  if (existing) clearTimeout(existing)

  // Set new timer — only the last message's timer will fire
  const timer = setTimeout(async () => {
    debounceTimers.delete(params.contact_id)
    await processBufferedMessages(params.contact_id, params.channel)
  }, DEBOUNCE_MS)

  debounceTimers.set(params.contact_id, timer)
}

// ─── PROCESS BUFFERED MESSAGES ───────────────────────────────
async function processBufferedMessages(contactId: string, channel: string) {
  // ── Step 3: Acquire DB lock ───────────────────────────────
  const locked = await db.acquireLock(contactId)
  if (!locked) {
    logger.warn('Could not acquire lock — another process is handling this contact', { contactId })
    return
  }

  try {
    // ── Step 4: Collect + concatenate all buffered messages ─
    const bufferRes = await db.query(
      `SELECT message FROM message_buffer
       WHERE contact_id=$1
       ORDER BY received_at ASC`,
      [contactId]
    )

    if (bufferRes.rowCount === 0) return

    const combinedMessage = bufferRes.rows.map((r) => r.message).join('\n')

    // Clear buffer
    await db.query(`DELETE FROM message_buffer WHERE contact_id=$1`, [contactId])

    // Cancel all pending outbound automation once the lead has replied.
    await db.query(
      `UPDATE outbound_queue SET status='cancelled'
       WHERE contact_id=$1 AND status IN ('pending','paused')
       AND message_type IN ('followup1','followup2','followup3','bump','bump_close','reach_back_out')`,
      [contactId]
    )

    // ── Step 5: Load contact + client config ─────────────────
    const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [contactId])
    if (contactRes.rowCount === 0) {
      logger.error('Contact not found', { contactId })
      return
    }
    const contact = contactRes.rows[0]
    const config = await getClientConfig(contact.client_id)

    // ── Step 6: Clear trigger field + add reply generating tag
    await db.query(
      `UPDATE contacts SET
         tags=array_append(tags,'reply_generating'),
         last_reply_at=NOW(),
         first_reply_at=COALESCE(first_reply_at, NOW()),
         replied_after=CASE WHEN first_reply_at IS NULL THEN
           CASE
             WHEN bump_index > 0                        THEN 'bump_' || bump_index
             WHEN workflow_stage = 'followup3_sent'      THEN 'followup_3'
             WHEN workflow_stage = 'followup2_sent'      THEN 'followup_2'
             WHEN workflow_stage = 'followup1_sent'      THEN 'followup_1'
             ELSE 'first_message'
           END
         ELSE replied_after END,
         lead_response=$1,
         updated_at=NOW()
       WHERE id=$2`,
      [combinedMessage, contactId]
    )

    // ── Step 7: Update AI memory with inbound message ────────
    const newMemory = [
      contact.ai_memory || '',
      `\nLEAD: ${combinedMessage}`,
    ].join('')

    await db.query(`UPDATE contacts SET ai_memory=$1 WHERE id=$2`, [newMemory, contactId])

    // ── Step 8: Add note to CRM ──────────────────────────────
    await writeToCrm(
      {
        contact_id: contactId,
        note: `IAE: Lead replied via ${channel}.\n\nMessage: ${combinedMessage}\n\nTimestamp: ${new Date().toISOString()}`,
        fields: { lead_response: combinedMessage },
      },
      config,
      contact.crm_callback_url
    )

    // ── Step 9: Log to message_log ───────────────────────────
    await db.query(
      `INSERT INTO message_log (contact_id, client_id, direction, channel, content)
       VALUES ($1,$2,'inbound',$3,$4)`,
      [contactId, config.id, channel, combinedMessage]
    )
    publishInboxEvent({
      type: 'message_created',
      contactId,
      clientId: config.id,
      timestamp: new Date().toISOString(),
    })

    // ── Step 10: Loop counter + reset logic ──────────────────
    const hoursSinceLastReply = contact.last_reply_at
      ? (Date.now() - new Date(contact.last_reply_at).getTime()) / 3_600_000
      : 999

    let loopCounter = contact.loop_counter + 1
    const resetHours = config.loop_counter_reset_hours
    if (resetHours !== null && resetHours !== undefined && hoursSinceLastReply > resetHours) {
      loopCounter = 1
      logger.info('Loop counter reset — inactivity gap exceeded client threshold', { contactId, resetHours })
    }

    await db.query(
      `UPDATE contacts SET loop_counter=$1, loop_counter_reset_at=CASE WHEN $2 THEN NOW() ELSE loop_counter_reset_at END WHERE id=$3`,
      [loopCounter, hoursSinceLastReply > 24, contactId]
    )

    // ── Step 11: Populate prompt fields ──────────────────────
    const leadData: Record<string, string> = {
      first_name:        contact.first_name || '',
      last_name:         contact.last_name || '',
      phone_number:      contact.phone_number,
      first_message:     contact.first_message_sent || '',
      conversation_history: newMemory,
      client_name:       config.name,
      assigned_to:       contact.assigned_to || 'your assigned agent',
    }

    // ── Step 12: Route based on stage ────────────────────────
    await routeContact(contact, config, combinedMessage, leadData, loopCounter, newMemory)
    updateDashboard(contact.client_id).catch(() => {})
    updateMetrics(contact.client_id).catch(() => {})

  } finally {
    await db.releaseLock(contactId)
  }
}

// ─── ROUTING LOGIC ───────────────────────────────────────────
async function routeContact(
  contact: any,
  config: any,
  message: string,
  leadData: Record<string, string>,
  loopCounter: number,
  chatHistory: string
) {
  const tags: string[] = contact.tags || []
  const contactId = contact.id

  // 3.0 — First message tag
  if (tags.includes('first_message_sent') && !tags.includes('second_message')) {
    logger.info('Route: first message → second message', { contactId })
    await swapTag(contactId, 'first_message_sent', 'second_message')
    await triggerAIGeneration(contact, config, message, leadData, chatHistory)
    return
  }

  // 4.0 — Second message tag
  if (tags.includes('second_message') && !tags.includes('multiple_messages')) {
    logger.info('Route: second message → multiple messages', { contactId })
    await swapTag(contactId, 'second_message', 'multiple_messages')
    await triggerAIGeneration(contact, config, message, leadData, chatHistory)
    return
  }

  // 5.0 — Awaiting agent answer — do not run AI while question is pending
  if (tags.includes('awaiting_agent_answer')) {
    logger.info('Route: awaiting agent answer — skipping AI', { contactId })
    await removeTag(contactId, 'reply_generating')
    return
  }


  // 7.0 — Loop counter locked
  if (loopCounter > config.loop_counter_max) {
    logger.info('Route: loop counter exceeded', { contactId, loopCounter })
    await removeTag(contactId, 'reply_generating')
    return
  }

  // 8.0 — Default → AI generation
  logger.info('Route: none matched → AI generation', { contactId })
  await sleep(500) // brief hold
  await triggerAIGeneration(contact, config, message, leadData, chatHistory)
}

// ─── AI GENERATION ───────────────────────────────────────────
async function triggerAIGeneration(
  contact: any,
  config: any,
  latestMessage: string,
  leadData: Record<string, string>,
  chatHistory: string
) {
  const contactId = contact.id

  try {
    const resolvedPromptPath = resolvePromptPath(contact.tags, config)
    const { text: responseText, keyword, scheduledAt, agentQuestion, usage } = await generateAIResponse({
      promptFilePath:  resolvedPromptPath,
      chatHistory,
      leadData,
      latestMessage,
      clientName: config.name,
    })

    // Agent relay — AI flagged a question it can't answer
    if (agentQuestion) {
      await db.query(
        `UPDATE contacts SET
           tags = array_append(tags, 'awaiting_agent_answer'),
           pending_question = $1
         WHERE id = $2`,
        [agentQuestion, contactId]
      )
      const fullName = `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim()
      if (config.agent_question_template) {
        const { sendWhatsAppTemplate } = await import('../channels/whatsapp')
        const agentPhone = config.stage_agents?.default?.target
        if (agentPhone) {
          const templateResult = await sendWhatsAppTemplate(
            agentPhone,
            config.agent_question_template,
            [fullName, contact.phone_number, agentQuestion],
            config.wa_phone_number_id!,
            config.wa_access_token!
          )
          if (templateResult.success) {
            await db.query(
              `UPDATE contacts SET total_cost_usd=total_cost_usd+$1 WHERE id=$2`,
              [getWhatsAppMarketingTemplateCostUsd(config), contactId]
            )
            publishInboxEvent({
              type: 'conversation_updated',
              contactId,
              clientId: config.id,
              timestamp: new Date().toISOString(),
            })
          }
        }
      } else {
        const agentMsg = [
          `❓ Question from lead:`,
          `Name: ${fullName}`,
          `Phone: ${contact.phone_number}`,
          `Message: ${agentQuestion}`,
        ].join('\n')
        await notifyStageAgent(contact, config, agentMsg)
      }
      await removeTag(contactId, 'reply_generating')
      return
    }

    // Store AI response for AI Response Send + Keyword Routing to send
    await db.query(
      `INSERT INTO ai_responses (contact_id, client_id, response_text, channel, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [contactId, config.id, responseText, contact.channel || config.channel]
    )

    // Update AI memory + accumulate token usage
    const updatedMemory = chatHistory + `\nAI: ${responseText}`
    const tokensUsed = countLegacyTokens(usage)
    const totalCostUsd = calcSonnetCost(usage)
    await db.query(
      `UPDATE contacts SET ai_memory=$1, workflow_stage='active',
         total_tokens_used=total_tokens_used+$3,
         total_cost_usd=total_cost_usd+$4
       WHERE id=$2`,
      [updatedMemory, contactId, tokensUsed, totalCostUsd]
    )

    logger.info('AI response stored — triggering AI Response Send + Keyword Routing', { contactId, keyword })

    // Trigger AI Response Send + Keyword Routing inline
    const { handleAIResponseReady } = await import('./ai-send-router')
    await handleAIResponseReady(contactId, keyword, scheduledAt)

  } catch (err: any) {
    logger.error('AI generation failed', { contactId, error: err.message })
    alertEmail('AI generation failed', { contact_id: contactId, error: err.message })
    await removeTag(contactId, 'reply_generating')
    await db.query(
      `UPDATE contacts SET tags=array_append(tags,'ai_failed') WHERE id=$1`,
      [contactId]
    )
    await notifyAgent(contact, config, `AI generation failed: ${err.message}`)
    await writeToCrm(
      { contact_id: contactId, tags_add: ['ai_failed'], note: `IAE: AI generation failed — ${err.message}` },
      config, contact.crm_callback_url
    )
  }
}

// ─── PROMPT RESOLVER ─────────────────────────────────────────
// Picks the first matching prompt from workflow_prompts based on contact tags.
// Falls back to prompt_file_path if no tag matches or map is empty.
function resolvePromptPath(tags: string[], config: any): string {
  const map: Record<string, string> = config.workflow_prompts || {}
  for (const tag of (tags || [])) {
    if (map[tag]) return map[tag]
  }
  return config.prompt_file_path
}

// ─── HELPERS ─────────────────────────────────────────────────
async function swapTag(contactId: string, remove: string, add: string) {
  await db.query(
    `UPDATE contacts SET
       tags = array_append(array_remove(tags,$1),$2)
     WHERE id=$3`,
    [remove, add, contactId]
  )
}

async function removeTag(contactId: string, tag: string) {
  await db.query(
    `UPDATE contacts SET tags=array_remove(tags,$1) WHERE id=$2`,
    [tag, contactId]
  )
}

/**
 * Send a notification to the agent via the specified channel
 * Used for voice note failures and manual takeovers
 */
async function sendNotification(
  channel: string,
  target: string,
  message: string,
  config: any
): Promise<void> {
  const { sendWhatsAppMessage } = await import('../channels/whatsapp')
  const { sendSmsMessage } = await import('../channels/sms')

  try {
    if (channel === 'whatsapp') {
      await sendWhatsAppMessage(target, message, config.wa_phone_number_id!, config.wa_access_token!)
      logger.info('Agent notification sent via WhatsApp', { target })
    } else if (channel === 'sms') {
      await sendSmsMessage(target, message, config.sms_account_sid!, config.sms_auth_token!, config.sms_from_number!)
      logger.info('Agent notification sent via SMS', { target })
    } else if (channel === 'email') {
      // TODO: Implement email via nodemailer or similar
      logger.warn('Email notifications not yet implemented', { target, message })
    } else {
      logger.warn('Unknown notification channel', { channel, target })
    }
  } catch (err: any) {
    logger.error('Failed to send agent notification', { channel, target, error: err.message })
  }
}

/**
 * Route agent notification based on contact's workflow stage and tags
 * Priority: interested_in_purchasing > already_purchased > renting > senior_team_member > default
 */
export async function notifyStageAgent(contact: any, config: any, message: string): Promise<void> {
  const stageAgents = config.stage_agents || {}

  // Tag priority order for routing
  const TAG_PRIORITY = [
    'interested_in_purchasing',
    'already_purchased',
    'renting',
    'senior_team_member',
  ]

  // Find the highest-priority matching tag
  const matchedTag = TAG_PRIORITY.find((tag) => contact.tags?.includes(tag))
  const agentConfig = stageAgents[matchedTag ?? 'default'] ?? stageAgents['default']

  if (!agentConfig?.target) {
    // Fall back to legacy single notification_target
    await notifyAgent(contact, config, message)
    return
  }

  logger.info('Routing notification to stage agent', {
    contact_id: contact.id,
    matched_tag: matchedTag ?? 'default',
    channel: agentConfig.channel,
  })

  await sendNotification(agentConfig.channel, agentConfig.target, message, config)
}

async function notifyAgent(contact: any, config: any, message: string) {
  if (!config.notification_target) {
    logger.warn('No legacy notification target configured', { contact_id: contact.id })
    return
  }

  const channel = config.notification_channel || 'email'
  await sendNotification(channel, config.notification_target, message, config)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
