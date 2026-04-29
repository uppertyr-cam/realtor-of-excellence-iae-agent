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

---

## Hard Rules

- Never edit files directly on the VPS — all changes must be made locally, committed, pushed, and deployed via `git pull` on the VPS
- Never change the DB schema without updating `src/db/schema.sql`
- Never hardcode client credentials — always read from the `clients` table via `src/config/client-config.ts`
- Never remove `try/finally` blocks around DB lock release
- Never change keyword strings in `detectKeyword()` without also updating `skills/prompts/conversation.txt`
- Never add synchronous file reads in hot paths — only `src/ai/generate.ts` reads files

---

## Error Handling Invariants

- Every send: 3 retries with exponential backoff (1s → 2s → 4s)
- AI generation: 30s timeout, up to 3 retries
- CRM write failures: non-fatal — log and continue, never crash the workflow
- DB lock: always released in `try/finally`, even on error
- Stale locks (>2min): auto-released by scheduler — do not work around this
- Duplicate webhooks: silently rejected at the top of Outbound First Message
- Invalid phone numbers: `cleanPhone()` in `src/channels/whatsapp.ts` throws on <7 or >15 digits — callers return `{ success: false }`, no Meta API call is made

---

## Session Efficiency Rules

- **Trust the reference docs** — `docs/schema.md`, `docs/workflows.md`, `docs/decisions.md`, `docs/common-tasks.md` are authoritative. Do not re-read source files to verify what these docs already describe.
- **Use Grep over Read** — when looking for a specific function, variable, or string, use Grep rather than reading the whole file
- **Read with line ranges** — when a full file read is unavoidable, use offset+limit to read only the relevant section
- **Check before creating** — before writing any new function, helper, or script, search `src/` for existing implementations first

---

## Verification Rules

- After making changes, run the smallest useful verification command available
- Prefer targeted tests over broad test runs when the task is narrow
- If no test exists, verify via typecheck (`npx tsc --noEmit`) or lint (`npm run lint`)
- If verification cannot be run, say so clearly — do not claim a fix is verified unless a real check was run
