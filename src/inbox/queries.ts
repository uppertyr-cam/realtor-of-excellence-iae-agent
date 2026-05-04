import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { getAssignedToFromCrm } from '../crm/adapter'

type ConversationFilter = 'all' | 'unread' | 'read' | 'not_sent'

function normalizeFilter(filter?: string): ConversationFilter {
  if (filter === 'unread' || filter === 'read' || filter === 'not_sent') return filter
  return 'all'
}

function getOutcomeLabel(tags: string[] = []): string {
  if (tags.includes('not_interested')) return 'Not interested'
  if (tags.includes('already_purchased')) return 'Already bought'
  if (tags.includes('renting')) return 'Wants to rent'
  if (tags.includes('buyer_qualified')) return 'Buyer qualified'
  if (tags.includes('interested_in_purchasing')) return 'Interested'
  if (tags.includes('reach_back_out')) return 'Reach back out'
  if (tags.includes('reach_back_out_sent')) return 'Reach back out sent'
  if (tags.includes('bump_no_reply')) return 'No reply after bumps'
  return 'In progress'
}

function getNextActionLabel(type: string | null): string {
  if (!type) return 'No pending execution'
  const map: Record<string, string> = {
    first_message: 'First message',
    followup1: 'Follow-up 1',
    followup2: 'Follow-up 2',
    followup3: 'Follow-up 3',
    bump: 'Bump',
    bump_close: 'Bump close',
    reach_back_out: 'Reach back out',
  }
  return map[type] || type
}

export async function listConversations(search = '', filter?: string) {
  const term = `%${search.trim().toLowerCase()}%`
  const normalizedFilter = normalizeFilter(filter)
  const result = await db.query(
    `SELECT
       c.id AS contact_id,
       c.client_id,
       cl.name AS client_name,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.phone_number, c.id) AS contact_name,
       c.phone_number,
       c.channel,
       c.workflow_stage,
       c.tags,
       c.updated_at,
       c.last_delivery_status,
       c.pending_question,
       c.pending_answer,
       c.assigned_to,
       queue_next.message_type AS next_action_type,
       queue_next.status AS next_action_status,
       queue_next.scheduled_at AS next_action_due,
       last_msg.content AS last_message,
       last_msg.direction AS last_direction,
       last_msg.channel AS last_message_channel,
       last_msg.message_type AS last_message_type,
       last_msg.created_at AS last_message_at
     FROM contacts c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN LATERAL (
       SELECT content, direction, channel, message_type, created_at
       FROM message_log ml
       WHERE ml.contact_id = c.id
       ORDER BY ml.created_at DESC, ml.id DESC
       LIMIT 1
     ) last_msg ON TRUE
     LEFT JOIN LATERAL (
       SELECT message_type, status, scheduled_at
       FROM outbound_queue oq
       WHERE oq.contact_id = c.id
         AND oq.status IN ('pending', 'paused')
       ORDER BY CASE WHEN oq.status = 'pending' THEN 0 ELSE 1 END, oq.scheduled_at ASC, oq.id ASC
       LIMIT 1
     ) queue_next ON TRUE
     WHERE (
       $1 = '%%'
       OR LOWER(COALESCE(c.first_name, '')) LIKE $1
       OR LOWER(COALESCE(c.last_name, '')) LIKE $1
       OR LOWER(COALESCE(c.phone_number, '')) LIKE $1
       OR LOWER(cl.name) LIKE $1
     )
     AND NOT ('non_whatsapp_number' = ANY(c.tags))
     AND (
       $2 = 'all'
       OR ($2 = 'unread' AND 'awaiting_agent_answer' = ANY(c.tags))
       OR ($2 = 'read' AND 'awaiting_faq_approval' = ANY(c.tags))
       OR ($2 = 'not_sent' AND NOT EXISTS (
         SELECT 1
         FROM message_log ml_out
         WHERE ml_out.contact_id = c.id
           AND ml_out.direction = 'outbound'
       ))
     )
     ORDER BY COALESCE(last_msg.created_at, c.updated_at) DESC
     LIMIT 250`,
    [term, normalizedFilter]
  )

  return result.rows.map((row) => ({
    ...row,
    needs_attention: row.last_direction === 'inbound',
    workflow_status: getOutcomeLabel(row.tags || []),
    next_action_label: getNextActionLabel(row.next_action_type || null),
    automation_state: row.next_action_status === 'paused' ? 'paused' : row.next_action_status === 'pending' ? 'active' : 'idle',
    agent_question_status:
      Array.isArray(row.tags) && row.tags.includes('awaiting_agent_answer')
        ? 'awaiting_agent_reply'
        : Array.isArray(row.tags) && row.tags.includes('awaiting_faq_approval')
          ? 'agent_replied'
          : null,
  }))
}

export async function getConversationCounts(search = '') {
  const term = `%${search.trim().toLowerCase()}%`
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS all_count,
       COUNT(*) FILTER (WHERE 'awaiting_agent_answer' = ANY(c.tags))::int AS unread_count,
       COUNT(*) FILTER (WHERE 'awaiting_faq_approval' = ANY(c.tags))::int AS read_count,
       COUNT(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1
           FROM message_log ml_out
           WHERE ml_out.contact_id = c.id
             AND ml_out.direction = 'outbound'
         )
       )::int AS not_sent_count
     FROM contacts c
     JOIN clients cl ON cl.id = c.client_id
     WHERE (
       $1 = '%%'
       OR LOWER(COALESCE(c.first_name, '')) LIKE $1
       OR LOWER(COALESCE(c.last_name, '')) LIKE $1
       OR LOWER(COALESCE(c.phone_number, '')) LIKE $1
       OR LOWER(cl.name) LIKE $1
     )`,
    [term]
  )

  return result.rows[0] || {
    all_count: 0,
    unread_count: 0,
    read_count: 0,
    not_sent_count: 0,
  }
}

export async function getConversationDetail(contactId: string) {
  const contactRes = await db.query(
    `SELECT
       c.id AS contact_id,
       c.client_id,
       cl.name AS client_name,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.phone_number, c.id) AS contact_name,
       c.first_name,
       c.last_name,
       c.phone_number,
       c.channel,
       c.workflow_stage,
       c.tags,
       c.last_delivery_status,
       c.last_read_at,
       c.pending_question,
       c.pending_answer,
       c.assigned_to,
       queue_next.message_type AS next_action_type,
       queue_next.status AS next_action_status,
       queue_next.scheduled_at AS next_action_due,
       wa_window.last_inbound_at AS whatsapp_last_inbound_at,
       pending_ai.id AS pending_ai_response_id,
       pending_ai.response_text AS pending_ai_response_text,
       pending_ai.created_at AS pending_ai_created_at,
       queue_state.pending_count,
       queue_state.paused_count,
       c.updated_at
     FROM contacts c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN LATERAL (
       SELECT message_type, status, scheduled_at
       FROM outbound_queue oq
       WHERE oq.contact_id = c.id
         AND oq.status IN ('pending', 'paused')
       ORDER BY CASE WHEN oq.status = 'pending' THEN 0 ELSE 1 END, oq.scheduled_at ASC, oq.id ASC
       LIMIT 1
     ) queue_next ON TRUE
     LEFT JOIN LATERAL (
       SELECT created_at AS last_inbound_at
       FROM message_log ml
       WHERE ml.contact_id = c.id
         AND ml.direction = 'inbound'
         AND ml.channel = 'whatsapp'
       ORDER BY ml.created_at DESC, ml.id DESC
       LIMIT 1
     ) wa_window ON TRUE
     LEFT JOIN LATERAL (
       SELECT id, response_text, created_at
       FROM ai_responses ar
       WHERE ar.contact_id = c.id
         AND ar.status = 'pending'
       ORDER BY ar.created_at DESC, ar.id DESC
       LIMIT 1
     ) pending_ai ON TRUE
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
         COUNT(*) FILTER (WHERE status = 'paused') AS paused_count
       FROM outbound_queue oq
       WHERE oq.contact_id = c.id
         AND oq.status IN ('pending', 'paused')
         AND oq.message_type IN ('followup1','followup2','followup3','bump','bump_close','reach_back_out')
     ) queue_state ON TRUE
     WHERE c.id=$1`,
    [contactId]
  )

  if (contactRes.rowCount === 0) return null

  const contactRow = contactRes.rows[0]
  try {
    const config = await getClientConfig(contactRow.client_id)
    const crmAssignedTo = await getAssignedToFromCrm(contactId, config)
    if (crmAssignedTo !== undefined && crmAssignedTo !== contactRow.assigned_to) {
      await db.query(
        `UPDATE contacts SET assigned_to=$1, updated_at=NOW() WHERE id=$2`,
        [crmAssignedTo, contactId]
      )
      contactRow.assigned_to = crmAssignedTo
    }
  } catch {}

  const messageRes = await db.query(
    `SELECT id, direction, channel, content, message_type, created_at
     FROM message_log
     WHERE contact_id=$1
     ORDER BY created_at ASC, id ASC`,
    [contactId]
  )

  return {
    contact: {
      ...contactRow,
      workflow_status: getOutcomeLabel(contactRow.tags || []),
      next_action_label: getNextActionLabel(contactRow.next_action_type || null),
      automation_state:
        Number(contactRow.paused_count || 0) > 0
          ? 'paused'
          : Number(contactRow.pending_count || 0) > 0
            ? 'active'
            : 'idle',
      pending_ai_response_id: contactRow.pending_ai_response_id || null,
      pending_ai_response_text: contactRow.pending_ai_response_text || null,
      pending_ai_created_at: contactRow.pending_ai_created_at || null,
      whatsapp_last_inbound_at: contactRow.whatsapp_last_inbound_at || null,
      whatsapp_window_open:
        (contactRow.channel === 'whatsapp' || contactRow.channel === 'whatsapp_sms_fallback') &&
        !!contactRow.whatsapp_last_inbound_at &&
        Date.now() - new Date(contactRow.whatsapp_last_inbound_at).getTime() <= 24 * 60 * 60 * 1000,
      is_stuck: !!contactRow.next_action_due && new Date(contactRow.next_action_due).getTime() < Date.now(),
    },
    messages: messageRes.rows,
  }
}
