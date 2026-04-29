# Workflow: Inbound Reply Handler

## Objective
When a lead replies via WhatsApp or SMS, buffer and debounce their message(s), acquire a DB lock on the contact, route based on tags and loop counter, generate an AI response via Claude, then hand off to AI Response Send + Keyword Routing for sending.

## File
`src/workflows/inbound-reply-handler.ts`

## Trigger
`POST /webhook/whatsapp` or `POST /webhook/sms`

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js / TypeScript on Contabo VPS |
| Database | Supabase (PostgreSQL) — lock, buffer, message log |
| AI | Claude Sonnet 4.6 (`claude-sonnet-4-6`) |
| Messaging | Meta WhatsApp Business API / Twilio SMS |
| Transcription | OpenAI Whisper (optional — voice notes only) |

---

## Required `.env` Variables

| Variable | Purpose |
|---|---|
| `META_APP_SECRET` | HMAC-SHA256 signature verification for WhatsApp webhooks |
| `DATABASE_URL` | Supabase Postgres connection |
| `ANTHROPIC_API_KEY` | Claude API for AI response generation |

Twilio signature verification is not yet implemented — all SMS webhooks are accepted.

---

## Steps

### Webhook Entry

1. **Verify signature** *(WhatsApp only)*
   - Compute HMAC-SHA256 of raw body using `META_APP_SECRET`
   - Compare with `x-hub-signature-256` header via `crypto.timingSafeEqual()`
   - FAIL → log warning, return 200 *(Meta requires 200 even on rejection)*
2. **Parse body**
   - WhatsApp: extract from `entry[0].changes[0].value.messages[0]`
   - SMS: extract `From`, `Body`, `SmsSid` from Twilio form body
3. **Lookup contact** — fuzzy suffix match on last 10 digits of phone number
   - NOT FOUND → log "unknown number", return 200, **stop**
4. **Handle audio** *(WhatsApp voice notes only)*
   - Download audio from Meta CDN (30s timeout)
   - Transcribe via OpenAI Whisper (120s timeout) — prepend `"[Voice note]: "` to text
   - FAIL at any step → `notifyStageAgent()` 🧑 Human alert, **stop**
5. **Return 200 immediately** — Meta/Twilio require fast ACK before processing begins
6. **Insert into `message_buffer`** — stores message with `received_at = NOW()`
7. **Debounce** — cancel existing timer for this contact, set new 5-second timer
   - If lead sends multiple messages within 5s, only the last timer fires
   - Timer fires → `processBufferedMessages(contactId, channel)`

---

### `processBufferedMessages()` — fires after 5s debounce

1. **Acquire DB lock**
   - Atomic `UPDATE contacts SET processing_locked=TRUE WHERE processing_locked=FALSE`
   - ALREADY LOCKED → log, return immediately (another process is handling this contact)
2. **Collect and clear buffer**
   - `SELECT * FROM message_buffer WHERE contact_id ORDER BY received_at ASC`
   - Concatenate all messages with newline separator
   - `DELETE FROM message_buffer WHERE contact_id`
3. **Cancel pending outbound jobs** — set `status='failed'` on all pending `bump`, `bump_close`, and `reach_back_out` jobs (lead has replied — no longer needed)
4. **Load contact + client config**
5. **Update contact state**
   - Add tag `reply_generating`
   - Update `last_reply_at`, `last_message_at`, `lead_response`, append to `ai_memory`
   - Log to `message_log` (direction='inbound')
6. **Loop counter**
   - If hours since `last_reply_at` > `loop_counter_reset_hours`: reset counter to 1
   - Otherwise: increment counter
7. **Build `leadData`** — `first_name`, `last_name`, `phone_number`, `client_name`, `conversation_history`, `first_message`
8. **Route** → `routeContact()`
9. **Release DB lock** *(always — in `finally` block)*

---

### `routeContact()` — decision tree (checked in order)

| Condition | Action |
|-----------|--------|
| Has `first_message_sent`, NOT `second_message` | Swap tags → AI generation |
| Has `second_message`, NOT `multiple_messages` | Swap tags → AI generation |
| Has `manual_takeover` | `notifyStageAgent()` 🧑 Human takeover — stop |
| `loop_counter > loop_counter_max` (default: 50) | Remove `reply_generating` — stop silently |
| Default | AI generation |

---

### `triggerAIGeneration()`

1. Read prompt file fresh from disk (`config.prompt_file_path`) — no cache, supports live edits
2. Inject variables: `{{first_name}}`, `{{last_name}}`, `{{phone_number}}`, `{{client_name}}`, `{{conversation_history}}`, `{{first_message}}`, `{{current_date}}` (Africa/Johannesburg timezone)
3. Call Claude Sonnet 4.6 — `max_tokens: 1000`, system prompt with `cache_control: ephemeral`
   - `route_lead` tool available (Claude calls this to set a routing keyword)
   - Timeout: **30s**, retries: **3** (backoff: **1s → 2s → 4s**)
4. Extract message text from `<message>` tags (fallback: raw response text)
5. Extract `keyword` and `scheduledAt` from `route_lead` tool call (if Claude used it)
6. Store AI response in `ai_responses` table (`status='pending'`)
7. Append to `contact.ai_memory`: `"AI: {responseText}"`
8. Trigger AI Response Send + Keyword Routing: `handleAIResponseReady(contactId, keyword, scheduledAt, chatHistory)`

**ON FAILURE:**
- Remove tag `reply_generating`
- Add tag `ai_failed`
- Call `notifyStageAgent()` 🧑 Human alert
- Write CRM note: "AI generation failed"

---

### Agent Notification: `notifyStageAgent()`

- Reads `config.stage_agents` JSONB from client config
- Checks contact tags in priority order: `interested_in_purchasing` > `already_purchased` > `renting` > `senior_team_member` > `manual_takeover` > `default`
- Sends alert via matching channel + target
- Falls back to legacy `notifyAgent()` if `stage_agents` not configured

---

## Edge Cases

| Problem | Fix |
|---|---|
| Contact replies but nothing happens | Check `message_buffer` table for the contact. Check if `processing_locked = TRUE` (stale lock — cleared automatically within 2 min by scheduler, or manually: `UPDATE contacts SET processing_locked=FALSE WHERE id='...'`). |
| AI not generating — `ai_failed` tag on contact | Check server logs for Claude API error. Check `ANTHROPIC_API_KEY` is valid. Check if prompt file exists at `config.prompt_file_path`. |
| Voice note not being processed | OpenAI Whisper is optional — `openai_api_key` must be set in `clients` table for this client. If not set, voice notes will not be transcribed. |
| Contact loop counter maxed out | Contact has exceeded `loop_counter_max` (default: 50). No AI replies will be sent. Review conversation in CRM. If lead is still engaged, reset `loop_counter = 0` in DB. |
| Multiple messages from lead concatenated | This is expected behaviour — debounce collects all messages within 5s into one AI call. |
| Unknown number sends a message | Logged only — no notification. Cross-check the number format in the `contacts` table (suffix match on last 10 digits). |

---

## Notes
- The `processing_locked` flag prevents race conditions when leads reply in rapid succession. The scheduler auto-releases locks older than 2 minutes.
- The prompt file is read fresh from disk on every AI call — you can edit `skills/prompts/conversation.txt` on the VPS without restarting the server.
- The debounce timer is in-memory — it does not survive a server restart. If the server restarts mid-debounce, the buffered message will remain in `message_buffer` unprocessed until the next inbound message triggers a new timer for that contact.
- Claude's `route_lead` tool is the primary source for keyword routing — `detectKeyword()` text scan in AI Response Send + Keyword Routing is the fallback only.
