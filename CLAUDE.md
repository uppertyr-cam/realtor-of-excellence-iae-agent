# IAE Agent

Single long-lived Node.js/TypeScript HTTP server. Receives CRM webhooks, sends WhatsApp/SMS via Meta and Twilio, routes inbound replies with AI, writes results back to the CRM. No frontend. No automation platform. Everything is code.

Entry point: `src/index.ts`

---

## Codex Workflow Rules

- Claude Code plans; Codex implements
- For any task involving file edits: delegate to Codex via `codex:rescue --write`
- For reasoning, planning, doc updates, reviews: Claude handles directly
- Always give Codex a precise brief: file path, function name, exact behaviour expected
- After Codex completes: Claude reviews the diff and runs `npx tsc --noEmit` to verify
- Codex runs on the user's ChatGPT subscription — not Anthropic usage

---

## Security Rules

- Never display, repeat, or reference actual values from `.env` in chat — not API keys, secrets, tokens, database URLs, or any credentials
- If `.env` is opened or read, use it silently to understand config only — never echo its contents

---

## Collaboration Rules

- If asked to do something repetitive or that required explicit instruction, update CLAUDE.md (or the relevant doc in `docs/`) immediately so it applies automatically in future sessions
- Keep docs up to date as the project evolves — if a file path, function name, or behaviour changes, update the reference doc that mentions it
- **Never overwrite docs without asking** — do not rewrite or restructure `docs/` files or CLAUDE.md without explicit instruction. Additive updates (appending, correcting a line) are fine; rewrites require confirmation.
- **Document failures immediately** — when something breaks and is fixed, follow this loop: identify what broke → fix it → verify the fix works → update the relevant doc in `docs/` → move on. Do not leave the doc reflecting the broken state.
- Keep `docs/platforms-and-services.md` up to date — whenever a new external platform, service, or infrastructure tool is added or removed, update this file immediately
- After reading and using a screenshot, immediately delete it — both from `screenshots/` locally and from the VPS `screenshots` folder if applicable
- VPS credentials are stored in `.env` under `VPS_IP`, `VPS_USER`, `VPS_PASSWORD`, `VPS_APP_DIR` — check there first, never ask the user to repeat them
- Pending tasks between sessions are tracked in `to-do-list/`
- Any time the user mentions something to do at a later stage, immediately add it to `to-do-list/` — never leave it just in chat
- One-off debug or test scripts go in `.tmp/` at the project root (gitignored). Delete them immediately after the task is complete — do not leave them scattered in the root.

---

## Business Partner Rules

- **Proactively suggest improvements** — if at any point something is noticed that could make the system better, reduce token usage, reduce API costs, simplify code, improve reliability, or prevent future issues, raise it immediately in chat before or after completing the task. Do not wait to be asked.
- **Flag token/usage waste** — if a workflow, prompt, or code pattern is consuming more Claude API tokens than necessary (e.g. large context being passed unnecessarily, redundant AI calls, prompts that could be shorter), flag it and suggest a leaner alternative.
- **Suggest prompt optimisations** — if `prompts/conversation.txt` or any injected context could be shortened without losing quality, say so.
- **Recommend architectural improvements** — if a simpler, cheaper, or more robust approach exists for any feature being discussed, propose it.
- **Format suggestions clearly** — prefix proactive suggestions with `💡 Suggestion:` so they are easy to spot and easy to skip if not relevant right now.
- **Keep suggestions concise** — one sentence of what, one sentence of why. Expand only if asked.
- Act as a **business partner**, not just a code executor — the goal is to help build a better, leaner system over time, not just complete the immediate task.

---

## Hard Rules

- Never change the DB schema without updating `src/db/schema.sql`
- Never hardcode client credentials — always read from the `clients` table via `src/config/client-config.ts`
- Never remove `try/finally` blocks around DB lock release
- Never change keyword strings in `detectKeyword()` without also updating the prompt file
- Never add synchronous file reads in hot paths — only `src/ai/generate.ts` reads files

---

## Step 3.0 Qualification Routing (Apr 2026 Fix)

**Status:** ✅ Fixed and verified

When a lead completes all qualifying questions (step 2.7), step 3.0 must:
1. Send the exact closing message: `"I appreciate you sharing that. I'll forward your details to the Realtor of Excellence specialist who covers your area, and they'll reach out shortly with properties that match your criteria. Have a wonderful day."`
2. Call `route_lead(action='interested_in_purchasing')` (via Claude tool)
3. Update tags: remove `qualifying_questions`, add `interested_in_purchasing`, `manual_takeover`, `qualified`
4. Cancel all pending bumps via `cancelPendingBumps(contactId)`

**Layered Defense (prevents tool skips):**
- **Layer 1:** Prompt (`prompts/conversation.txt` step 3.0) requires exact template and mandatory tool call
- **Layer 2:** Text-scan fallback (`detectKeyword()`) detects `"i'll forward your details"` phrase in closing message
- **Layer 3:** Tag updates use `ARRAY(SELECT DISTINCT UNNEST(...))` to prevent duplicates and ensure clean state

**Implementation:**
- `prompts/conversation.txt`: Step 3.0 block specifies exact closing message template
- `src/workflows/workflow-02.ts`: 
  - `detectKeyword()` includes fallback phrases: `"i'll forward your details"`, `"forward your details to the realtor"`
  - `handleKeyword()` `interested_in_purchasing` case: separate `array_remove` + `DISTINCT UNNEST` merge to add tags without duplicates
  - Always calls `cancelPendingBumps(contactId)` and `writeContactNote()`

---

## Error Handling Invariants

- Every send: 3 retries with exponential backoff (1s → 2s → 4s)
- AI generation: 30s timeout, up to 3 retries
- CRM write failures: non-fatal — log and continue, never crash the workflow
- DB lock: always released in `try/finally`, even on error
- Stale locks (>2min): auto-released by scheduler — do not work around this
- Duplicate webhooks: silently rejected at the top of Workflow 00

---

## Session Efficiency Rules

- **Trust the reference docs** — `docs/workflows.md`, `docs/database.md`, `docs/common-tasks.md` are authoritative. Do not re-read source files to verify what these docs already describe.
- **Use Grep over Read** — when looking for a specific function, variable, or string, use Grep with a pattern rather than reading the whole file.
- **Read with line ranges** — when a full file read is unavoidable, use offset+limit to read only the relevant section.
- **Check before creating** — before writing any new function, helper, or script, search `src/` for existing implementations. Use Grep to find similar patterns first. Reuse existing code when possible.

---

## Verification Rules

- After making changes, run the smallest useful verification command available
- Prefer targeted tests over broad test runs when the task is narrow
- If no test exists, verify via typecheck or lint (`npm run typecheck` / `npm run lint`)
- If verification cannot be run, say so clearly — do not claim a fix is verified unless a real check was run

---

## Git Rules

- Do not stage or commit files unless explicitly asked
- Do not revert unrelated changes
- If unexpected changes conflict with the current task, surface the conflict instead of overwriting

---

## Environment Variables (`.env`)

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

---

## Client Configuration (via DB)

Per-client settings are stored in the `clients` table and configured via `POST /admin/clients`:

### Voice Note Transcription
- `openai_api_key` — OpenAI API key for Whisper transcription (required for voice notes)
- `stage_agents` — JSONB mapping pipeline stages to notification targets, e.g.:
  ```json
  {
    "default": { "channel": "whatsapp", "target": "+61412345678" },
    "interested_in_purchasing": { "channel": "whatsapp", "target": "+61412345678" },
    "already_purchased": { "channel": "whatsapp", "target": "+61498765432" }
  }
  ```

### Bump Messages
- `bump_templates` — Nested JSONB array of [group][variation] message text (9 variations total)
- `wa_bump_template_names` — Nested JSONB array of [group][variation] approved Meta template names

### Follow-Up Messages
- `followup1_message_template`, `followup2_message_template`, `followup3_message_template` — Day 7/14/21 nudge copy
- `wa_followup1_template_name`, `wa_followup2_template_name`, `wa_followup3_template_name` — Approved Meta template names

---

## File Map

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — registers all routes |
| `src/workflows/workflow-00.ts` | CRM webhook handler — first message send, follow-up scheduling |
| `src/workflows/workflow-01.ts` | Inbound message router — debounce, lock, AI trigger |
| `src/workflows/workflow-02.ts` | Send AI reply — keyword detection, CRM update |
| `src/queue/scheduler.ts` | All queue processors — drip, bumps, follow-ups, reach-back-out |
| `src/ai/generate.ts` | Claude API call — prompt injection, tool call handling |
| `src/channels/whatsapp.ts` | Send/validate WhatsApp messages and templates |
| `src/channels/sms.ts` | Send SMS via Twilio |
| `src/channels/transcription.ts` | Download WhatsApp audio + OpenAI Whisper transcription |
| `src/crm/normalizer.ts` | Maps raw CRM payload to internal schema |
| `src/crm/adapter.ts` | Writes tags/notes/fields back to CRM |
| `src/config/client-config.ts` | Loads client row from DB with 5min in-memory cache |
| `src/db/client.ts` | Postgres connection + lock acquire/release |
| `src/db/schema.sql` | Full DB schema + idempotent migrations |
| `src/utils/types.ts` | All TypeScript interfaces |

---

## Reference Docs

@docs/workflows.md
@docs/database.md
@docs/common-tasks.md
