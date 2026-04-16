# IAE Agent

Single long-lived Node.js/TypeScript HTTP server. Receives CRM webhooks, sends WhatsApp/SMS via Meta and Twilio, routes inbound replies with AI, writes results back to the CRM. No frontend. No automation platform. Everything is code.

Entry point: `src/index.ts`

---

## Codex Workflow Rules

- Claude Code plans; Codex implements
- For source file edits: use judgment on size — small targeted edits (<~20 lines, single file, clear location) → Claude directly; new files, major rewrites, multi-file changes → Codex via `codex:rescue --write`
- For reasoning, planning, reviews: Claude handles directly
- For doc updates: large writes (new files, major rewrites) → Codex; small targeted edits (a few lines, table rows) → Claude directly
- Rationale: Codex roundtrip (read context → write brief → review diff) costs more Claude tokens than a direct edit for small changes
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
- **Be concise** — no preamble, no greetings, no over-explanation. Get straight to the answer. Full instructions when needed, but no padding before or after.

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

## Error Handling Invariants

- Every send: 3 retries with exponential backoff (1s → 2s → 4s)
- AI generation: 30s timeout, up to 3 retries
- CRM write failures: non-fatal — log and continue, never crash the workflow
- DB lock: always released in `try/finally`, even on error
- Stale locks (>2min): auto-released by scheduler — do not work around this
- Duplicate webhooks: silently rejected at the top of Workflow 00

---

## Session Efficiency Rules

- **Trust the reference docs** — `SCHEMA.md`, `WORKFLOWS.md`, `DECISIONS.md`, `docs/common-tasks.md` are authoritative. Do not re-read source files to verify what these docs already describe.
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
| `GITHUB_PAT` | GitHub PAT for VPS deploy pulls | ✅ Set in .env |
| `FROM_EMAIL` | Gmail address weekly report is sent from | ⚠️ Add to .env |
| `REPORT_EMAIL` | Gmail address weekly report is sent to | ⚠️ Add to .env |
| `GMAIL_APP_PASSWORD` | Gmail App Password for weekly report sender | ⚠️ Add to .env |

---

## Reference Docs

Reference docs live in `docs/` and the project root (`SCHEMA.md`, `WORKFLOWS.md`, `ROADMAP.md`, `DECISIONS.md`). Read only what is relevant to the task at hand — do not load all docs at session start.
