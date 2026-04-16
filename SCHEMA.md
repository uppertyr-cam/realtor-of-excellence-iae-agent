# Schema Reference

Generated from source on 2026-04-12. Authoritative sources: `src/db/schema.sql` (tables/indexes) and `src/utils/types.ts` (TypeScript interfaces).

---

## Database Tables

### `clients`

One row per client. Stores all configuration, credentials, and templates.

| Column | Type | Constraint | Default |
|--------|------|-----------|---------|
| `id` | TEXT | PRIMARY KEY | — |
| `name` | TEXT | NOT NULL | — |
| `timezone` | TEXT | NOT NULL | `'UTC'` |
| `working_hours_start` | TIME | NOT NULL | `'09:00'` |
| `working_hours_end` | TIME | NOT NULL | `'17:00'` |
| `working_days` | TEXT[] | NOT NULL | `ARRAY['Mon','Tue','Wed','Thu','Fri']` |
| `channel` | TEXT | NOT NULL, CHECK IN ('whatsapp','sms','whatsapp_sms_fallback') | — |
| `daily_send_limit` | INT | NOT NULL | `50` |
| `send_interval_minutes` | INT | NOT NULL | `10` |
| `first_message_template` | TEXT | NOT NULL | `'Hi {{first_name}}, ...'` |
| `followup1_message_template` | TEXT | NOT NULL | `'Hi {{first_name}}, just following up...'` |
| `followup2_message_template` | TEXT | NOT NULL | `'Hi {{first_name}}, checking in again...'` |
| `followup3_message_template` | TEXT | NOT NULL | `'Hi {{first_name}}, last time reaching out...'` |
| `bump_templates` | JSONB | NOT NULL | `'[]'` |
| `reach_back_out_message_template` | TEXT | NOT NULL | `'Hi {{first_name}}, just checking in...'` |
| `wa_phone_number_id` | TEXT | — | NULL |
| `wa_access_token` | TEXT | — | NULL |
| `wa_first_message_template_name` | TEXT | — | NULL |
| `wa_followup1_template_name` | TEXT | — | NULL |
| `wa_followup2_template_name` | TEXT | — | NULL |
| `wa_followup3_template_name` | TEXT | — | NULL |
| `wa_bump1_template_name` | TEXT | deprecated | NULL |
| `wa_bump2_template_name` | TEXT | deprecated | NULL |
| `wa_bump3_template_name` | TEXT | deprecated | NULL |
| `wa_bump_template_names` | JSONB | — | `'[]'` |
| `wa_reach_back_out_template_name` | TEXT | — | NULL |
| `sms_from_number` | TEXT | — | NULL |
| `sms_account_sid` | TEXT | — | NULL |
| `sms_auth_token` | TEXT | — | NULL |
| `crm_type` | TEXT | NOT NULL | `'generic'` |
| `crm_api_key` | TEXT | — | NULL |
| `crm_base_url` | TEXT | — | NULL |
| `pipeline_id` | TEXT | — | NULL |
| `pipeline_stage_id` | TEXT | — | NULL |
| `notification_channel` | TEXT | — | `'email'` |
| `notification_target` | TEXT | — | NULL |
| `prompt_file_path` | TEXT | NOT NULL | `'prompts/conversation.txt'` |
| `dashboard_sheet_id` | TEXT | — | NULL |
| `loop_counter_max` | INT | NOT NULL | `50` |
| `loop_counter_reset_hours` | INT | — | NULL |
| `openai_api_key` | TEXT | — | NULL |
| `stage_agents` | JSONB | — | `'{}'` |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |

**Notes:**
- `wa_bump1/2/3_template_name` are deprecated — use `wa_bump_template_names` (nested `[group][variation]`)
- `stage_agents` format: `{ "default": { "channel": "whatsapp", "target": "+61..." }, "interested_in_purchasing": { "channel": "whatsapp", "target": "+61..." } }`
- `bump_templates` format: nested `string[][]` — `[group][variation]` (3 groups × 3 variations = 9 total)
- `dashboard_sheet_id` is shared between the live dashboard tab and the weekly report tab (same spreadsheet)

---

### `contacts`

One row per contact. Primary state store for the entire workflow.

| Column | Type | Constraint | Default |
|--------|------|-----------|---------|
| `id` | TEXT | PRIMARY KEY | — |
| `client_id` | TEXT | NOT NULL, FK → clients(id) | — |
| `crm_source` | TEXT | NOT NULL | — |
| `crm_callback_url` | TEXT | — | NULL |
| `phone_number` | TEXT | NOT NULL | — |
| `first_name` | TEXT | — | NULL |
| `last_name` | TEXT | — | NULL |
| `email` | TEXT | — | NULL |
| `channel` | TEXT | — | NULL |
| `workflow_stage` | TEXT | NOT NULL | `'pending'` |
| `tags` | TEXT[] | NOT NULL | `'{}'` |
| `ai_memory` | TEXT | — | NULL |
| `ai_note` | TEXT | — | NULL |
| `first_message_sent` | TEXT | — | NULL |
| `loop_counter` | INT | NOT NULL | `0` |
| `loop_counter_reset_at` | TIMESTAMPTZ | — | NULL |
| `processing_locked` | BOOLEAN | NOT NULL | `FALSE` |
| `processing_locked_at` | TIMESTAMPTZ | — | NULL |
| `bump_index` | INT | NOT NULL | `0` |
| `bump_variation_index` | INT | NOT NULL | `0` |
| `first_message_at` | TIMESTAMPTZ | — | NULL |
| `followup1_sent_at` | TIMESTAMPTZ | — | NULL |
| `followup2_sent_at` | TIMESTAMPTZ | — | NULL |
| `followup3_sent_at` | TIMESTAMPTZ | — | NULL |
| `last_reply_at` | TIMESTAMPTZ | — | NULL |
| `last_message_at` | TIMESTAMPTZ | — | NULL |
| `opportunity_id` | TEXT | — | NULL |
| `lead_response` | TEXT | — | NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |

**`workflow_stage` values:** `pending` → `active` → `followup1_sent` → `followup2_sent` → `followup3_sent` → `replied` → `completed` → `closed`

**`crm_source` values:** `hubspot` | `salesforce` | `gohighlevel` | `followupboss` | `generic`

**`bump_index`:** Which bump group (0, 1, 2) to use next. Incremented after each bump send.

**`bump_variation_index`:** Which variation (0, 1, 2) within the group. Rotates 0 → 1 → 2 → 0 across bump cycles to avoid identical messages.

**`ai_memory` format:** Append-only string log: `"AI: {text}\nLEAD: {text}\nAI: {text}\n..."` — scanned for `LEAD:` prefix to detect replies.

---

### `outbound_queue`

Stores all scheduled outbound jobs: first messages, follow-ups, bumps, and reach-back-outs.

| Column | Type | Constraint | Default |
|--------|------|-----------|---------|
| `id` | SERIAL | PRIMARY KEY | — |
| `client_id` | TEXT | NOT NULL, FK → clients(id) | — |
| `contact_id` | TEXT | NOT NULL, FK → contacts(id) | — |
| `message_type` | TEXT | NOT NULL | `'first_message'` |
| `status` | TEXT | NOT NULL | `'pending'` |
| `scheduled_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |
| `sent_at` | TIMESTAMPTZ | — | NULL |
| `error` | TEXT | — | NULL |
| `attempts` | INT | NOT NULL | `0` |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |

**`message_type` values:** `first_message` | `followup1` | `followup2` | `followup3` | `bump` | `bump_close` | `reach_back_out`

**`status` values:** `pending` | `processing` | `sent` | `failed`

---

### `message_buffer`

Temporary debounce buffer. Inbound messages land here and are held for 5 seconds before processing fires.

| Column | Type | Constraint | Default |
|--------|------|-----------|---------|
| `id` | SERIAL | PRIMARY KEY | — |
| `contact_id` | TEXT | NOT NULL, FK → contacts(id) | — |
| `message` | TEXT | NOT NULL | — |
| `channel` | TEXT | NOT NULL | — |
| `received_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |

---

### `ai_responses`

Holds generated AI replies between generation and send. Allows decoupling generation from delivery.

| Column | Type | Constraint | Default |
|--------|------|-----------|---------|
| `id` | SERIAL | PRIMARY KEY | — |
| `contact_id` | TEXT | NOT NULL, FK → contacts(id) | — |
| `client_id` | TEXT | NOT NULL, FK → clients(id) | — |
| `response_text` | TEXT | NOT NULL | — |
| `channel` | TEXT | NOT NULL | — |
| `status` | TEXT | NOT NULL | `'pending'` |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |
| `sent_at` | TIMESTAMPTZ | — | NULL |

**`status` values:** `pending` | `sent` | `failed`

---

### `message_log`

Immutable audit trail. Every message in and out is appended here — never updated or deleted.

| Column | Type | Constraint | Default |
|--------|------|-----------|---------|
| `id` | SERIAL | PRIMARY KEY | — |
| `contact_id` | TEXT | NOT NULL, FK → contacts(id) | — |
| `client_id` | TEXT | NOT NULL, FK → clients(id) | — |
| `direction` | TEXT | NOT NULL, CHECK IN ('inbound','outbound') | — |
| `channel` | TEXT | NOT NULL | — |
| `content` | TEXT | NOT NULL | — |
| `message_type` | TEXT | — | NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` |

**`message_type` values:** `first_message` | `followup1` | `followup2` | `followup3` | `bump` | `bump_close` | `ai_reply`

---

## Indexes

| Index Name | Table | Columns | Purpose |
|-----------|-------|---------|---------|
| `idx_contacts_client` | contacts | client_id | Filter contacts by client |
| `idx_contacts_phone` | contacts | phone_number | Inbound message lookup by phone |
| `idx_contacts_stage` | contacts | workflow_stage | Filter by stage |
| `idx_queue_status` | outbound_queue | status, scheduled_at | Scheduler picks up pending jobs |
| `idx_queue_client` | outbound_queue | client_id, status | Per-client queue queries |
| `idx_buffer_contact` | message_buffer | contact_id, received_at | Collect buffered messages in order |
| `idx_ai_responses_contact` | ai_responses | contact_id, status | Find pending response for contact |
| `idx_log_contact` | message_log | contact_id | Audit trail lookup by contact |

---

## TypeScript Interfaces (`src/utils/types.ts`)

### `InboundWebhook`

Normalised shape produced by `normalizeWebhook()`. This is the internal contact schema used throughout workflows.

```typescript
interface InboundWebhook {
  contact_id:       string
  phone_number:     string
  phone_numbers?:   string[]   // All numbers from CRM — used for WhatsApp multi-number fallback
  first_name:       string
  last_name?:       string
  email?:           string
  client_id:        string
  crm_type:         string
  crm_callback_url: string
}
```

---

### `Contact`

Direct row mapping of the `contacts` table.

```typescript
interface Contact {
  id:                    string
  client_id:             string
  crm_source:            string
  crm_callback_url:      string | null
  phone_number:          string
  first_name:            string | null
  last_name:             string | null
  email:                 string | null
  channel:               string | null
  workflow_stage:        string
  tags:                  string[]
  ai_memory:             string | null
  first_message_sent:    string | null
  loop_counter:          number
  loop_counter_reset_at: Date | null
  processing_locked:     boolean
  first_message_at:      Date | null
  bump_index:            number
  bump_variation_index:  number
  followup1_sent_at:     Date | null
  followup2_sent_at:     Date | null
  followup3_sent_at:     Date | null
  last_reply_at:         Date | null
  last_message_at:       Date | null
  lead_response:         string | null
  created_at:            Date
  updated_at:            Date
}
```

---

### `ClientConfig`

Loaded by `getClientConfig()` from the `clients` table. Cached in memory for 5 minutes.

```typescript
interface ClientConfig {
  id:                               string
  name:                             string
  timezone:                         string
  working_hours_start:              string
  working_hours_end:                string
  working_days:                     string[]
  channel:                          'whatsapp' | 'sms' | 'whatsapp_sms_fallback'
  daily_send_limit:                 number
  send_interval_minutes:            number
  first_message_template:           string
  followup1_message_template:       string
  followup2_message_template:       string
  followup3_message_template:       string
  bump_templates:                   string[][]        // [group][variation]
  reach_back_out_message_template:  string
  wa_first_message_template_name:   string | null
  wa_followup1_template_name:       string | null
  wa_followup2_template_name:       string | null
  wa_followup3_template_name:       string | null
  wa_bump1_template_name:           string | null     // deprecated
  wa_bump2_template_name:           string | null     // deprecated
  wa_bump3_template_name:           string | null     // deprecated
  wa_bump_template_names:           string[][]        // [group][variation]
  wa_reach_back_out_template_name:  string | null
  wa_phone_number_id:               string | null
  wa_access_token:                  string | null
  sms_from_number:                  string | null
  sms_account_sid:                  string | null
  sms_auth_token:                   string | null
  crm_type:                         string
  crm_api_key:                      string | null
  crm_base_url:                     string | null
  pipeline_id:                      string | null
  pipeline_stage_id:                string | null
  notification_channel:             string | null
  notification_target:              string | null
  prompt_file_path:                 string
  loop_counter_max:                 number
  loop_counter_reset_hours:         number | null
  openai_api_key:                   string | null
  stage_agents:                     Record<string, { channel: string; target: string }> | null
}
```

---

### `SendResult`

Returned by every channel send function (`sendWhatsAppMessage`, `sendWhatsAppTemplate`, `sendSmsMessage`).

```typescript
interface SendResult {
  success:     boolean
  message_id?: string
  error?:      string
}
```

---

### `CrmUpdate`

Payload passed to `writeToCrm()` to write back to the originating CRM.

```typescript
interface CrmUpdate {
  contact_id:   string
  tags_add?:    string[]
  tags_remove?: string[]
  note?:        string
  fields?:      Record<string, string>
  opportunity?: {
    pipeline_id: string
    stage_id:    string
    name:        string
  }
}
```

---

### `DetectedKeyword`

Union type for keyword routing. Returned by `detectKeyword()` and by the Claude `route_lead` tool.

```typescript
type DetectedKeyword =
  | 'not_interested'
  | 'renting'
  | 'reach_back_out'
  | 'senior_team_member'
  | 'interested_in_purchasing'
  | 'already_purchased'
  | 'none'
```

---

## CRM Field Mappings

### Inbound — `normalizeWebhook()` (`src/crm/normalizer.ts`)

Maps raw CRM webhook payload to the internal `InboundWebhook` schema.

| Internal Field | HubSpot | Salesforce | GoHighLevel | FollowUpBoss | Generic |
|---------------|---------|-----------|------------|-------------|---------|
| `contact_id` | `objectId` \| `contact_id` | `Id` \| `contact_id` | `contactId` \| `contact_id` | `id` \| `contact_id` | `contact_id` |
| `phone_number` | `properties.phone` \| `phone_number` | `MobilePhone` \| `Phone` \| `phone_number` | `phone` \| `phone_number` | `phones[0].value` | `phone_number` |
| `phone_numbers` | — | — | — | `phones[].value` (all numbers) | — |
| `first_name` | `properties.firstname` \| `first_name` | `FirstName` \| `first_name` | `firstName` \| `first_name` | `firstName` \| `first_name` | `first_name` |
| `last_name` | `properties.lastname` \| `last_name` | `LastName` \| `last_name` | `lastName` \| `last_name` | `lastName` \| `last_name` | `last_name` |
| `email` | `properties.email` \| `email` | `Email` \| `email` | `email` | `emails[0].value` \| `email` | `email` |
| `client_id` | `client_id` | `client_id` | `client_id` | `client_id` | `client_id` |
| `crm_type` | `'hubspot'` (hardcoded) | `'salesforce'` | `'gohighlevel'` | `'followupboss'` | `raw.crm_type` \| `'generic'` |
| `crm_callback_url` | `crm_callback_url` | `crm_callback_url` | `crm_callback_url` | `crm_callback_url` | `crm_callback_url` |

**Aliases:** GoHighLevel accepts `'gohighlevel'` or `'ghl'`. FollowUpBoss accepts `'followupboss'` or `'fub'`.

---

### Outbound — `writeToCrm()` (`src/crm/adapter.ts`)

Routes to the correct write function based on `config.crm_type`. All failures are non-fatal (logged, never thrown).

#### HubSpot
- **Auth:** `Authorization: Bearer {crm_api_key}`
- **Base URL:** `config.crm_base_url` || `https://api.hubapi.com`
- **Fields:** `PATCH /crm/v3/objects/contacts/{contact_id}` → `{ properties: fields }`
- **Notes:** `POST /crm/v3/objects/notes` → `{ hs_note_body, hs_timestamp }` + contact association (type 202 = HUBSPOT_DEFINED)
- **Tags:** Not natively supported — passed via `fields`

#### Salesforce
- **Auth:** `Authorization: Bearer {crm_api_key}`
- **Base URL:** `config.crm_base_url` (required — throws if missing)
- **Fields:** `PATCH /services/data/v58.0/sobjects/Contact/{contact_id}` → `fields`
- **Notes:** `POST /services/data/v58.0/sobjects/Task` → `{ WhoId, Subject: 'IAE Note', Description: note, Status: 'Completed' }`
- **Tags:** Not natively supported — passed via `fields`

#### GoHighLevel
- **Auth:** `Authorization: Bearer {crm_api_key}`
- **Base URL:** `config.crm_base_url` || `https://rest.gohighlevel.com`
- **Tags (add):** `POST /v1/contacts/{contact_id}/tags` → `{ tags: tags_add }`
- **Tags (remove):** `DELETE /v1/contacts/{contact_id}/tags` → `{ tags: tags_remove }` in request body
- **Notes:** `POST /v1/contacts/{contact_id}/notes` → `{ body: note }`
- **Fields:** `PUT /v1/contacts/{contact_id}` → `fields`

#### FollowUpBoss
- **Auth:** HTTP Basic — `username: crm_api_key`, `password: ''`
- **Base URL:** `config.crm_base_url` || `https://api.followupboss.com/v1`
- **Tags:** `GET /people/{contact_id}` → merge existing + `tags_add`, remove `tags_remove` → `PUT /people/{contact_id}` with merged tags + fields
- **Notes:** `POST /notes` → `{ personId: contact_id, body: note }`
- **Fields:** Included in same `PUT /people/{contact_id}` as tags

#### Generic
- **Method:** `POST {crm_callback_url}` with full `CrmUpdate` payload as JSON
- **Auth:** `X-IAE-Secret: {INTERNAL_WEBHOOK_SECRET}` header
- **Timeout:** 10 seconds
- **Fallback:** Logs warning if no `crm_callback_url` provided

---

## Data Flow

```
INBOUND — CRM triggers a new contact
────────────────────────────────────────────────────────────────────
CRM / External source
  │
  ▼  Header: x-iae-secret
POST /webhook/crm
  │
  ▼
normalizeWebhook(raw, crm_type)              src/crm/normalizer.ts
  │  Maps CRM fields → InboundWebhook
  │
  ▼
getClientConfig(client_id)                   src/config/client-config.ts
  │  Loads clients row (5-min cache)
  │
  ▼
Duplicate check — contacts table
  │  EXISTS → reject silently (200)
  │  NOT EXISTS → continue
  ▼
UPSERT contacts                              Postgres
  │
  ▼
validateWhatsAppNumber()                     src/channels/whatsapp.ts
  │  Tries phone_numbers[] in order
  │  VALIDATES → update contact.phone_number + channel
  │  ALL FAIL → fallback to SMS (if whatsapp_sms_fallback)
  ▼
INSERT outbound_queue                        Postgres
  (message_type='first_message', status='pending')
  │
  ▼ [Scheduler picks up within 60s]


INBOUND — Lead replies
────────────────────────────────────────────────────────────────────
Lead sends WhatsApp or SMS reply
  │
  ▼  HMAC verified (WhatsApp) / stub (SMS)
POST /webhook/whatsapp  or  POST /webhook/sms
  │  [if audio] downloadWhatsAppAudio() → transcribeAudio()
  │
  ▼
handleInboundMessage()                       src/workflows/inbound-reply-handler.ts
  │
  ▼
INSERT message_buffer                        Postgres
  │
  ▼
5s debounce timer fires → processBufferedMessages()
  │  Concatenates all buffered messages, clears buffer
  │
  ▼
acquireLock(contactId)                       src/db/client.ts
  │
  ▼
generateAIResponse()                         src/ai/generate.ts
  │  Fresh prompt read from disk
  │  Claude Sonnet 4.6, 30s timeout, 3 retries
  │  Claude may call route_lead tool → keyword
  │
  ▼
INSERT ai_responses                          Postgres
  │
  ▼
handleAIResponseReady()                      src/workflows/ai-send-router.ts
  │  Sends message, keyword routing, CRM write
  │
  ▼
releaseLock(contactId)                       src/db/client.ts


OUTBOUND — System writes back to CRM
────────────────────────────────────────────────────────────────────
Any workflow event (send success, keyword, tag change)
  │
  ▼
writeToCrm(CrmUpdate, config, callbackUrl)   src/crm/adapter.ts
  │  Routes by config.crm_type
  │
  ├─ writeHubspot()    PATCH /crm/v3/objects/contacts + POST /crm/v3/objects/notes
  ├─ writeSalesforce() PATCH /sobjects/Contact + POST /sobjects/Task
  ├─ writeGHL()        POST/DELETE /v1/contacts/tags + POST /v1/contacts/notes
  ├─ writeFollowUpBoss() GET+PUT /people + POST /notes
  └─ writeGeneric()    POST crm_callback_url
  │
  ▼
CRM updated (tags, notes, fields, opportunity)
Non-fatal: errors logged, workflow continues regardless
```

---

## Field Naming Conventions

| Convention | Pattern | Examples |
|-----------|---------|---------|
| All names | `snake_case` | `first_name`, `client_id`, `bump_index` |
| WhatsApp-specific | `wa_` prefix | `wa_phone_number_id`, `wa_access_token`, `wa_bump_template_names` |
| SMS/Twilio | `sms_` prefix | `sms_from_number`, `sms_account_sid`, `sms_auth_token` |
| CRM config | `crm_` prefix | `crm_type`, `crm_api_key`, `crm_base_url` |
| Drip sequence | `followup1/2/3` | `followup1_message_template`, `followup1_sent_at`, `wa_followup2_template_name` |
| Bump-related | `bump_` prefix | `bump_templates`, `bump_index`, `bump_variation_index`, `bump_no_reply` |
| Timestamps | `_at` suffix | `first_message_at`, `last_reply_at`, `processing_locked_at` |
| Message copy | `_template` suffix | `first_message_template`, `reach_back_out_message_template` |
| WA approved template names | `_template_name` suffix | `wa_first_message_template_name`, `wa_reach_back_out_template_name` |
| Tag strings | `lowercase_snake_case` | `first_message_sent`, `manual_takeover`, `interested_in_purchasing` |
| Boolean flags | adjective/noun | `processing_locked`, `success` |
