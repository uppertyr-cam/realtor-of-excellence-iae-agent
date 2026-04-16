# Workflow: IAE-00 — Outbound First Message

## Objective
When a new contact is pushed into the system via the CRM webhook, validate their WhatsApp number, add them to the outbound queue, and send the first message respecting working hours, daily send limits, and send intervals.

## File
`src/workflows/outbound-first-message.ts`

## Trigger
`POST /webhook/crm` — authenticated via `x-iae-secret` header

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js / TypeScript on Contabo VPS |
| Database | Supabase (PostgreSQL) |
| Messaging | Meta WhatsApp Business API / Twilio SMS |
| Scheduler | In-process scheduler (`src/queue/scheduler.ts`) — ticks every 60s |
| CRM | GoHighLevel (or configured CRM type) |

---

## Required `.env` Variables

| Variable | Purpose |
|---|---|
| `INTERNAL_WEBHOOK_SECRET` | Authenticates incoming CRM webhooks via `x-iae-secret` header |
| `DATABASE_URL` | Supabase Postgres connection |
| `META_APP_SECRET` | Meta WhatsApp webhook verification |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | SMS fallback sending |

Client-specific credentials (WA Phone Number ID, access token, templates) are stored in the `clients` table, not `.env`.

---

## Steps

### On Webhook Receipt

1. Authenticate — verify `x-iae-secret` header matches `INTERNAL_WEBHOOK_SECRET`
   - FAIL → return 401, stop
2. Validate body — must include `contact_id`, `phone_number`, `client_id`
   - FAIL → return 400, stop
3. Normalise payload — `normalizeWebhook(rawPayload, crmType)` → `InboundWebhook`
4. Load client config — `getClientConfig(client_id)` (5-min in-memory cache)
5. Duplicate check — if contact already exists in `contacts` table → return 200, **stop silently**
6. Upsert contact — write to `contacts` table with `workflow_stage = 'pending'`
7. Validate WhatsApp number *(only if channel = `whatsapp` or `whatsapp_sms_fallback`)*
   - Iterate `phone_numbers[]` in order; use first that validates via Meta API
   - All fail + `whatsapp_sms_fallback` → fall back to SMS channel
   - All fail + `whatsapp` only → log warning, continue (send will fail at delivery)
8. Queue first message — `INSERT INTO outbound_queue (message_type='first_message', status='pending', scheduled_at=NOW())`
9. Return 200 — workflow continues asynchronously via scheduler

---

### Scheduler: `processDripQueue()` — every 60 seconds

1. **Working hours check** — `isWithinWorkingHours(config)` using client timezone + configured days/hours
   - Outside → skip entire tick
2. **Daily send limit check** — in-memory counter per client (default: 50/day)
   - At or over limit → skip until tomorrow
   - ⚠️ Counter resets to 0 on server restart
3. **Send interval check** — in-memory timestamp per client (default: 10 min between sends)
   - Too soon → skip this tick
   - ⚠️ Resets on server restart
4. **Get next contact** — `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` where `status='pending'` and `scheduled_at <= NOW()`
5. **Send first message** → `sendFirstMessage(job, config)`

---

### `sendFirstMessage()` — internal

1. Load contact from DB
2. Personalise template — substitute `{{first_name}}`, `{{last_name}}`, `{{phone_number}}` in `config.first_message_template`
3. Send via channel (priority order):
   - WA template name configured → `sendWhatsAppTemplate()`
   - channel = `whatsapp` → `sendWhatsAppMessage()`
   - channel = `sms` → `sendSmsMessage()`
4. Retry wrapper — 3 attempts with backoff: **1s → 2s → 4s**

**ON FAILURE:**
- Mark queue job `status='failed'`
- Tag contact `send_failed`, set `workflow_stage = 'closed'`
- Write failure note to CRM
- 🧑 **Human must follow up manually**

**ON SUCCESS:**
- Mark queue job `status='sent'`
- Set `workflow_stage = 'active'`, `first_message_at = NOW()`
- Add tags: `first_message_sent`, `database_reactivation`
- Store sent message in `contact.ai_memory` and `contact.first_message_sent`
- Write CRM callback with tags + create opportunity (if `pipeline_id` configured)
- Schedule follow-ups:
  - `followup1` → NOW() + 7 days
  - `followup2` → NOW() + 14 days
  - `followup3` → NOW() + 21 days

---

## Admin Override

Force-send a contact immediately, bypassing all rate limits:

```
POST /admin/contacts/:id/force-send
```

- Bypasses working hours, daily limit, and send interval
- Requires a `pending` first_message job to exist for the contact
- Returns 400 if no pending job found

---

## Edge Cases

| Problem | Fix |
|---|---|
| Contact not being sent despite being in queue | Check working hours config for the client. Check daily limit (resets at midnight local time). Check send interval (10 min gap). All in `clients` table. |
| WhatsApp number validation failing for valid numbers | The number may not have WhatsApp. If `whatsapp_sms_fallback` is configured, SMS will be used automatically. |
| `send_failed` tag on contact | First message failed after 3 retries. Check `outbound_queue` for `error` column. Follow up manually or re-queue by resetting `status='pending'`. |
| Daily counter not resetting | Counter is in-memory — resets on server restart. A server crash at 11:59pm could cause it to carry over. Restart PM2 if needed. |
| Duplicate contact silently rejected | Expected behaviour — the system will not reprocess a contact already in the `contacts` table. To re-run, delete the contact row from the DB. |

---

## Notes
- The 200 response is returned immediately after queueing — the actual send is async via the scheduler.
- The send interval and daily count are in-memory, not in the DB. They do not survive server restarts.
- `force-send` is the correct tool to use when manually testing a new contact or when a client asks for an immediate send.
- Client config (templates, working hours, limits) is read from the `clients` table — never hardcoded.
