# Database

All state lives in Postgres (Supabase).

## Tables

| Table | Purpose |
|---|---|
| `clients` | One row per client — config, credentials, templates (includes `reach_back_out_message_template`) |
| `contacts` | One row per contact — state, tags, AI memory, loop counter |
| `outbound_queue` | Drip queue — first messages and bumps scheduled here |
| `message_buffer` | Debounce buffer — inbound messages held here for 5s |
| `ai_responses` | Generated AI replies waiting to be sent |
| `message_log` | Full audit trail of every message in/out |

## Setup

```bash
npm run db:migrate
```

## Lock System (`src/db/client.ts`)

Prevents two concurrent processes from handling the same contact.

- Always call `db.acquireLock(contactId)` before processing
- Always call `db.releaseLock(contactId)` when done — even on errors (use try/finally)
- Stale locks older than 2 minutes are auto-released by the scheduler every 60s
