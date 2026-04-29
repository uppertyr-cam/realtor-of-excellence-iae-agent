# IAE Agent

Single long-lived Node.js/TypeScript HTTP server. Receives CRM webhooks, sends WhatsApp/SMS via Meta and Twilio, routes inbound replies with AI, writes results back to the CRM. No frontend. No automation platform. Everything is code.

Entry point: `src/index.ts`

---

## Codex Workflow Rules

- Claude Code plans; Codex implements
- For source file edits: use judgment on size — small targeted edits (<~20 lines, single file, clear location) → Claude directly; new files, major rewrites, multi-file changes → Codex via `codex:rescue --write`
- For reasoning, planning, reviews: Claude handles directly
- For doc updates: large writes (new files, major rewrites) → Codex; small targeted edits (a few lines, table rows) → Claude directly
- Always give Codex a precise brief: file path, function name, exact behaviour expected
- After Codex completes: Claude reviews the diff and runs `npx tsc --noEmit` to verify
- Codex runs on the user's ChatGPT subscription — not Anthropic usage

---

## Security Rules

- Never display, repeat, or reference actual values from `.env` in chat — not API keys, secrets, tokens, database URLs, or any credentials
- If `.env` is opened or read, use it silently to understand config only — never echo its contents

---

## Collaboration Rules

- If asked to do something repetitive or that required explicit instruction, update CLAUDE.md (or the relevant doc) immediately so it applies automatically in future sessions
- Keep docs up to date as the project evolves — if a file path, function name, or behaviour changes, update the reference doc that mentions it
- **Never overwrite docs without asking** — additive updates are fine; rewrites require confirmation
- **Document failures immediately** — identify what broke → fix → verify → update the relevant doc → move on
- After reading and using a screenshot, immediately delete it, including from the VPS `screenshots` folder
- Pending tasks between sessions are tracked in `docs/to-do-list/` — add there immediately, never leave in chat only
- One-off debug or test scripts go in `.tmp/` (gitignored) — delete immediately after use
- **Be concise** — no preamble, no greetings, no over-explanation

---

## Business Partner Rules

- **Proactively suggest improvements** — raise anything that could reduce tokens, API costs, simplify code, or improve reliability. Prefix with `💡 Suggestion:`
- **Flag token/usage waste** — redundant AI calls, oversized context, prompts that could be shorter
- **Suggest prompt optimisations** — if `skills/prompts/conversation.txt` could be shorter without losing quality, say so
- **Recommend architectural improvements** — if a simpler or cheaper approach exists, propose it
- Act as a **business partner**, not just a code executor

---

## Command Extensions

- `/brief` — analyze infrastructure logs, generate "Story of the Business"
- `/explore [task]` — find automation opportunities, draft technical logic
- `/validate` — check workspace for context drift against `context/strategy.md` and `hooks/validator.md`
- `/update-context` — extract key decisions from recent history, update `context/` files

---

## Git Rules

- Do not stage or commit files unless explicitly asked
- Do not revert unrelated changes
- If unexpected changes conflict with the current task, surface the conflict instead of overwriting

---

## Directory Map

Each folder has its own `CLAUDE.md` with detailed rules — read it when working in that area.

| Folder | What it contains |
|--------|-----------------|
| `src/` | All TypeScript source code — server, workflows, channels, AI, DB, reports |
| `skills/` | Workflow SOPs, AI prompt files, automation skill definitions |
| `context/` | AIOS business brain — ROE identity, people, products, strategy, brand |
| `infrastructure/` | Environment variables, deployment scripts, integrations registry |
| `hooks/` | Output quality validator |
| `data/` | Batch lead CSVs, contact exports, sample input files (gitignored) |
| `docs/` | All reference documentation — schema, workflows, decisions, roadmap |
