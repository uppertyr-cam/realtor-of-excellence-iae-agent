# Workflow Reference

Three workflows plus a scheduler. All timing values are exact from source code.

---

## IAE-00 — Outbound First Message

**File:** `src/workflows/workflow-00.ts`
**Trigger:** `POST /webhook/crm`
**Auth:** `x-iae-secret` header checked against `INTERNAL_WEBHOOK_SECRET`
**Entry function:** `handleCrmWebhook(rawPayload, crmType)`

---

### Step 1 — Authenticate

- Check `x-iae-secret` header matches `INTERNAL_WEBHOOK_SECRET`
- PASS → continue
- FAIL → return 401, stop

### Step 2 — Validate required fields

- Check body contains: `contact_id`, `phone_number`, `client_id`
- PASS → continue
- FAIL → return 400, stop

### Step 3 — Normalise payload

- Call `normalizeWebhook(rawPayload, crmType)` → `InboundWebhook`
- PASS → continue
- FAIL (unknown CRM type or malformed) → log warning, stop

### Step 4 — Load client config

- Call `getClientConfig(client_id)` — 5-minute in-memory cache
- FOUND → continue
- NOT FOUND → throw error, return 500, stop

### Step 5 — Duplicate check

- Query `contacts` table: `SELECT id FROM contacts WHERE id = $1`
- NOT EXISTS → continue
- EXISTS → log "contact already active", return 200, **stop** (silent reject — not an error)

### Step 6 — Upsert contact

- `INSERT INTO contacts ... ON CONFLICT (id) DO UPDATE` with all normalised fields
- Sets `workflow_stage = 'pending'`, `channel = config.channel`

### Step 7 — WhatsApp number validation *(only if channel = 'whatsapp' or 'whatsapp_sms_fallback')*

- Iterate `phone_numbers[]` (or single `phone_number`) from InboundWebhook in order
- For each: call `validateWhatsAppNumber(number, config.wa_phone_number_id, config.wa_access_token)`
  - VALIDATES → update `contact.phone_number` to this number, `contact.channel = 'whatsapp'`, break
  - FAILS → try next number
- ALL FAIL + channel = `'whatsapp_sms_fallback'` → update `contact.channel = 'sms'`, continue
- ALL FAIL + channel = `'whatsapp'` → log warning, continue (send will fail at step 5b below)

### Step 8 — Queue first message

- `INSERT INTO outbound_queue (contact_id, client_id, message_type='first_message', status='pending', scheduled_at=NOW())`

### Step 9 — Return 200 immediately

- Response: `{ received: true, contact_id }`
- Workflow continues asynchronously via the scheduler

---

### Scheduler: `processDripQueue()` — called every 60s

**Step 1 — Check working hours**
- Call `isWithinWorkingHours(config)` — timezone-aware, reads `config.timezone`, `working_hours_start`, `working_hours_end`, `working_days`
- WITHIN → continue
- OUTSIDE → skip this tick entirely, return

**Step 2 — Check daily send limit**
- Read in-memory `dailyCounts` Map: `{ count: number; date: string }` per client
- `count >= config.daily_send_limit` (default: 50) → skip until tomorrow
- UNDER LIMIT → continue
- ⚠️ Counter resets to 0 on server restart — not persisted to DB

**Step 3 — Check send interval**
- Read in-memory `lastSentAt` Map: timestamp of last send per client
- `Date.now() - lastSentAt < config.send_interval_minutes * 60_000` (default: 10 min) → skip this tick
- CLEAR → continue
- ⚠️ Resets on server restart

**Step 4 — Get next pending contact**
- `SELECT ... FROM outbound_queue WHERE status='pending' AND message_type='first_message' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`
- FOUND → call `sendFirstMessage(job, config)`
- NONE FOUND → return

**Step 5 — After send**
- Update `lastSentAt[clientId] = Date.now()`
- Increment `dailyCounts[clientId].count`

---

### `sendFirstMessage(job, config)` — internal

**Step 1** — Load contact from DB

**Step 2** — Personalise template
- Replace `{{first_name}}`, `{{last_name}}`, `{{phone_number}}` in `config.first_message_template`

**Step 3 — Send via channel (priority order)**
1. `wa_first_message_template_name` configured → `sendWhatsAppTemplate()`
2. channel = 'whatsapp' → `sendWhatsAppMessage()`
3. channel = 'sms' → `sendSmsMessage()`

**Step 4 — Retry wrapper (`sendWithRetry`, maxRetries=3)**
- Attempt 1 → FAIL → wait **1,000ms** → Attempt 2 → FAIL → wait **2,000ms** → Attempt 3 → FAIL → return failed `SendResult`

**Step 5a — ON FAILURE:**
- `UPDATE outbound_queue SET status='failed', error=$1`
- Add tag `send_failed` to contact
- Set `workflow_stage = 'closed'`
- Call `writeToCrm()` with failure note
- 🧑 **Human alert:** CRM note written, human must follow up manually

**Step 5b — ON SUCCESS:**
- `UPDATE outbound_queue SET status='sent', sent_at=NOW()`
- Update contact: `workflow_stage = 'active'`, `first_message_at = NOW()`
- Add tags: `first_message_sent`, `database_reactivation`
- Store sent message text in `contact.ai_memory` and `contact.first_message_sent`
- Call `writeToCrm()` with tags + opportunity creation (if `pipeline_id` configured)
- Log to `message_log` (direction='outbound', message_type='first_message')
- Schedule follow-ups:
  - `followup1` → `scheduled_at = NOW() + 7 days`
  - `followup2` → `scheduled_at = NOW() + 14 days`
  - `followup3` → `scheduled_at = NOW() + 21 days`

---

### Admin override: `POST /admin/contacts/:id/force-send`

- Calls `forceSendContact(contactId)`
- Bypasses working hours, daily limit, and send interval
- Finds the pending `first_message` job and sends immediately
- FOUND → sends, returns 200
- NOT FOUND (no pending job) → returns 400

---

## IAE-01 — Inbound Reply Handler

**File:** `src/workflows/workflow-01.ts`
**Trigger:** `POST /webhook/whatsapp` or `POST /webhook/sms`
**Constant:** `DEBOUNCE_MS = 5000` (5 seconds)
**Entry function:** `handleInboundMessage({ contact_id, message, channel, phone_number })`

---

### Step 1 — Verify webhook signature

**WhatsApp:**
- Compute HMAC-SHA256 of raw request body using `META_APP_SECRET`
- Compare with `x-hub-signature-256` header using `crypto.timingSafeEqual()`
- VALID → continue
- INVALID → log warning, return 200 *(Meta requires 200 even on rejection)*

**SMS (Twilio):**
- Call `verifyTwilioSignature()` — ⚠️ **currently always returns `true`** (not implemented)
- Returns 200 regardless

### Step 2 — Parse webhook body

**WhatsApp:** Extract from `entry[0].changes[0].value.messages[0]` and `contacts[0]`
**SMS:** Extract `From` (phone), `Body` (message), `SmsSid` from Twilio form body

### Step 3 — Lookup contact by phone number

- `SELECT * FROM contacts WHERE phone_number LIKE '%{last10digits}'` (fuzzy suffix match)
- FOUND → continue
- NOT FOUND → log "unknown number", return 200, **stop**

### Step 4 — Handle audio messages *(WhatsApp only)*

- Check if `message.type === 'audio'`
- YES — `downloadWhatsAppAudio(mediaId, phoneNumberId, accessToken)`:
  - GET media URL (30s timeout) → GET audio file as arraybuffer
  - SUCCESS → `transcribeAudio(buffer, mimeType, config.openai_api_key)`:
    - POST to OpenAI Whisper (`whisper-1`, 120s timeout)
    - SUCCESS → prepend `"[Voice note]: "` to transcript text, continue as text message
    - FAIL → call `notifyStageAgent()` 🧑 **Human alert**, **stop**
  - FAIL → call `notifyStageAgent()` 🧑 **Human alert**, **stop**
- NO (text message) → use raw text, continue

### Step 5 — Return 200 immediately

Meta and Twilio require fast ACK — return before processing

### Step 6 — Insert into message_buffer

- `INSERT INTO message_buffer (contact_id, message, channel, received_at=NOW())`

### Step 7 — Debounce

- Cancel existing `debounceTimers[contactId]` timer (if any)
- Set new `setTimeout(5000ms)` → fires `processBufferedMessages(contactId, channel)`
- Store in `debounceTimers` Map (in-memory)
- If lead sends multiple messages within 5s, only the last timer fires

---

### `processBufferedMessages(contactId, channel)` — fires after debounce

**Step 1 — Acquire DB lock**
- `db.acquireLock(contactId)` → atomic `UPDATE contacts SET processing_locked=TRUE, processing_locked_at=NOW() WHERE id=$1 AND processing_locked=FALSE`
- ACQUIRED → continue
- ALREADY LOCKED (returns false) → log "contact being processed", return immediately

**Step 2 — Collect and clear buffer**
- `SELECT * FROM message_buffer WHERE contact_id=$1 ORDER BY received_at ASC`
- Concatenate all messages with newline separator
- `DELETE FROM message_buffer WHERE contact_id=$1`

**Step 3 — Cancel pending outbound jobs**
- Set `status='failed'` on all pending `bump`, `bump_close`, and `reach_back_out` rows for this contact (lead has replied — bumps no longer needed)

**Step 4 — Load contact + client config**

**Step 5 — Update contact state**
- Add tag `reply_generating`
- `UPDATE contacts SET last_reply_at=NOW(), last_message_at=NOW(), lead_response=$1, ai_memory=ai_memory||'\nLEAD: '||$2`
- Log to `message_log` (direction='inbound')

**Step 6 — Loop counter logic**
- IF `config.loop_counter_reset_hours` IS NOT NULL AND hours since `last_reply_at` > `loop_counter_reset_hours`:
  - Reset: `loop_counter = 1`, `loop_counter_reset_at = NOW()`
- ELSE:
  - Increment: `loop_counter = loop_counter + 1`

**Step 7 — Build `leadData` dict** for prompt injection:
- `first_name`, `last_name`, `phone_number`, `client_name`, `conversation_history` (full `ai_memory`), `first_message`

**Step 8 — Route** → `routeContact()`

**Step 9 — Release lock** *(always runs — in `finally` block)*
- `db.releaseLock(contactId)` → `UPDATE contacts SET processing_locked=FALSE, processing_locked_at=NULL`

---

### `routeContact()` — decision tree (checked in order)

**A. Tags include `first_message_sent` but NOT `second_message`**
- Swap: remove `first_message_sent`, add `second_message`
- → `triggerAIGeneration()`

**B. Tags include `second_message` but NOT `multiple_messages`**
- Swap: remove `second_message`, add `multiple_messages`
- → `triggerAIGeneration()`

**C. Tags include `manual_takeover`**
- Call `notifyStageAgent()`
- 🧑 **Human takeover** — return (no AI)

**D. `loop_counter > config.loop_counter_max`** (default: 50)
- Remove tag `reply_generating`
- Return — contact silently stops receiving AI replies

**E. Default (all other cases)**
- → `triggerAIGeneration()`

---

### `triggerAIGeneration()` — calls Claude API

**Step 1** — `generateAIResponse()` (`src/ai/generate.ts`)
- Reads `config.prompt_file_path` fresh from disk every call (intentional, no cache)
- Injects: `{{first_name}}`, `{{last_name}}`, `{{phone_number}}`, `{{client_name}}`, `{{conversation_history}}`, `{{first_message}}`, `{{current_date}}` (Africa/Johannesburg timezone)
- Calls Claude Sonnet 4.6, `max_tokens: 1000`, system prompt with `cache_control: ephemeral`
- `route_lead` tool available with `tool_choice: auto`
- Timeout: **30,000ms**; Retries: **3** (backoff: **1,000ms → 2,000ms → 4,000ms**)
- Extracts text from `<message>` tags in response (fallback: raw text)
- Extracts `keyword` from `tool_use` if Claude called `route_lead`
- Returns `{ text, keyword, scheduledAt }`

**Step 2** — Store AI response
- `INSERT INTO ai_responses (contact_id, client_id, response_text, channel, status='pending')`
- Append to `contact.ai_memory`: `"AI: {responseText}"`

**Step 3** — Trigger IAE-02
- Dynamic import → `handleAIResponseReady(contactId, keyword, scheduledAt, chatHistory)`

**ON FAILURE:**
- Remove tag `reply_generating`
- Add tag `ai_failed`
- Call `notifyStageAgent()` 🧑 **Human alert**
- Write CRM note: "AI generation failed"

---

### `notifyStageAgent(contact, config, message)`

- Reads `config.stage_agents` JSONB
- Checks contact tags in priority order: `interested_in_purchasing` > `already_purchased` > `renting` > `senior_team_member` > `manual_takeover` > `default`
- Matches first tag to a `stage_agents` key → sends via that channel + target
- Falls back to legacy `notifyAgent()` if `stage_agents` not configured

---

## IAE-02 — AI Response Send + Keyword Routing

**File:** `src/workflows/workflow-02.ts`
**Trigger:** Called inline by IAE-01 (`handleAIResponseReady(contactId, routedKeyword?, scheduledAt?, chatHistory?)`)

---

### Step 1 — Load pending AI response

- `SELECT * FROM ai_responses WHERE contact_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`
- FOUND → continue
- NOT FOUND → log warning, return

### Step 2 — Remove tag `reply_generating`

### Step 3 — Goodbye killswitch check

- IF response text contains `"goodbye"` (case-insensitive):
  - `handleGoodbyeKillswitch()`:
    - Set `workflow_stage = 'closed'`
    - Add tag `goodbye_killswitch`
    - Call `writeToCrm()`: clear `trigger_field` and `ai_response` fields
    - Cancel ALL pending `followup` and `bump` / `bump_close` jobs
    - Fire `updateDashboard()` + `buildWeeklyReport()` (fire-and-forget)
  - **Return — stop all further processing**
- IF NOT → continue

### Step 4 — Sanitise message text

- Replace em-dashes (`—`), Cyrillic characters, and non-ASCII characters
- Prevents send failures from special character encoding issues

### Step 5 — Send message

- Route: `sendWhatsAppMessage()` or `sendSmsMessage()` based on `contact.channel`
- Retry: **3 attempts**, backoff: **1,000ms → 2,000ms → 4,000ms**

**Step 5a — ON FAILURE:**
- `UPDATE ai_responses SET status='failed'`
- Add tag `send_failed`
- Return

**Step 5b — ON SUCCESS:**
- `UPDATE ai_responses SET status='sent', sent_at=NOW()`
- Remove tag `send_failed` (if present from a prior failed attempt)
- Log to `message_log` (direction='outbound', message_type='ai_reply')

### Step 6 — Update AI memory

- Append to `contact.ai_memory`: `"AI: {responseText}"`

### Step 7 — Write CRM callback

- Call `writeToCrm()` with `note = ai_memory` (full conversation history)

### Step 8 — Reset bump clock

- Cancel all existing pending `bump` and `bump_close` jobs for contact
- Schedule 3 new bumps:
  - `bump` → `scheduled_at = NOW() + 24h`
  - `bump` → `scheduled_at = NOW() + 48h`
  - `bump` → `scheduled_at = NOW() + 72h`
  - `bump_close` → `scheduled_at = NOW() + 73h`
- Rotate `bump_variation_index`: `(current + 1) % 3` → cycles 0 → 1 → 2 → 0

### Step 9 — Qualifying questions tag

- IF response text mentions area / property type / price range / bedrooms:
  - Add tag `qualifying_questions`

### Step 10 — Keyword detection

- Primary: use `routedKeyword` passed from IAE-01 (Claude tool call result)
- Fallback: `detectKeyword(responseText)` — text scan:

| Phrase in response text | Keyword |
|------------------------|---------|
| `"not interested"` | `not_interested` |
| `"renting"` | `renting` |
| `"i'll reach back out"` or `"i will reach back out"` | `reach_back_out` |
| `"senior team member"` or `"more senior"` | `senior_team_member` |
| `"interested in purchasing"` / `"want to purchase"` / `"looking to buy"` / `"i'll forward your details"` | `interested_in_purchasing` |
| `"already purchased"` / `"already bought"` | `already_purchased` |
| (none of the above) | `none` |

### Step 11 — Handle keyword → `handleKeyword()`

---

### `handleKeyword()` — routing table

| Keyword | Tags Added | Tags Removed | `workflow_stage` | Bumps | CRM Action | Human |
|---------|-----------|-------------|-----------------|-------|-----------|-------|
| `not_interested` | `not_interested` | — | `closed` | Cancel all | Note + tag | — |
| `renting` | `renting`, `manual_takeover` | — | — | — | Note + tag | 🧑 Notify |
| `reach_back_out` | `reach_back_out` | — | — | — | Note | — |
| `senior_team_member` | `manual_takeover` | — | — | Cancel all | Note + tag | 🧑 Notify |
| `interested_in_purchasing` | `interested_in_purchasing`, `manual_takeover`, `qualified` | `qualifying_questions` | — | Cancel all | Note + tag | 🧑 Notify |
| `already_purchased` | `already_purchased`, `manual_takeover` | — | — | Cancel all | Note + tag | 🧑 Notify |
| `none` | — | — | — | — | Clear `trigger_field` + `ai_response` | — |

**`reach_back_out` extra:**
- IF `scheduledAt` provided: `INSERT INTO outbound_queue (message_type='reach_back_out', scheduled_at=scheduledAt)`
- IF `scheduledAt` missing: log warning, no queue entry (Claude should always provide this)

**All non-`none` keywords additionally:**
- Call `writeContactNote()` → Claude Haiku 4.5 generates summary → stored in `contact.ai_note` → written to CRM as note
- Fire `updateDashboard()` + `buildWeeklyReport()` (fire-and-forget)

---

## Scheduler — All Queue Processors

**File:** `src/queue/scheduler.ts`
**Entry function:** `startScheduler()`
**Tick interval:** every **60,000ms** (60 seconds)
**Startup delay:** **2,000ms** before first tick

### Every Tick (60s) — in order

```
1. processDripQueue()          IAE-00: sends pending first messages
2. processFollowUpQueue()      sends day-7 / day-14 / day-21 follow-ups
3. processBumpQueue()          sends 24h / 48h / 72h bump messages
4. processBumpCloseQueue()     fires bump_close at 73h
5. processReachBackOutQueue()  fires scheduled reach-back-out messages
6. db.releaseStaleLocks()      force-releases locks older than 2 minutes
```

All queue processors use `FOR UPDATE SKIP LOCKED LIMIT 10` — safe for concurrent ticks.

---

### `processFollowUpQueue()`

- Gets `pending` jobs of type `followup1/2/3` where `scheduled_at <= NOW()`, limit 10
- **Skip contact if:** `workflow_stage` IN (`replied`, `closed`, `completed`) OR tags include `manual_takeover`
- Template: `config.followup1/2/3_message_template`
- WA template name: `config.wa_followup1/2/3_template_name`
- Substitution: `{{first_name}}`, `{{last_name}}`
- Send priority: WA template → WA freeform → SMS
- **ON FAILURE:** `status='failed'`, `error=message`
- **ON SUCCESS:** Update `contact.followup{N}_sent_at`, set `workflow_stage='followupN_sent'`, write CRM tag + note, log to `message_log`

---

### `processBumpQueue()`

- Gets `pending` jobs of type `bump` where `scheduled_at <= NOW()`, limit 10
- **Skip contact if:** `workflow_stage` IN (`replied`, `closed`, `completed`) OR tags include `manual_takeover`
- Template: `config.bump_templates[contact.bump_index][contact.bump_variation_index]`
- WA template name: `config.wa_bump_template_names[contact.bump_index][contact.bump_variation_index]`
- Substitution: `{{first_name}}`, `{{last_message}}` (last AI line from `ai_memory`, truncated to ~120 chars)
- Send priority: WA template → WA freeform → SMS
- **ON SUCCESS:** Increment `contact.bump_index` (advances to next group), rotate `bump_variation_index` `(current + 1) % 3`, write CRM tag + note, log to `message_log`

---

### `processBumpCloseQueue()`

- Gets `pending` jobs of type `bump_close` where `scheduled_at <= NOW()`, limit 10
- **Skip if:** `contact.last_reply_at > job.created_at` (lead replied after bump was scheduled — contact is active)
- Add tag `bump_no_reply`
- Write CRM callback with full `ai_memory` as note
- Fire `updateDashboard()` + `buildWeeklyReport()` (fire-and-forget)

---

### `processReachBackOutQueue()`

- Gets `pending` jobs of type `reach_back_out` where `scheduled_at <= NOW()`, limit 10
- **Skip if:** tags include `manual_takeover` OR `workflow_stage` IN (`closed`, `completed`)
- Template: `config.reach_back_out_message_template`
- WA template name: `config.wa_reach_back_out_template_name`
- Substitution: `{{first_name}}`, `{{last_name}}`
- Send priority: WA template → WA freeform → SMS
- **ON SUCCESS:**
  - Add tag `reach_back_out_sent`
  - Write CRM callback + note
  - Log to `message_log`
  - Schedule 3 bumps (**+24h / +48h / +72h**) + bump_close (**+73h**) — same as after every AI reply
  - Fire `updateDashboard()` (fire-and-forget)

---

### Weekly Report Scheduler

- Runs once at startup: calculates ms until next Monday 09:00 (`Africa/Johannesburg` timezone)
- Fires: `sendWeeklyReport()` → `buildWeeklyReport()` (Google Sheets update) + Gmail SMTP send
- Recursively schedules itself for the following Monday immediately after firing

---

## Human Intervention Points

| Trigger | Workflow | What happens |
|---------|---------|-------------|
| First message send fails after 3 retries | IAE-00 `sendFirstMessage()` | CRM note written. Manual follow-up required. |
| AI generation fails after 3 retries | IAE-01 `triggerAIGeneration()` | `notifyStageAgent()` called — agent receives WhatsApp/SMS alert |
| Voice note download or transcription fails | `POST /webhook/whatsapp` | `notifyStageAgent()` called — agent receives alert |
| `manual_takeover` tag present on reply | IAE-01 `routeContact()` | `notifyStageAgent()` called — agent takes over conversation |
| `renting` keyword detected | IAE-02 `handleKeyword()` | `notifyStageAgent()` called + CRM tag written |
| `senior_team_member` keyword detected | IAE-02 `handleKeyword()` | `notifyStageAgent()` called + CRM tag written |
| `interested_in_purchasing` keyword detected | IAE-02 `handleKeyword()` | `notifyStageAgent()` called + CRM tag written |
| `already_purchased` keyword detected | IAE-02 `handleKeyword()` | `notifyStageAgent()` called + CRM tag written |
| Loop counter exceeded (`loop_counter > max`) | IAE-01 `routeContact()` | Contact silently stops. No agent notification. Manual review via CRM or dashboard. |
| Unknown phone number sends a message | `POST /webhook/whatsapp` or `/sms` | Server log only. No notification. |
