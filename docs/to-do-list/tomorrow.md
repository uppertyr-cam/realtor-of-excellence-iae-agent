# To-Do

## Client Input Required — context/strategy.md

Need the following from Sean Britt / ROE team to complete `context/strategy.md`:

- [ ] Current #1 business objective (e.g. grow listings by X%, convert Y% more buyers)
- [ ] Target markets in priority order (geographic areas, property types)
- [ ] Which service lines are being pushed hardest right now
- [ ] KPI baselines and targets for: Away-from-Desk Autonomy %, Task Automation %, Revenue per Agent
- [ ] Full agent roster (current list in `context/people.md` is placeholder — needs verification)

---

## Your Side — Twilio Regulatory Bundle

- [ ] Wait for Twilio regulatory bundle approval
- [ ] Once approved: buy a South African number on Twilio
- [ ] Verify the Twilio number on Meta (register it as a WhatsApp Business number)
- [ ] Update `wa_phone_number_id` on `realtor_of_excellence` client via `POST /admin/clients`
- [ ] Re-enable `wa_first_message_template_name` and other template names on the client

---

## Your Side — WhatsApp Production Number

- [ ] Switch to real phone number — when a production WhatsApp Business number is ready, update `wa_phone_number_id` on the `realtor_of_excellence` client via `POST /admin/clients`
- [ ] Verify token scope — confirm the System User token was generated against the production app. If a new Meta app is ever created, a new token will be needed.

---

## Code Side — Follow Up Boss CRM Integration

Files to edit: `src/crm/normalizer.ts`, `src/crm/adapter.ts`

- Add `followupboss` / `fub` case to normalizer (map `firstName`, `phones[0].value`, etc.)
- Add `writeFollowUpBoss()` to adapter
  - Auth: HTTP Basic — API key as username, empty password
  - Update contact + merge tags: `PUT /people/{id}` (fetch existing tags first, then merge)
  - Notes: `POST /notes` with `{ personId, body }`
- After deploy: update `realtor_of_excellence` client with `crm_type: "followupboss"` + FUB API key
- **TODO: Add FUB API key to `.env`** — get key from Follow Up Boss (Admin → API)
- **Known issue: FUB contacts created via API have no `crm_callback_url`** — fix: store the FUB contact ID at upsert and construct the callback URL from it

---

## Cleanup

- [ ] Change weekly report email in `src/reports/weekly-report.ts` (currently `cameronbritt111@gmail.com`)
- [ ] Update `ALERT_EMAIL` in VPS `.env` when ready to redirect error alerts to a different address
- [ ] Add Agent Question number — set `stage_agents.default.target` on `realtor_of_excellence` client via `POST /admin/clients` once the agent's WhatsApp number is confirmed

---

## Testing

- [ ] Verify bump scheduling and reach-back-out scheduling end-to-end
- [ ] Check database state throughout a full multi-day drip sequence

---

## Inbox Follow-Up

- [ ] Add an out-of-window WhatsApp template send option in the inbox for conversations outside Meta's 24-hour freeform reply window

---

## 2FA for Inbox Login

The auth.ts 2FA code exists but was removed because the DB columns don't exist yet. To implement properly:

1. Add DB migration — columns needed on `inbox_users`:
   - `two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE`
   - `two_factor_enabled_at TIMESTAMPTZ`
   - `two_factor_secret_enc TEXT` (AES-encrypted TOTP secret)
   - `two_factor_temp_secret_enc TEXT` (during setup flow)
   Columns on `inbox_sessions`:
   - `two_factor_verified BOOLEAN NOT NULL DEFAULT FALSE`
   Add new table: `inbox_login_challenges (id, user_id, expires_at, two_factor_verified)`
2. Add the migration to `src/db/schema.sql` and `src/db/migrate.ts`
3. Restore the 398-line auth.ts (it's in git history at commit `1b21ce3`)
4. Add `/inbox/api/2fa/setup`, `/inbox/api/2fa/verify`, `/inbox/api/2fa/disable` endpoints in `index.ts`
5. Add 2FA setup UI to inbox (`src/inbox/ui.ts`)
- [ ] Implement when ready — requires DB migration first
