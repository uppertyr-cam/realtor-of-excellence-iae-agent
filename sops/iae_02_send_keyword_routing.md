# Workflow: AI Response Send + Keyword Routing

## Objective
After Inbound Reply Handler generates an AI response, send the message to the lead via WhatsApp or SMS, update the CRM, reset the bump clock, and route the contact to the correct pipeline stage based on detected keywords.

## File
`src/workflows/ai-send-router.ts`

## Trigger
Called inline by Inbound Reply Handler — `handleAIResponseReady(contactId, keyword?, scheduledAt?, chatHistory?)`

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js / TypeScript on Contabo VPS |
| Database | Supabase (PostgreSQL) |
| Messaging | Meta WhatsApp Business API / Twilio SMS |
| AI (notes) | Claude Haiku 4.5 — generates CRM contact notes on keyword detection |
| CRM | GoHighLevel (or configured CRM type) |

---

## Steps

1. **Load pending AI response**
   - `SELECT * FROM ai_responses WHERE contact_id AND status='pending' ORDER BY created_at DESC LIMIT 1`
   - NOT FOUND → log warning, return

2. **Remove tag `reply_generating`**

3. **Goodbye killswitch check**
   - If response text contains `"goodbye"` (case-insensitive):
     - Set `workflow_stage = 'closed'`, add tag `goodbye_killswitch`
     - Write CRM callback: clear `trigger_field` and `ai_response` fields
     - Cancel ALL pending `followup`, `bump`, and `bump_close` jobs
     - Fire `updateDashboard()` + `buildWeeklyReport()` (async)
     - **Stop — no message sent**

4. **Sanitise message text**
   - Replace em-dashes (`—`), Cyrillic characters, and non-ASCII characters
   - Prevents encoding failures on WhatsApp/SMS delivery

5. **Send message**
   - Route: `sendWhatsAppMessage()` or `sendSmsMessage()` based on `contact.channel`
   - Retry: **3 attempts**, backoff: **1s → 2s → 4s**

   **ON FAILURE:**
   - Mark `ai_responses` row `status='failed'`
   - Add tag `send_failed`
   - Return

   **ON SUCCESS:**
   - Mark `ai_responses` row `status='sent'`
   - Remove tag `send_failed` (if present from prior attempt)
   - Log to `message_log` (direction='outbound', message_type='ai_reply')

6. **Update AI memory** — append `"AI: {responseText}"` to `contact.ai_memory`

7. **Write CRM callback** — `writeToCrm()` with full `ai_memory` as conversation note

8. **Reset bump clock**
   - Cancel all existing pending `bump` and `bump_close` jobs for this contact
   - Schedule 3 new bumps: +24h, +48h, +72h
   - Schedule `bump_close`: +73h
   - Rotate `bump_variation_index`: `(current + 1) % 3`

9. **Qualifying questions tag**
   - If response text mentions area / property type / price range / bedrooms → add tag `qualifying_questions`

10. **Keyword detection**
    - Primary: use `routedKeyword` passed from Inbound Reply Handler Claude tool call
    - Fallback: `detectKeyword(responseText)` — text scan (see table below)

11. **Handle keyword** → `handleKeyword()`

---

## Keyword Detection

| Phrase in AI response | Keyword |
|----------------------|---------|
| `"not interested"` | `not_interested` |
| `"renting"` | `renting` |
| `"i'll reach back out"` / `"i will reach back out"` | `reach_back_out` |
| `"senior team member"` / `"more senior"` | `senior_team_member` |
| `"interested in purchasing"` / `"want to purchase"` / `"looking to buy"` / `"i'll forward your details"` | `interested_in_purchasing` |
| `"already purchased"` / `"already bought"` | `already_purchased` |
| (none of the above) | `none` |

---

## Keyword Routing

| Keyword | Tags Added | `workflow_stage` | Bumps | CRM | Human |
|---------|-----------|-----------------|-------|-----|-------|
| `not_interested` | `not_interested` | `closed` | Cancel all | Note + tag | — |
| `renting` | `renting`, `manual_takeover` | — | — | Note + tag | 🧑 Notify |
| `reach_back_out` | `reach_back_out` | — | — | Note | — |
| `senior_team_member` | `manual_takeover` | — | Cancel all | Note + tag | 🧑 Notify |
| `interested_in_purchasing` | `interested_in_purchasing`, `manual_takeover`, `qualified` | — | Cancel all | Note + tag | 🧑 Notify |
| `already_purchased` | `already_purchased`, `manual_takeover` | — | Cancel all | Note + tag | 🧑 Notify |
| `none` | — | — | — | Clear `trigger_field` + `ai_response` | — |

**`reach_back_out` extra:** If `scheduledAt` was provided by Claude's `route_lead` tool call, a row is inserted into `outbound_queue` with `message_type='reach_back_out'` and `scheduled_at=scheduledAt`. If `scheduledAt` is missing, no queue entry is created (log warning).

**All non-`none` keywords additionally:**
- `writeContactNote()` — Claude Haiku 4.5 generates a summary → stored in `contact.ai_note` → written to CRM as a note
- Fire `updateDashboard()` + `buildWeeklyReport()` (async)

---

## Edge Cases

| Problem | Fix |
|---|---|
| Message sent but wrong keyword detected | Check if Claude used the `route_lead` tool (primary path) or if `detectKeyword()` fallback fired. Check `ai_responses.response_text` for the exact text. If the phrase doesn't match the table above, it won't be detected. Update `detectKeyword()` in source if needed — also update `prompts/conversation.txt` to keep them in sync. |
| `send_failed` tag on contact after AI generation | The AI response was generated but delivery failed. Check `ai_responses` table for `status='failed'`. Check Meta/Twilio credentials. The response text is stored — manually retry or trigger a re-send. |
| `goodbye_killswitch` fired unexpectedly | The AI response contained the word "goodbye". Review the prompt to ensure Claude is not closing conversations prematurely. Check `ai_responses.response_text` for the row. |
| `reach_back_out` row not appearing in `outbound_queue` | Claude did not provide `scheduledAt` in the `route_lead` tool call. Check `ai_responses.response_text` — the keyword was detected but no date was extracted. Claude's prompt must instruct it to always include a date for this keyword. |
| CRM note not written after keyword | `writeToCrm()` failures are non-fatal — the system logs and continues. Check server logs for CRM API errors. The contact state in the DB is correct regardless. |

---

## Notes
- This workflow is called inline by Inbound Reply Handler — it is not an HTTP endpoint and does not have its own webhook.
- The bump clock resets on **every AI reply**, not just on keyword detection. If a lead keeps replying, bumps never fire.
- `detectKeyword()` and `prompts/conversation.txt` must stay in sync — if you add a new keyword phrase to the prompt, add the matching phrase to `detectKeyword()` in `ai-send-router.ts`.
- The goodbye killswitch is a hard stop — no message is sent when it fires. This is intentional.
