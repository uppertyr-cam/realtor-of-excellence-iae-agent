# Roadmap

Last updated: 2026-04-12. Derived from full source scan across all files.

---

## Section 1 — Built

Everything below is implemented and functional.

### Core Infrastructure
- **Express HTTP server** — `src/index.ts`: all routes, middleware, HMAC signature verification, admin endpoints
- **Scheduler** — `src/queue/scheduler.ts:startScheduler()`: 60s tick, 5 queue processors, stale lock release (every 60s), weekly report (every Monday 9am Johannesburg)
- **DB connection pool** — `src/db/client.ts`: 20 connections, 30s idle timeout, 2s connection timeout, slow query logging (>1000ms)
- **Row-level lock system** — `src/db/client.ts:acquireLock()` / `releaseLock()` / `releaseStaleLocks()`: atomic flag column, auto-releases after 2 minutes
- **Schema migrations** — `src/db/migrate.ts` + `src/db/schema.sql`: idempotent, run via `npm run db:migrate`
- **Client config cache** — `src/config/client-config.ts:getClientConfig()`: 5-minute in-memory TTL per client, `clearClientCache()` for manual invalidation
- **Working hours check** — `src/utils/working-hours.ts:isWithinWorkingHours()` + `msUntilNextWorkingWindow()`: fully timezone-aware via `config.timezone`
- **Logger** — `src/utils/logger.ts`: winston-based structured logging

### Outbound First Message
- **CRM webhook handler** — `src/workflows/outbound-first-message.ts:handleCrmWebhook()`: normalise → duplicate check → upsert → set channel → queue
- **WhatsApp delivery fallback** — `src/workflows/outbound-first-message.ts:sendFirstMessage()`: first attempts WhatsApp delivery, then tries alternate Follow Up Boss numbers, then falls back to SMS only when the client is configured for `whatsapp_sms_fallback`
- **Drip queue processor** — `src/workflows/outbound-first-message.ts:processDripQueue()`: working hours gate, daily limit (default 50), send interval gate (default 10 min)
- **First message send** — `src/workflows/outbound-first-message.ts:sendFirstMessage()`: template personalisation (`{{first_name}}` etc.), channel priority (WA template > WA freeform > SMS), 3x retry with exponential backoff
- **Follow-up scheduling** — Inserted into `outbound_queue` at +7/+14/+21 days from first send
- **Admin force-send** — `src/index.ts POST /admin/contacts/:id/force-send` → `forceSendContact()`

### Inbound Reply Handler
- **Message buffer + debounce** — `src/workflows/inbound-reply-handler.ts:handleInboundMessage()`: 5s debounce (`DEBOUNCE_MS = 5000`), multiple messages within window concatenated before processing
- **DB lock on processing** — `src/db/client.ts:acquireLock()`: prevents race conditions on concurrent webhook deliveries for the same contact
- **Loop counter with optional reset** — `src/workflows/inbound-reply-handler.ts:processBufferedMessages()`: increments per reply cycle, configurable max (`loop_counter_max`, default 50), optional reset after N hours of silence (`loop_counter_reset_hours`)
- **Tag-based routing** — `src/workflows/inbound-reply-handler.ts:routeContact()`: `first_message_sent` → `second_message` → `multiple_messages` → AI; `manual_takeover` → human; loop limit → stop
- **Stage-based agent routing** — `src/workflows/inbound-reply-handler.ts:notifyStageAgent()`: reads `config.stage_agents` JSONB, priority-ordered tag matching, dispatches via WhatsApp or SMS
- **Voice note transcription** — `src/channels/transcription.ts:downloadWhatsAppAudio()` + `transcribeAudio()`: Meta media download (30s timeout) + OpenAI Whisper (120s timeout), optional per-client via `openai_api_key`

### AI Response Send + Keyword Routing
- **Claude AI generation** — `src/ai/generate.ts:generateAIResponse()`: Claude Sonnet 4.6, max_tokens=1000, 30s timeout, 3 retries with exponential backoff
- **Prompt caching** — `src/ai/generate.ts`: `cache_control: ephemeral` on system prompt, `prompt-caching-2024-07-31` beta header
- **`route_lead` tool** — `src/ai/generate.ts:ROUTE_LEAD_TOOL`: Claude signals keyword via tool call; 6 actions: `not_interested`, `renting`, `reach_back_out`, `senior_team_member`, `interested_in_purchasing`, `already_purchased`
- **Text-scan fallback** — `src/workflows/ai-send-router.ts:detectKeyword()`: scans response text if Claude did not call `route_lead`
- **Message sanitisation** — `src/workflows/ai-send-router.ts:sendMessage()`: removes em-dashes, Cyrillic, non-ASCII before send
- **Goodbye killswitch** — `src/workflows/ai-send-router.ts:handleGoodbyeKillswitch()`: closes conversation, cancels all queue jobs, CRM update
- **Bump clock reset** — `src/workflows/ai-send-router.ts:handleAIResponseReady()`: cancels old bumps, schedules 3 new (24h/48h/72h) + close (73h) after every AI send
- **`bump_variation_index` rotation** — cycles 0→1→2→0 across bump cycles to avoid identical messages
- **Full keyword routing** — `src/workflows/ai-send-router.ts:handleKeyword()`: 6 outcomes, correct tag/stage/CRM/bump management per outcome; reach_back_out inserts scheduled queue row
- **Step 3.0 layered defence** — prompt instruction + text-scan phrase `"i'll forward your details"` + `ARRAY(SELECT DISTINCT UNNEST(...))` dedup for `interested_in_purchasing`
- **AI contact note** — `src/ai/generate.ts:generateContactNote()`: Claude Haiku 4.5, max_tokens=500, generates summary, stored in `contact.ai_note`, written to CRM

### CRM Integrations
- **HubSpot** — `src/crm/adapter.ts:writeHubspot()`: fields via PATCH, notes via POST with contact association
- **Salesforce** — `src/crm/adapter.ts:writeSalesforce()`: Contact PATCH, Task POST
- **GoHighLevel** — `src/crm/adapter.ts:writeGHL()`: tags add/remove separately, notes, fields
- **FollowUpBoss** — `src/crm/adapter.ts:writeFollowUpBoss()`: GET existing tags → merge → PUT, notes via POST
- **Generic** — `src/crm/adapter.ts:writeGeneric()`: POST to `crm_callback_url` with `X-IAE-Secret`
- **Normalizer** — `src/crm/normalizer.ts:normalizeWebhook()`: HubSpot, Salesforce, GHL (alias: ghl), FUB (alias: fub), Generic

### Channels
- **WhatsApp template send** — `src/channels/whatsapp.ts:sendWhatsAppTemplate()`: Meta Graph API v19.0, 15s timeout
- **WhatsApp freeform send** — `src/channels/whatsapp.ts:sendWhatsAppMessage()`: 15s timeout
- **SMS send** — `src/channels/sms.ts:sendSmsMessage()`: Twilio REST API, form-encoded, 15s timeout

### Reporting
- **Live dashboard** — `src/reports/dashboard.ts:updateDashboard()`: Google Sheets, 9 pipeline categories with colour coding, auto-creates spreadsheet if `dashboard_sheet_id` is null, deletes legacy "Contact Notes" tab
- **Weekly report (Sheets)** — `src/reports/weekly-report.ts:buildWeeklyReport()`: "Weekly Report" tab in same spreadsheet as dashboard, 10 columns, dropdown validation on Outcome, conditional formatting, zebra striping
- **Weekly report (Email)** — `src/reports/weekly-report.ts:sendWeeklyReport()`: Gmail SMTP via nodemailer, styled HTML email with link to sheet, fires every Monday 9am Johannesburg

### Admin Endpoints
- `GET /health` — liveness check
- `GET /admin/clients` — list all clients
- `POST /admin/clients` — create or update client record
- `GET /admin/contacts/:id` — contact detail view
- `POST /admin/contacts/:id/force-send` — bypass rate limits, send first message immediately
- `POST /admin/contacts/:id/force-followup/:type` — manually trigger followup1/2/3 or bump
- `POST /admin/contacts/:id/reset-loop` — reset loop counter to 0
- `POST /admin/report/send` — manually trigger weekly report
- `POST /admin/dashboard/refresh/:clientId` — manually refresh dashboard

---

## Section 2 — In Progress

Items that exist in code but are not fully complete.

### Twilio Webhook Signature Verification
- **File:** `src/index.ts` — function `verifyTwilioSignature()`
- **Status:** Stub — always returns `true`. Has TODO comment: "npm install twilio → use twilio.validateRequest()"
- **What's missing:** Install `twilio` package, implement `twilio.validateRequest(url, authToken, params, signature)` using `TWILIO_AUTH_TOKEN`
- **Impact:** Any HTTP client can currently send fake inbound SMS payloads to the server

### Weekly Report Email Recipients
- **File:** `src/reports/weekly-report.ts` — `REPORT_EMAIL`, `FROM_EMAIL` constants
- **Status:** Now correctly reads from env (`REPORT_EMAIL`, `FROM_EMAIL`, `GMAIL_APP_PASSWORD`). Env values still point to development addresses.
- **What's missing:** Update `.env` on the VPS with the real production email addresses

### Meta WhatsApp Templates
- **Files:** `clients` table — `wa_bump_template_names`, `wa_followup1/2/3_template_name`, `wa_reach_back_out_template_name`; `src/queue/scheduler.ts` — all queue processors reference these
- **Status:** Code fully supports templates. None submitted to Meta yet.
- **What's missing:** Submit and get approval in Meta Business Manager for: `bump_1`, `bump_2`, `bump_3`, `bump_close`, `reach_back_out`, `followup1`, `followup2`, `followup3` — then update client record via `POST /admin/clients`

### `reach_back_out_message_template` on Client Record
- **File:** `clients` table — column exists with a default value
- **Status:** Default value set, but production copy not configured for `realtor_of_excellence`
- **What's missing:** Call `POST /admin/clients` with the correct template text

### `buildEmailSummary()` Dead Code
- **File:** `src/reports/weekly-report.ts` lines 296–402
- **Status:** Fully implemented HTML email body builder — never called in `sendWeeklyReport()`
- **What's missing:** Decision needed: either wire it into `sendWeeklyReport()` as the email body, or delete it

---

## Section 3 — Pending

Items referenced or designed but not yet built. Complexity: Small (<2h) / Medium (half day) / Large (1–3 days).

### Twilio Signature Verification *(Small)*
Full implementation of `verifyTwilioSignature()` in `src/index.ts`. Install `twilio` package, call `twilio.validateRequest()`.

### Permanent WhatsApp Access Token *(Small — external action required)*
Current `wa_access_token` on `realtor_of_excellence` client is a 24-hour test token. Requires SIM card verification of Meta Business Manager to generate a System User token set to never expire. No code changes — update client record only.

### Email Notification Channel *(Medium)*
`src/workflows/inbound-reply-handler.ts:sendNotification()` handles `channel = 'email'` with a TODO. `nodemailer` is already installed. Implement using the same Gmail SMTP config as the weekly report (`FROM_EMAIL`, `GMAIL_APP_PASSWORD`).

### In-Memory Rate Limiting → Persistent Storage *(Medium)*
`src/workflows/outbound-first-message.ts`: `dailyCounts` and `lastSentAt` Maps are in-memory and reset on server restart. Move to the `clients` table (add `daily_count`, `daily_count_date`, `last_sent_at` columns) or a dedicated DB table so limits survive restarts.

### Agent Q&A Relay *(Large)*
Full design in `to-do-list/tomorrow.md`. When Claude can't answer a lead's question, relay it to the human agent for a response that can optionally be appended to the FAQ in `skills/prompts/conversation.txt`.

New components required:
1. New Claude tool: `ask_agent` in `src/ai/generate.ts`
2. New tag: `awaiting_agent_answer`
3. New schema: column or table to store pending questions
4. Inbound handler modification in `src/workflows/inbound-reply-handler.ts`: detect agent reply, forward to lead, remove tag
5. "APPROVE" command → append Q&A pair to `skills/prompts/conversation.txt`

Files to modify: `src/db/schema.sql`, `src/ai/generate.ts`, `src/workflows/inbound-reply-handler.ts`, `src/workflows/ai-send-router.ts`, `skills/prompts/conversation.txt`, `src/utils/types.ts`

### Full Flow Test *(Small — verification only)*
The to-do list flags that something went wrong in the previous session. Confirm the end-to-end flow works before trusting the system in production. See `to-do-list/tomorrow.md` for checklist.

---

## Section 4 — Known Issues

| # | Issue | File + Location | Severity |
|---|-------|----------------|---------|
| 1 | **Gmail App Password was hardcoded in source** | `src/reports/weekly-report.ts` lines 43–45 | ~~Critical~~ **Fixed 2026-04-12** — moved to `GMAIL_APP_PASSWORD` env var. **Action required:** Rotate the app password if this repo was ever pushed publicly. |
| 2 | **`TAG_TO_OUTCOME` bug** — key was `'interested_purchasing'` instead of `'interested_in_purchasing'`; "Interested in Buying" never appeared in Weekly Report sheet | `src/reports/weekly-report.ts` line 62 | ~~High~~ **Fixed 2026-04-12** |
| 3 | **`buildEmailSummary()` is dead code** — fully implemented but never called anywhere | `src/reports/weekly-report.ts` lines 296–402 | Low — no runtime impact |
| 4 | **Twilio signature verification not implemented** — `verifyTwilioSignature()` always returns `true` | `src/index.ts` function `verifyTwilioSignature()` | High — fake SMS payloads accepted |
| 5 | **Rate limiting counters not persisted** — `dailyCounts` and `lastSentAt` Maps reset on every server restart, allowing >50 msgs/day if server restarts mid-day | `src/workflows/outbound-first-message.ts` top of file, `dailyCounts` and `lastSentAt` declarations | Medium |
| 6 | **`setup-values.txt` contains live WhatsApp credentials** — `wa_phone_number_id`, `wa_access_token`, `wa_business_account_id` in plaintext | `setup-values.txt` root of project | High — **delete this file immediately** |
| 7 | **Weekly report email footer hardcodes "Cameron Britt" and `hyperzenai.com`** — wrong branding for client-facing delivery | `src/reports/weekly-report.ts` lines 433–467 | Medium — functional but wrong for production |
| 8 | **Dashboard shares new sheets with hardcoded email** — `cameron@hyperzenai.com` hardcoded as the `writer` share recipient when creating a new Google Sheet | `src/reports/dashboard.ts` line 77 | Low — won't break functionality |
| 9 | **`msUntilNextWorkingWindow()` uses brute-force minute loop** — up to 20,160 iterations (14 days × 24h × 60min) to find next working window | `src/utils/working-hours.ts` line 38 | Low — not in hot path, runs once per scheduler tick |
| 10 | **`client_001` orphan DB record** — noted in `reminders.md` as needing deletion (checklist says done, worth confirming) | Database, `reminders.md` | Low |
| 11 | **`setup-values.txt` says to delete itself after setup** — has not been deleted | `setup-values.txt` line 6: "REMINDER: Delete this file..." | High — see issue #6 above |
