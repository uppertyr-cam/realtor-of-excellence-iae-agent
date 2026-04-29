// ─── INBOUND WEBHOOK from any CRM ────────────────────────────
export interface InboundWebhook {
  contact_id: string
  phone_number: string
  phone_numbers?: string[]  // all numbers from CRM — used for multi-number WhatsApp fallback
  first_name: string
  last_name?: string
  email?: string
  client_id: string
  crm_type: string
  crm_callback_url: string
  assigned_to?: string
}

// ─── NORMALISED CONTACT ───────────────────────────────────────
export interface Contact {
  id: string
  client_id: string
  crm_source: string
  crm_callback_url: string | null
  phone_number: string
  first_name: string | null
  last_name: string | null
  email: string | null
  channel: string | null
  workflow_stage: string
  tags: string[]
  ai_memory: string | null
  first_message_sent: string | null
  loop_counter: number
  loop_counter_reset_at: Date | null
  processing_locked: boolean
  first_message_at: Date | null
  bump_index: number
  bump_variation_index: number
  followup1_sent_at: Date | null
  followup2_sent_at: Date | null
  followup3_sent_at: Date | null
  last_reply_at: Date | null
  last_message_at: Date | null
  lead_response: string | null
  pending_question: string | null
  pending_answer: string | null
  replied_after: string | null
  webhook_received_at: Date | null
  first_reply_at: Date | null
  total_tokens_used: number
  total_cost_usd: number
  last_delivery_status: string | null
  last_read_at: Date | null
  crm_sync_failures: number
  assigned_to: string | null
  created_at: Date
  updated_at: Date
}

// ─── CLIENT CONFIG ───────────────────────────────────────────
export interface ClientConfig {
  id: string
  name: string
  timezone: string
  working_hours_start: string
  working_hours_end: string
  working_days: string[]
  channel: 'whatsapp' | 'sms' | 'whatsapp_sms_fallback'
  daily_send_limit: number
  send_interval_minutes: number
  first_message_template: string
  followup1_message_template: string
  followup2_message_template: string
  followup3_message_template: string
  bump_templates: string[][]  // nested: [group][variation]
  reach_back_out_message_template: string
  // WhatsApp approved template names (required for outbound outside the 24h window)
  wa_first_message_template_name: string | null
  wa_followup1_template_name: string | null
  wa_followup2_template_name: string | null
  wa_followup3_template_name: string | null
  wa_bump1_template_name: string | null  // deprecated: kept for backwards compat
  wa_bump2_template_name: string | null  // deprecated: kept for backwards compat
  wa_bump3_template_name: string | null  // deprecated: kept for backwards compat
  wa_bump_template_names: string[][]  // nested: [group][variation]
  wa_reach_back_out_template_name: string | null
  wa_marketing_template_cost_usd: number
  wa_phone_number_id: string | null
  wa_access_token: string | null
  sms_from_number: string | null
  sms_account_sid: string | null
  sms_auth_token: string | null
  crm_type: string
  crm_api_key: string | null
  crm_base_url: string | null
  pipeline_id: string | null
  pipeline_stage_id: string | null
  notification_channel: string | null
  notification_target: string | null
  prompt_file_path: string
  loop_counter_max: number
  loop_counter_reset_hours: number | null
  openai_api_key: string | null
  stage_agents: Record<string, { channel: string; target: string }> | null
  agent_question_template: string | null
  agent_name: string | null
  test_phone_numbers: string[]
  workflow_prompts: Record<string, string>
}

// ─── SEND RESULT ─────────────────────────────────────────────
export interface SendResult {
  success: boolean
  message_id?: string
  error?: string
}

// ─── CRM UPDATE PAYLOAD ───────────────────────────────────────
export interface CrmUpdate {
  contact_id: string
  tags_add?: string[]
  tags_remove?: string[]
  note?: string
  fields?: Record<string, string>
  opportunity?: {
    pipeline_id: string
    stage_id: string
    name: string
  }
}

// ─── KEYWORD DETECTION RESULT ────────────────────────────────
export type DetectedKeyword =
  | 'not_interested'
  | 'renting'
  | 'reach_back_out'
  | 'senior_team_member'
  | 'interested_in_purchasing'
  | 'buyer_qualified'
  | 'already_purchased'
  | 'none'
