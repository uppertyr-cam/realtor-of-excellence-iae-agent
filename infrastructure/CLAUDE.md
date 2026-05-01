# infrastructure/

Deployment scripts and integrations registry.

## Files

| File | What it contains |
|------|-----------------|
| `connections.md` | All external platform integrations — platform, purpose, env var names, source files, status |
| `deploy.sh` | VPS deployment script |

---

## Deploy Procedure

VPS credentials are in `.env` under `VPS_IP`, `VPS_USER`, `VPS_PASSWORD`, `VPS_APP_DIR` — check there first, never ask the user to repeat them.

Deploy using `expect` (not `sshpass` — not installed). The VPS uses key auth so SSH won't prompt for a password:

```
expect -c "
spawn ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_IP
expect \"\\\$\"
send \"cd $VPS_APP_DIR && git pull && npm run build && pm2 restart iae-agent\r\"
expect \"\\\$\"
send \"exit\r\"
expect eof
"
```

---

## Environment Variables

| Variable | Purpose | Status |
|---|---|---|
| `DATABASE_URL` | Supabase/Postgres connection string | ✅ Set |
| `ANTHROPIC_API_KEY` | Claude API key for AI generation | ✅ Set |
| `META_APP_SECRET` | Meta webhook signature verification | ✅ Set |
| `META_VERIFY_TOKEN` | Meta webhook challenge token | ✅ Set |
| `TWILIO_ACCOUNT_SID` | Twilio SMS account ID | ✅ Set (example values) |
| `TWILIO_AUTH_TOKEN` | Twilio SMS auth token | ✅ Set (example values) |
| `TWILIO_FROM_NUMBER` | Twilio SMS sender number | ✅ Set (example values) |
| `INTERNAL_WEBHOOK_SECRET` | Internal webhook auth secret | ✅ Set |
| `GOOGLE_CLIENT_ID` | Google Sheets OAuth client ID | ✅ Set |
| `GOOGLE_CLIENT_SECRET` | Google Sheets OAuth secret | ✅ Set |
| `GOOGLE_REFRESH_TOKEN` | Google Sheets refresh token | ✅ Set |
| `VPS_IP` | Contabo VPS IP address | ✅ Set in .env |
| `VPS_USER` | Contabo VPS username | ✅ Set in .env |
| `VPS_PASSWORD` | Contabo VPS password | ✅ Set in .env |
| `VPS_APP_DIR` | Contabo VPS app directory | ✅ Set in .env |
| `GITHUB_PAT` | GitHub PAT for VPS deploy pulls | ✅ Set in .env |
| `ALERT_EMAIL` | Destination for [IAE Alert] error emails (falls back to REPORT_EMAIL) | ✅ Set |
| `FROM_EMAIL` | Gmail address weekly report is sent from | ✅ Set |
| `REPORT_EMAIL` | Gmail address weekly report is sent to | ✅ Set |
| `GMAIL_APP_PASSWORD` | Gmail App Password for weekly report sender | ✅ Set |
| `NOTIFICATION_FROM_EMAIL` | From address for internal lead notification emails | ✅ Set |
| `NOTIFICATION_APP_PASSWORD` | Optional dedicated app password for notification emails, falls back to `GMAIL_APP_PASSWORD` | ✅ Set |
| `NOTIFICATION_TEST_TO` | Override recipient for internal lead notification tests | ✅ Set |
| `NOTIFICATION_CC_EMAIL` | CC address on all lead notification emails (e.g. UpperTyr internal) | ✅ Set |
| `NOTIFICATION_TO_QUALIFIED` | Comma-separated recipient list for buyer_qualified / interested_in_purchasing notifications | ✅ Set |
| `NOTIFICATION_TO_CLOSED` | Comma-separated recipient list for not_interested / already_purchased notifications | ✅ Set |
| `GOOGLE_SHEETS_SHARE_EMAIL` | Google account granted write access to newly created dashboard sheets | ✅ Set |
