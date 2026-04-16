# The Three Workflows

## Workflow 00 — Conversational Starter (outbound)
**File:** `src/workflows/outbound-first-message.ts`
**Triggered by:** `POST /webhook/crm`

1. Normalise CRM payload to internal schema
2. Duplicate check — reject if contact already active
3. Validate WhatsApp number via Meta API (if channel = whatsapp)
4. Add contact to drip queue in Postgres
5. Scheduler sends first message respecting: working hours, 50/day limit, 1 per 10 min
6. Post-send: tags contact, writes back to CRM, schedules Follow-ups at 7, 14, and 21 days
7. Follow-up 1 (day 7) → Follow-up 2 (day 14) → Follow-up 3 (day 21) → close out

Also in **Workflow 02**, after every AI send:
- 3 Bumps scheduled at 24h / 48h / 72h — resets every time AI replies
- If no reply after 72h: bump_close fires, writes conversation summary note to CRM, tags `bump_no_reply`
- If lead replies at any point: all pending bumps are cancelled

---

## Workflow 01 — AI Router (inbound)
**File:** `src/workflows/inbound-reply-handler.ts`
**Triggered by:** `POST /webhook/whatsapp` or `POST /webhook/sms`

1. Store message in `message_buffer` table
2. Debounce: wait 5 seconds — if more messages arrive, reset timer
3. Only the LAST message's timer fires — collect ALL buffered messages, concatenate
4. Acquire DB lock on contact (prevents race conditions)
5. Increment loop counter — auto-reset if 24hr gap since last reply
6. Route based on contact tags:
   - `first_message_sent` → swap to `second_message` → go to AI
   - `second_message` → swap to `multiple_messages` → go to AI
   - `manual_takeover` → notify agent → END
   - loop counter > max → remove reply_generating tag → END
   - default → generate AI response
7. AI generation: read prompt file fresh from disk + inject lead data + call Claude API
8. Store AI response in `ai_responses` table
9. Trigger Workflow 02 inline
10. Release DB lock

---

## Workflow 02 — Send + Keyword Detection
**File:** `src/workflows/ai-send-router.ts`
**Triggered by:** Workflow 01 calling `handleAIResponseReady(contactId)`

1. Remove `reply_generating` tag
2. Check if AI response contains "Goodbye" — if yes: killswitch (tag, note, clear fields, END)
3. Send AI message via WhatsApp or SMS (3x retry with backoff)
4. Update AI memory in DB + add note to CRM
5. Detect keywords in AI response:
   - `not interested` → pipeline: Not Interested
   - `renting` → pipeline: Interested in Renting
   - `I'll reach back out` → pipeline: Reach Back Out — inserts `reach_back_out` row into `outbound_queue` with `scheduled_at` from Claude tool call
   - `senior team member` → pipeline: Over to Senior + notify agent + manual takeover tag
   - `interested in purchasing` → pipeline: Interested in Purchasing
   - `already purchased` → pipeline: Already Purchased
   - none → clear fields (bump workflow handles next follow up)

## Scheduler — Reach Back Out
When a `reach_back_out` row in `outbound_queue` reaches its `scheduled_at` time:
1. Skip if contact has `manual_takeover` tag or `workflow_stage` is closed/completed
2. Send `reach_back_out_message_template` (from `clients` table) with `{{first_name}}` substituted
3. On success: tag contact `reach_back_out_sent`, write CRM note, log to `message_log`, fire dashboard update
4. Schedule 3 bumps (24h/48h/72h) + bump_close (73h) — same pattern as after every AI reply
5. Dashboard shows contact under "Lead Responded" once `reach_back_out_sent` tag is present

If lead replies before the scheduled time, the `reach_back_out` queue row is cancelled automatically (Workflow 01 inbound handler).
