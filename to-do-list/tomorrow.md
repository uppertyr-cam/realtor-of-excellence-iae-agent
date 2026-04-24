# Tomorrow's To-Do

## Your Side — Meta Templates to Create

In Meta Business Manager → WhatsApp → Message Templates, create and submit these for approval:

| Template name | Used for | Status |
|---|---|---|
| `first_message` | Initial database reactivation outreach | ✅ Submitted |
| `followup1` | Day 7 drip follow-up | ✅ Submitted |
| `followup2` | Day 14 drip follow-up | ✅ Submitted |
| `followup3` | Day 21 drip follow-up | ✅ Submitted |
| `bump_1` | 24h no-reply bump | ⏳ Submitted — awaiting approval |
| `bump_2` | 48h no-reply bump | ⏳ Submitted — awaiting approval |
| `bump_3` | 72h no-reply bump | ⏳ Submitted — awaiting approval |
| `reach_back_out` | Scheduled re-contact | ⏳ Submitted — awaiting approval |

Note: `bump_close` needs no template — it only writes a CRM note, no message is sent.

Once bump_1/2/3 approved, share the exact template names and Claude will update `wa_bump_template_names` on the `realtor_of_excellence` client via `POST /admin/clients`.

Once `bump_1/2/3` and `reach_back_out` approved:
- Set `wa_bump_template_names` on `realtor_of_excellence` client via `POST /admin/clients` (nested array — bump index maps to template name)
- Set `wa_reach_back_out_template_name: "reach_back_out"` on `realtor_of_excellence` client via `POST /admin/clients`
- Set `agent_name` on `realtor_of_excellence` client via `POST /admin/clients` (used as `{{2}}` in reach-back-out WA template)
- Run `npm run db:migrate` on VPS to add `agent_name` column

---

## Your Side — Twilio Regulatory Bundle

- [ ] Wait for Twilio regulatory bundle approval
- [ ] Once approved: buy a South African number on Twilio
- [ ] Verify the Twilio number on Meta (register it as a WhatsApp Business number)
- [ ] Update `wa_phone_number_id` on `realtor_of_excellence` client via `POST /admin/clients`
- [ ] Re-enable `wa_first_message_template_name` and other template names on the client

---

## Code Side — One-Off Config Updates (do once, then done)

Run these POST /admin/clients calls after deploy:

```
# Activate workflow-based prompt routing for database reactivation
POST https://api.uppertyr.com/admin/clients
{ "id": "realtor_of_excellence", "workflow_prompts": { "ai_database_reactivation": "prompts/conversation.txt" } }

# Activate agent question relay template (once lead_question_relay approved by Meta)
POST https://api.uppertyr.com/admin/clients
{ "id": "realtor_of_excellence", "agent_question_template": "lead_question_relay" }
```

---

## Code Side — Follow Up Boss CRM Integration

Files to edit: `src/crm/normalizer.ts`, `src/crm/adapter.ts`

- Add `followupboss` / `fub` case to normalizer (map `firstName`, `phones[0].value`, etc.)
- Add `writeFollowUpBoss()` to adapter
  - Auth: HTTP Basic — API key as username, empty password
  - Update contact + merge tags: `PUT /people/{id}` (fetch existing tags first, then merge)
  - Notes: `POST /notes` with `{ personId, body }`
- After deploy: update `realtor_of_excellence` client with `crm_type: "followupboss"` + FUB API key
- **TODO: Add FUB API key to `.env`** — get key from Follow Up Boss (Admin → API) and add as `FUB_API_KEY=...`, then set on client record via `POST /admin/clients`
- **Known issue: FUB contacts created via API have no `crm_callback_url`** — CRM writes currently log a warning and continue. Fix: store the FUB contact ID at upsert and construct the callback URL from it.

---

## Code Side — Bug Fix: Duplicate AI Messages in ai_memory

Each AI reply is currently stored twice in `ai_memory` (once in IAE-01, once in IAE-02). Needs investigation and fix in `src/workflows/inbound-reply-handler.ts` and `src/workflows/ai-send-router.ts`.

---

## Code Side — Agent Q&A Relay with Prompt Learning ✅ DONE

**Pending — once Meta approves template `lead_question_relay` (~24h):**
Run this to activate it:
```
POST https://api.uppertyr.com/admin/clients
x-iae-secret: uppertyr-ai-secret-2026
Content-Type: application/json

{ "id": "realtor_of_excellence", "agent_question_template": "lead_question_relay" }
```

---

## Your Side — Permanent WhatsApp API Token ✅ DONE

Permanent System User token saved to DB. Two future swaps needed:

- [ ] **Switch to real phone number** — when a production WhatsApp Business number is ready, update `wa_phone_number_id` on the `realtor_of_excellence` client via `POST /admin/clients`
- [ ] **Verify token scope** — confirm the System User token was generated against the production app (not just the test app). If a new Meta app is ever created, a new token will be needed.

---

## Cleanup Tasks

- [x] Reach-back-out AI generation implemented — `generateReachBackOutMessage()` in `src/ai/generate.ts`, wired into `scheduler.ts`
- [x] Bump AI generation implemented — `generateBumpMessage()` in `src/ai/generate.ts`, wired into `bump-handler.ts`
- [x] Fix missing `followup1_sent_at` DB column — resolved by using `workflow_stage` instead of timestamp columns
- [x] Tracking improvements — 9 new DB columns, token tracking, delivery receipts, CRM failure counter, DB-persisted rate limiting, Google Sheets metrics tabs (Weekly/Monthly/4M/8M/Yearly)
- [x] setTimeout overflow fixed in monthly/yearly schedulers — capped at 24h to avoid 32-bit wrap
- [x] Test phone bypass — +27761536498 skips working hours and rate limits for first message
- [x] workflow_prompts tag-based prompt routing — inbound replies now load the correct prompt per workflow
- [x] ai_database_reactivation tag — applied at upsert, post-send, and CRM write
- [ ] Change weekly report email in `src/reports/weekly-report.ts` (currently `cameronbritt111@gmail.com`)
- [ ] Update `ALERT_EMAIL` in VPS `.env` when ready to redirect error alerts to a different address — currently falls back to `cameronbritt111@gmail.com`
- [ ] Add Agent Question number — set `stage_agents.default.target` on `realtor_of_excellence` client via `POST /admin/clients` once the agent's WhatsApp number is confirmed
- [ ] Update `first_message_template` on client — currently says "Cameron", confirm persona name (Sarah) then update via `POST /admin/clients`
- [x] Delete orphan `client_001` DB record — done

---

## Testing — Full Conversation Flow
- [x] Create test contact with real phone number
- [x] Send first message from CRM webhook
- [x] Simulate inbound reply from test contact
- [x] Verify AI response generates and sends
- [x] Check keyword detection works (not_interested tested — voucher links confirmed)
- [ ] Verify bump scheduling and reach-back-out scheduling end-to-end
- [ ] Check database state throughout a full multi-day drip sequence

## Verification Steps
1. Deploy code + run `npm run db:migrate` on VPS ✅ Done
2. Update `realtor_of_excellence` client with FUB credentials (pending FUB integration)
3. Set `workflow_prompts` on `realtor_of_excellence` client (see config updates section above)
4. Trigger a reach-back-out test — confirm message fires at scheduled time, bumps queue after
