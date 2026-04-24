# Workflow: Scheduler — Queue Processors

## Objective
A single in-process scheduler ticks every 60 seconds and processes all queued outbound jobs in order: first messages, follow-ups, bumps, bump closes, and reach-back-outs. Also auto-releases stale DB locks.

## Files
- `src/queue/scheduler.ts` — tick driver, follow-up processor, reach-back-out processor
- `src/workflows/bump-handler.ts` — bump sending (24h/48h/72h), bump close (73h), `scheduleBumps()`, `cancelBumps()`

## Trigger
Starts automatically on server boot via `startScheduler()`. First tick fires after a **2-second startup delay**.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js / TypeScript on Contabo VPS |
| Database | Supabase (PostgreSQL) — `outbound_queue` table |
| Messaging | Meta WhatsApp Business API / Twilio SMS |
| CRM | GoHighLevel (or configured CRM type) |

---

## Tick Order (every 60 seconds)

```
1. processDripQueue()          → Outbound First Message jobs
2. processFollowUpQueue()      → day-7 / day-14 / day-21 follow-ups
3. processBumpQueue()          → 24h / 48h / 72h bump messages
4. processBumpCloseQueue()     → bump_close at 73h
5. processReachBackOutQueue()  → scheduled reach-back-out messages
6. db.releaseStaleLocks()      → force-release locks older than 2 minutes
```

All processors use `FOR UPDATE SKIP LOCKED LIMIT 10` — safe if the server restarts mid-tick.

---

## Queue Processors

### `processFollowUpQueue()` — day 7 / 14 / 21

- Picks up `pending` jobs of type `followup1`, `followup2`, `followup3` where `scheduled_at <= NOW()`
- **Skips contact if:** `workflow_stage` IN (`replied`, `closed`, `completed`) OR tags include `manual_takeover`
- Template: `config.followup1/2/3_message_template` (substitutes `{{first_name}}`, `{{last_name}}`)
- Send priority: WA template → WA freeform → SMS
- **ON SUCCESS:** Update `contact.followup{N}_sent_at`, set `workflow_stage = 'followupN_sent'`, write CRM tag + note, log to `message_log`
- **ON FAILURE:** Mark `status='failed'`, log error

---

### `processBumpQueue()` — 24h / 48h / 72h *(defined in `bump-handler.ts`)*

Bumps are scheduled after every AI reply (AI Response Send + Keyword Routing) and after every reach-back-out send. They are cancelled when the lead replies.

- Picks up `pending` jobs of type `bump` where `scheduled_at <= NOW()`
- **Skips contact if:** `workflow_stage` IN (`replied`, `closed`, `completed`) OR tags include `manual_takeover`
- Template: `config.bump_templates[bump_index][bump_variation_index]` (substitutes `{{first_name}}`, `{{last_message}}` — last AI line from `ai_memory`, truncated to ~120 chars)
- Send priority: WA template → WA freeform → SMS
- **ON SUCCESS:**
  - Increment `bump_index` (advances to next bump group)
  - Rotate `bump_variation_index`: `(current + 1) % 3`
  - Write CRM tag + note, log to `message_log`

---

### `processBumpCloseQueue()` — 73h *(defined in `bump-handler.ts`)*

Fires if no lead reply was received after all 3 bumps.

- Picks up `pending` jobs of type `bump_close` where `scheduled_at <= NOW()`
- **Skips if:** `contact.last_reply_at > job.created_at` (lead replied after bump was scheduled — contact is active)
- Adds tag `bump_no_reply`
- Writes CRM callback with full `ai_memory` as note
- Fires `updateDashboard()` + `buildWeeklyReport()` (async)
- ⚠️ Does **not** send a message — this is a close-out action only

---

### `processReachBackOutQueue()`

Fires when Claude scheduled a reach-back-out for a specific date/time (via `route_lead` tool call in Inbound Reply Handler).

- Picks up `pending` jobs of type `reach_back_out` where `scheduled_at <= NOW()`
- **Skips if:** tags include `manual_takeover` OR `workflow_stage` IN (`closed`, `completed`)
- Template: `config.reach_back_out_message_template` (substitutes `{{first_name}}`, `{{last_name}}`)
- WA template name: `config.wa_reach_back_out_template_name`
- Send priority: WA template → WA freeform → SMS
- **ON SUCCESS:**
  - Add tag `reach_back_out_sent`
  - Write CRM callback + note
  - Log to `message_log`
  - Schedule 3 new bumps (+24h / +48h / +72h) + `bump_close` (+73h) — same pattern as after every AI reply
  - Fire `updateDashboard()` (async)

---

### `db.releaseStaleLocks()` — stale lock cleanup

- Finds contacts where `processing_locked = TRUE` and `processing_locked_at < NOW() - 2 minutes`
- Force-releases: `SET processing_locked=FALSE, processing_locked_at=NULL`
- Prevents contacts getting permanently stuck if a server crash occurred mid-processing

---

### Weekly Report Scheduler

- Runs once at startup — calculates milliseconds until next **Monday 09:00 Africa/Johannesburg**
- Fires: `sendWeeklyReport()` → `buildWeeklyReport()` (Google Sheets update) + Gmail SMTP send
- Immediately reschedules itself for the following Monday after firing

Required `.env` variables for weekly report:

| Variable | Purpose |
|---|---|
| `FROM_EMAIL` | Gmail address the report is sent from |
| `REPORT_EMAIL` | Gmail address the report is sent to |
| `GMAIL_APP_PASSWORD` | Gmail App Password for the sender account |

---

## Human Intervention Points

| Trigger | What happens |
|---------|-------------|
| First message send fails (3 retries) | CRM note written — human must follow up manually |
| AI generation fails (3 retries) | `notifyStageAgent()` alert sent to agent |
| Voice note download/transcription fails | `notifyStageAgent()` alert sent to agent |
| `manual_takeover` tag on inbound reply | `notifyStageAgent()` — agent takes over |
| `renting` / `senior_team_member` / `interested_in_purchasing` / `already_purchased` keyword | `notifyStageAgent()` + CRM tag |
| Loop counter exceeded (`loop_counter > max`) | Contact stops silently — no notification. Review via CRM or dashboard. |

---

## Edge Cases

| Problem | Fix |
|---|---|
| Follow-ups not sending | Check `outbound_queue` for the job — confirm `status='pending'` and `scheduled_at <= NOW()`. Check contact's `workflow_stage` and tags — contacts in `closed`/`completed` or with `manual_takeover` are skipped. |
| Bumps firing even though lead replied | Check `last_reply_at` on the contact. If the lead replied after the bump was scheduled, the `processBufferedMessages()` step in Inbound Reply Handler should have cancelled pending bumps. If not cancelled, check for a DB lock issue at the time of reply. |
| `bump_close` fired but lead did reply | The `last_reply_at > job.created_at` guard should have skipped it. If it fired incorrectly, check the timestamps on the contact and the queue job. |
| Reach-back-out not firing on scheduled date | Check `outbound_queue` for a row with `message_type='reach_back_out'` and `status='pending'`. If no row exists, Claude did not provide `scheduledAt` in the tool call. If the row exists but is not firing, check `scheduled_at` value and server timezone. |
| Weekly report not sending | Check `FROM_EMAIL`, `REPORT_EMAIL`, `GMAIL_APP_PASSWORD` are set in `.env`. Gmail App Password must be generated from Google Account → Security → App Passwords (not the account password). |
| Stale lock not auto-releasing | `releaseStaleLocks()` runs every 60s — wait up to 2 minutes. If still stuck, manually run: `UPDATE contacts SET processing_locked=FALSE, processing_locked_at=NULL WHERE id='...'` |

---

## Notes
- All queue processors use `LIMIT 10` per tick — high-volume batches are spread across multiple ticks (one tick per minute).
- The bump variation index cycles through 3 variations (0 → 1 → 2 → 0) to avoid sending the same bump message every time.
- CRM write failures are non-fatal — the system logs and continues. Contact state in the DB is always the source of truth.
- The scheduler does not restart itself — it is kept alive by PM2 on the VPS. If the process dies, the scheduler stops until PM2 restarts it.
