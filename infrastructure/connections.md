# Connections

This file is the single reference registry for external platforms connected to the system. For full maintenance notes, setup detail, and troubleshooting procedures, use [docs/platforms-and-services.md](/Users/phone121212/Library/CloudStorage/OneDrive-Personal/UpperTyr/Clients%20Claude%20Projects/Realtor%20Of%20Excellence%20Project/docs/platforms-and-services.md:1).

| Platform | Purpose | Auth Method | Source Files | Status |
|---|---|---|---|---|
| Meta WhatsApp | Outbound and inbound WhatsApp messaging | `META_APP_SECRET`, `META_VERIFY_TOKEN`, per-client WhatsApp credentials from DB | `src/index.ts`, `src/channels/whatsapp.ts`, `src/config/client-config.ts` | Active |
| Twilio | SMS sending fallback / channel delivery | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` and per-client values | `src/channels/sms.ts`, `src/config/client-config.ts` | Active |
| Anthropic Claude | AI conversation generation and note generation | `ANTHROPIC_API_KEY` | `src/ai/generate.ts` | Active |
| Supabase / Postgres | System database, contacts, queue, configs, logs | `DATABASE_URL` | `src/db/client.ts`, `src/db/schema.sql` | Active |
| Google Sheets | Dashboard and reporting output | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `src/reports/dashboard.ts`, `src/reports/weekly-report.ts` | Active |
| Contabo VPS | Runtime host for the Node service | `VPS_IP`, `VPS_USER`, `VPS_PASSWORD`, `VPS_APP_DIR` | `deploy.sh`, `CLAUDE.md` | Active |
| Caddy | Reverse proxy / public ingress | Server-managed, not app-managed | Infrastructure-level, outside repo app source | Active |
| PM2 | Process manager for the long-lived Node server | Server-managed, invoked over SSH | `deploy.sh`, `CLAUDE.md` | Active |
| GitHub | Source control and VPS pull source | `GITHUB_PAT` on VPS for pulls | `deploy.sh`, repo git workflow | Active |
