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

## Code Side — Follow Up Boss CRM Integration

Files to edit: `src/crm/normalizer.ts`, `src/crm/adapter.ts`

- Add `followupboss` / `fub` case to normalizer (map `firstName`, `phones[0].value`, etc.)
- Add `writeFollowUpBoss()` to adapter
  - Auth: HTTP Basic — API key as username, empty password
  - Update contact + merge tags: `PUT /people/{id}` (fetch existing tags first, then merge)
  - Notes: `POST /notes` with `{ personId, body }`
- After deploy: update `realtor_of_excellence` client with `crm_type: "followupboss"` + FUB API key
- **TODO: Add FUB API key to `.env`** — get key from Follow Up Boss (Admin → API) and add as `FUB_API_KEY=...`, then set on client record via `POST /admin/clients`

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
- [ ] Change weekly report email in `src/reports/weekly-report.ts` (currently `cameronbritt111@gmail.com`)
- [ ] Add Agent Question number — set `stage_agents.default.target` on `realtor_of_excellence` client via `POST /admin/clients` once the agent's WhatsApp number is confirmed
- [x] Delete orphan `client_001` DB record — done

---

## Testing — Full Conversation Flow
⚠️ Something went wrong in the previous session. Run a complete test before assuming everything works:
- [ ] Create test contact with real phone number (or use database directly)
- [ ] Send first message from CRM webhook
- [ ] Simulate inbound reply from test contact
- [ ] Verify AI response generates and sends
- [ ] Check keyword detection works
- [ ] Verify bump scheduling and reach-back-out scheduling
- [ ] Check database state throughout

## Verification Steps
1. Deploy code + run `npm run db:migrate` on VPS
2. Update `realtor_of_excellence` client with FUB credentials
3. Trigger a test webhook — confirm note and tags appear in Follow Up Boss contact
4. Trigger a reach-back-out test — confirm message fires at scheduled time, bumps queue after
