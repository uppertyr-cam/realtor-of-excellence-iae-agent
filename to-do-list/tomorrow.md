# Tomorrow's To-Do

## Your Side — Meta Templates to Create

In Meta Business Manager → WhatsApp → Message Templates, create and submit these for approval:

| Template name | Used for |
|---|---|
| `bump_1` | 24h no-reply bump |
| `bump_2` | 48h no-reply bump |
| `bump_3` | 72h no-reply bump |
| `bump_close` | 73h conversation close-out |
| `reach_back_out` | Scheduled re-contact |
| `followup1` | Day 7 drip follow-up |
| `followup2` | Day 14 drip follow-up |
| `followup3` | Day 21 drip follow-up |

Once approved, update the `realtor_of_excellence` client record via `POST /admin/clients` with the approved template SIDs/names.

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

## Code Side — Agent Q&A Relay with Prompt Learning

When a lead asks a question Cameron can't answer, instead of deflecting, relay it to the agent:

1. New Claude tool `ask_agent` — AI calls this instead of routing to senior_team_member
2. System pauses lead conversation, tags `awaiting_agent_answer`, stores the question
3. Agent receives notification with the question via WhatsApp to business number
4. Agent replies → system forwards answer to lead, removes await tag
5. Agent replies "APPROVE" → system appends Q&A to `prompts/conversation.txt` FAQ section
6. Next time someone asks that question, AI answers from FAQ without calling `ask_agent`

**Files to modify:** `src/db/schema.sql`, `src/ai/generate.ts`, `src/workflows/workflow-01.ts`, `src/workflows/workflow-02.ts`, `prompts/conversation.txt`, `src/utils/types.ts`

See full plan at `/Users/phone121212/.claude/plans/curried-scribbling-diffie.md`

---

## Your Side — Permanent WhatsApp API Token

The current `wa_access_token` on the `realtor_of_excellence` client is a 24-hour test token. To get a permanent one:

1. In Meta Business Manager, go to **Business Settings → Users → System Users**
2. Create a System User (or use an existing one) with **Admin** role
3. Assign the WhatsApp Business Account asset to that system user
4. Generate a token — select the `whatsapp_business_messaging` and `whatsapp_business_management` permissions
5. Set the token to **never expire**
6. Update the client record via `POST /admin/clients` with the new `wa_access_token`

Note: This requires the Business Manager to be fully verified. If it's still pending SIM card verification, that needs to be done first.

---

## Cleanup Tasks

- [ ] Set `reach_back_out_message_template` on `realtor_of_excellence` client via `POST /admin/clients`
- [ ] Fix missing `followup1_sent_at` DB column — add to `src/db/schema.sql` + run migration
- [ ] Change weekly report email in `src/reports/weekly-report.ts` (currently `cameronbritt111@gmail.com`)
- [ ] Delete orphan `client_001` DB record

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
