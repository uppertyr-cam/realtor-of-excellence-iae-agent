# src/

Entry point: `index.ts` — Express server, route registration, webhook handlers.

## Folder Map

| Folder | What it does |
|--------|-------------|
| `workflows/` | All business logic — outbound send, inbound handling, AI routing, bump handling |
| `queue/` | Scheduler tick driver — calls all queue processors every 60s |
| `ai/` | Claude API call, prompt injection, `route_lead` tool, contact note generation |
| `channels/` | WhatsApp (Meta), SMS (Twilio), voice note transcription (Whisper) |
| `crm/` | Normalises inbound CRM webhooks; writes tags/notes/fields back to CRM |
| `db/` | Postgres client, lock acquire/release, query helpers |
| `config/` | `getClientConfig()` — loads client row from DB with 5-min cache |
| `reports/` | Google Sheets dashboard + weekly Gmail report |
| `utils/` | Shared types, logger, working-hours check |

## Workflow Files (the core)

| File | Role |
|------|------|
| `workflows/outbound-first-message.ts` | CRM webhook → validate → queue → send first message |
| `workflows/inbound-reply-handler.ts` | Inbound reply → debounce → lock → route → AI generation |
| `workflows/ai-send-router.ts` | Send AI message → keyword detection → pipeline routing |
| `workflows/bump-handler.ts` | Schedule / cancel / send bumps (24h/48h/72h) + bump close (73h) |
