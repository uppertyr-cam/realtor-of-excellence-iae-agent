# Last Session Summary — 2026-05-05

## Completed

- Fixed blank inbox page: `\n` escape bug in `buildInboxHtml()` delete contact confirm dialog
- Fixed sidebar scrolling (wheel event hijack removed)
- `non_whatsapp_number` contacts now hidden from inbox sidebar (filtered in queries.ts)
- CRM re-entry: blocked if same phone number, allowed if number changed (tag stripped on re-entry)
- Charmaine gets styled HTML email (`noNumberEmail()`) when contact has no valid WhatsApp number — fires automatically on first message failure and on manual mark-no-number
- Weekly report duplicate guard — checks email_log before sending, only fires once per Monday
- Working hours corrected to 08:00–18:00 Africa/Johannesburg (was incorrectly 00:00–23:59)
- Google Sheets refreshed manually
- Confirmed 9 active contacts from bulk import, 0 replies received yet
- 2FA confirmed removed permanently

## Message Sequence (do not forget)
1. First message — on webhook
2. Follow-ups (Day 7 / 14 / 21) — if no reply after first message
3. Bumps (24h / 48h / 72h) — after contact has replied but gone quiet again

## Pending

- **Week 2**: change bulk-import `daily_limit` from 5 → 10
- **NOTIFICATION_APP_PASSWORD** — empty, verify notification emails (qualified/renting/closed) are working
- **Twilio regulatory bundle** — waiting for approval, SMS not live yet
