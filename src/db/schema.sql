-- ============================================================
-- IAE Agent — Database Schema
-- Run this against your Supabase / Postgres instance
-- ============================================================

-- ─── CLIENTS ─────────────────────────────────────────────────
-- One row per client. Everything the agent needs to behave
-- correctly for that client lives here.
CREATE TABLE IF NOT EXISTS clients (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  working_hours_start   TIME NOT NULL DEFAULT '09:00',
  working_hours_end     TIME NOT NULL DEFAULT '17:00',
  working_days          TEXT[] NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri'],
  channel               TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','whatsapp_sms_fallback')),
  daily_send_limit      INT NOT NULL DEFAULT 50,
  send_interval_minutes INT NOT NULL DEFAULT 10,

  -- Message templates
  first_message_template    TEXT NOT NULL DEFAULT 'Hi {{first_name}}, ...',
  followup1_message_template TEXT NOT NULL DEFAULT 'Hi {{first_name}}, just following up...',
  followup2_message_template TEXT NOT NULL DEFAULT 'Hi {{first_name}}, checking in again...',
  followup3_message_template TEXT NOT NULL DEFAULT 'Hi {{first_name}}, last time reaching out...',
  bump_templates            JSONB NOT NULL DEFAULT '[]',
  reach_back_out_message_template TEXT NOT NULL DEFAULT 'Hi {{first_name}}, just checking in as you had asked us to reach back out today. Are you still looking at getting into the property market?',

  -- WhatsApp credentials
  wa_phone_number_id    TEXT,
  wa_access_token       TEXT,

  -- SMS credentials (Twilio)
  sms_from_number       TEXT,
  sms_account_sid       TEXT,
  sms_auth_token        TEXT,

  -- CRM
  crm_type              TEXT NOT NULL DEFAULT 'generic',
  crm_api_key           TEXT,
  crm_base_url          TEXT,

  -- Pipeline config
  pipeline_id           TEXT,
  pipeline_stage_id     TEXT,

  -- Manual takeover notification
  notification_channel  TEXT DEFAULT 'email',
  notification_target   TEXT,

  -- AI prompt file path (relative to project root)
  prompt_file_path      TEXT NOT NULL DEFAULT 'skills/prompts/conversation.txt',

  -- Master Google Sheet ID (created once, reused) — holds Dashboard tab + weekly report tabs
  dashboard_sheet_id    TEXT,

  -- Loop counter max before locking
  loop_counter_max      INT NOT NULL DEFAULT 50,

  -- Hours of inactivity before loop counter auto-resets (NULL = never auto-reset)
  loop_counter_reset_hours INT DEFAULT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CONTACTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id                TEXT PRIMARY KEY,  -- contact_id from CRM
  client_id         TEXT NOT NULL REFERENCES clients(id),
  crm_source        TEXT NOT NULL,     -- 'hubspot' | 'salesforce' | 'ghl' | 'generic'
  crm_callback_url  TEXT,
  phone_number      TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  channel           TEXT,              -- override client default if needed

  -- Workflow state
  workflow_stage    TEXT NOT NULL DEFAULT 'pending',
  -- pending | active | followup1_sent | followup2_sent | followup3_sent | replied | completed | closed

  -- Tags (stored as array for easy querying)
  tags              TEXT[] NOT NULL DEFAULT '{}',

  -- AI state
  ai_memory         TEXT,              -- full conversation history
  first_message_sent TEXT,
  loop_counter      INT NOT NULL DEFAULT 0,
  loop_counter_reset_at TIMESTAMPTZ,
  processing_locked BOOLEAN NOT NULL DEFAULT FALSE,
  processing_locked_at TIMESTAMPTZ,

  -- Bump state (24h/48h/72h after each AI reply)
  bump_index        INT NOT NULL DEFAULT 0,
  bump_variation_index INT NOT NULL DEFAULT 0,  -- rotates 0→1→2 across bump cycles

  -- Timestamps
  first_message_at   TIMESTAMPTZ,
  followup1_sent_at  TIMESTAMPTZ,
  followup2_sent_at  TIMESTAMPTZ,
  followup3_sent_at  TIMESTAMPTZ,
  last_reply_at      TIMESTAMPTZ,
  last_message_at    TIMESTAMPTZ,

  -- CRM fields
  opportunity_id    TEXT,
  lead_response     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── OUTBOUND QUEUE ──────────────────────────────────────────
-- Drip queue for Outbound First Message — first messages
CREATE TABLE IF NOT EXISTS outbound_queue (
  id            SERIAL PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id),
  contact_id    TEXT NOT NULL REFERENCES contacts(id),
  message_type  TEXT NOT NULL DEFAULT 'first_message',
  -- first_message | followup1 | followup2 | followup3 | bump | bump_close | reach_back_out
  status        TEXT NOT NULL DEFAULT 'pending',
  -- pending | processing | sent | failed
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── MESSAGE BUFFER ──────────────────────────────────────────
-- Debounce buffer for Inbound Reply Handler — inbound messages
CREATE TABLE IF NOT EXISTS message_buffer (
  id            SERIAL PRIMARY KEY,
  contact_id    TEXT NOT NULL REFERENCES contacts(id),
  message       TEXT NOT NULL,
  channel       TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AI RESPONSES ────────────────────────────────────────────
-- Stores generated AI replies ready for AI Response Send + Keyword Routing to send
CREATE TABLE IF NOT EXISTS ai_responses (
  id            SERIAL PRIMARY KEY,
  contact_id    TEXT NOT NULL REFERENCES contacts(id),
  client_id     TEXT NOT NULL REFERENCES clients(id),
  response_text TEXT NOT NULL,
  channel       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  -- pending | sent | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);

-- ─── MESSAGE LOG ─────────────────────────────────────────────
-- Full audit trail of every message sent and received
CREATE TABLE IF NOT EXISTS message_log (
  id            SERIAL PRIMARY KEY,
  contact_id    TEXT NOT NULL REFERENCES contacts(id),
  client_id     TEXT NOT NULL REFERENCES clients(id),
  direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel       TEXT NOT NULL,
  content       TEXT NOT NULL,
  message_type  TEXT,  -- first_message | followup1 | followup2 | followup3 | bump | bump_close | ai_reply
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── EMAIL LOG ───────────────────────────────────────────────
-- Audit trail of automated system emails sent for lead outcomes / notifications
CREATE TABLE IF NOT EXISTS email_log (
  id                  SERIAL PRIMARY KEY,
  contact_id          TEXT REFERENCES contacts(id),
  client_id           TEXT REFERENCES clients(id),
  category            TEXT NOT NULL,
  outcome             TEXT,
  recipient_to        TEXT NOT NULL,
  recipient_cc        TEXT,
  subject             TEXT NOT NULL,
  html_body           TEXT,
  send_status         TEXT NOT NULL DEFAULT 'sent',
  provider_message_id TEXT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── INDEXES ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(workflow_stage);
CREATE INDEX IF NOT EXISTS idx_queue_status ON outbound_queue(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_queue_client ON outbound_queue(client_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_drip ON outbound_queue(status, message_type, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_buffer_contact ON message_buffer(contact_id, received_at);
CREATE INDEX IF NOT EXISTS idx_ai_responses_contact ON ai_responses(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_log_contact ON message_log(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_contact ON email_log(contact_id);

CREATE TABLE IF NOT EXISTS inbox_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inbox_sessions (
  id            TEXT PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES inbox_users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbox_sessions_user ON inbox_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_sessions_expiry ON inbox_sessions(expires_at);

-- ─── MIGRATIONS ──────────────────────────────────────────────
-- Idempotent: safe to re-run on existing databases
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='reach_back_out_message_template'
  ) THEN
    ALTER TABLE clients
      ADD COLUMN reach_back_out_message_template TEXT NOT NULL
        DEFAULT 'Hi {{first_name}}, just checking in as you had asked us to reach back out today. Are you still looking at getting into the property market?';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='ai_note'
  ) THEN
    ALTER TABLE contacts ADD COLUMN ai_note TEXT;
  END IF;

  -- WhatsApp approved template names for outbound messages
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='wa_first_message_template_name'
  ) THEN
    ALTER TABLE clients ADD COLUMN wa_first_message_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_followup1_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_followup2_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_followup3_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_bump1_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_bump2_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_bump3_template_name TEXT;
    ALTER TABLE clients ADD COLUMN wa_reach_back_out_template_name TEXT;
  END IF;

  -- Nested bump template names (3 groups × 3 variations)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='wa_bump_template_names'
  ) THEN
    ALTER TABLE clients ADD COLUMN wa_bump_template_names JSONB DEFAULT '[]'::jsonb;
  END IF;

  -- Add bump_variation_index to contacts
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='bump_variation_index'
  ) THEN
    ALTER TABLE contacts ADD COLUMN bump_variation_index INT NOT NULL DEFAULT 0;
  END IF;

  -- OpenAI API key for voice note transcription
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='openai_api_key'
  ) THEN
    ALTER TABLE clients ADD COLUMN openai_api_key TEXT;
  END IF;

  -- Stage-based agent routing for notifications (JSONB: { default: { channel, target }, stage_name: { channel, target }, ... })
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='stage_agents'
  ) THEN
    ALTER TABLE clients ADD COLUMN stage_agents JSONB DEFAULT '{}'::jsonb;
  END IF;

  -- Agent Q&A relay: stores the question being relayed to the agent
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='pending_question'
  ) THEN
    ALTER TABLE contacts ADD COLUMN pending_question TEXT;
  END IF;

  -- Agent Q&A relay: stores the agent's answer while awaiting FAQ approval
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='pending_answer'
  ) THEN
    ALTER TABLE contacts ADD COLUMN pending_answer TEXT;
  END IF;

  -- WhatsApp approved template name for agent question notifications (works outside 24h window)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='agent_question_template'
  ) THEN
    ALTER TABLE clients ADD COLUMN agent_question_template TEXT;
  END IF;

  -- Agent name used in reach-back-out WA template {{2}}
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='agent_name'
  ) THEN
    ALTER TABLE clients ADD COLUMN agent_name TEXT;
  END IF;

  -- Test phone numbers: bypass working hours / rate limits in drip queue
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='test_phone_numbers'
  ) THEN
    ALTER TABLE clients ADD COLUMN test_phone_numbers TEXT[] DEFAULT '{}';
  END IF;

  -- Tracking improvements: webhook timing, reply timing, token usage, delivery receipts, CRM failures
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='webhook_received_at'
  ) THEN
    ALTER TABLE contacts ADD COLUMN webhook_received_at TIMESTAMPTZ;
    ALTER TABLE contacts ADD COLUMN first_reply_at TIMESTAMPTZ;
    ALTER TABLE contacts ADD COLUMN total_tokens_used INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE contacts ADD COLUMN last_delivery_status TEXT;
    ALTER TABLE contacts ADD COLUMN last_read_at TIMESTAMPTZ;
    ALTER TABLE contacts ADD COLUMN crm_sync_failures INTEGER NOT NULL DEFAULT 0;
  END IF;

  -- Track which touchpoint triggered the first reply
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='replied_after'
  ) THEN
    ALTER TABLE contacts ADD COLUMN replied_after TEXT;
  END IF;

  -- Rate limiting persistence (replaces in-memory Maps)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='daily_send_count'
  ) THEN
    ALTER TABLE clients ADD COLUMN daily_send_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE clients ADD COLUMN daily_send_date DATE;
    ALTER TABLE clients ADD COLUMN last_sent_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='assigned_to'
  ) THEN
    ALTER TABLE contacts ADD COLUMN assigned_to TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='crm_last_contacted_at'
  ) THEN
    ALTER TABLE contacts ADD COLUMN crm_last_contacted_at TIMESTAMPTZ;
  END IF;

  -- Tag-to-prompt routing: maps workflow tag → prompt file path
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='workflow_prompts'
  ) THEN
    ALTER TABLE clients ADD COLUMN workflow_prompts JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='total_cost_usd'
  ) THEN
    ALTER TABLE contacts ADD COLUMN total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='clients' AND column_name='wa_marketing_template_cost_usd'
  ) THEN
    ALTER TABLE clients ADD COLUMN wa_marketing_template_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0.043600;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='message_log' AND column_name='wa_message_id'
  ) THEN
    ALTER TABLE message_log ADD COLUMN wa_message_id TEXT;
    ALTER TABLE message_log ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent';
    CREATE INDEX IF NOT EXISTS idx_message_log_wa_id ON message_log(wa_message_id) WHERE wa_message_id IS NOT NULL;
  END IF;
END $$;
