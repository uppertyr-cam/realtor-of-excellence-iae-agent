# Architectural Decisions

All decisions verified from source code. Generated 2026-04-12.

---

## Decision: Single Long-Lived Node.js Process (No Queue Platform)

**What:** The entire system runs as one Node.js/Express HTTP server. There is no external message queue platform (no RabbitMQ, BullMQ, SQS, Redis Streams, etc.). The scheduler is a `setInterval` running inside the same process.

**Why:** Eliminates infrastructure complexity. Single process, single Postgres DB, single server — nothing else to deploy, monitor, or pay for. The contact volume this system targets does not require distributed processing.

**Trade-off:** A server crash stops all processing until PM2 restarts the process. Debounce timers and rate-limit counters are in-memory and lost on restart. Horizontal scaling (multiple instances) is not possible without redesigning the lock and rate-limit systems.

**Where in code:** `src/index.ts` (single Express app), `src/queue/scheduler.ts:startScheduler()` (setInterval), `src/workflows/outbound-first-message.ts` (`dailyCounts` and `lastSentAt` Maps)

---

## Decision: Postgres as the Sole State Store

**What:** All workflow state, message history, AI memory, lock state, scheduled jobs, and client config live in Postgres (Supabase). No Redis, no secondary storage, no in-process state store for shared data.

**Why:** One database means one place to debug. Postgres provides strong consistency guarantees, ACID transactions, and `FOR UPDATE SKIP LOCKED` for safe queue processing. Supabase provides managed hosting, backups, connection pooling, and a dashboard with no additional config.

**Trade-off:** Every workflow action hits the DB. High contact volume will approach the pool limit (20 connections). The lock system uses a flag column rather than Postgres advisory locks, which is slightly heavier.

**Where in code:** `src/db/client.ts` (pool: max 20, idleTimeout 30s, connectionTimeout 2s), `src/db/schema.sql` (all 6 tables)

---

## Decision: Application-Level Row Lock (Flag Column) Over Postgres Advisory Locks

**What:** Contact processing is serialised using `processing_locked BOOLEAN` and `processing_locked_at TIMESTAMPTZ` columns on the `contacts` table. `acquireLock()` does an atomic `UPDATE contacts SET processing_locked=TRUE WHERE id=$1 AND processing_locked=FALSE` — returns true only if the row was updated.

**Why:** Simple to implement, reason about, and debug. Visible in the database — you can see at a glance which contacts are locked and since when. Stale locks auto-release after 2 minutes via the scheduler. Works across multiple processes sharing the same DB.

**Trade-off:** Not a true advisory lock — a crashed process leaves `processing_locked=TRUE` until the 2-minute auto-release. Lock acquire is a DB write (slightly heavier than `pg_try_advisory_lock`). If the scheduler crashes, stale locks accumulate until it restarts.

**Where in code:** `src/db/client.ts:acquireLock()`, `releaseLock()`, `releaseStaleLocks()`; `src/workflows/inbound-reply-handler.ts:processBufferedMessages()` (try/finally block ensures release on error)

---

## Decision: In-Process Debounce with `setTimeout` Maps

**What:** Inbound message debouncing uses `setTimeout` stored in `debounceTimers: Map<string, NodeJS.Timeout>`. Each new message cancels the previous timer and sets a new 5-second one. Only the last timer fires, triggering processing of all buffered messages.

**Why:** Zero infrastructure overhead. Works immediately with no DB round-trip per message. Simple to reason about for the expected traffic volume.

**Trade-off:** Debounce state is in-memory — lost on process restart. If two Node instances ran behind a load balancer, the same contact could be processed by both. Not safe for multi-instance deployments without an external debounce layer (e.g. Redis `SET EX`).

**Where in code:** `src/workflows/inbound-reply-handler.ts` — `DEBOUNCE_MS = 5_000`, `debounceTimers` Map, `handleInboundMessage()`

---

## Decision: Prompt Read Fresh from Disk on Every AI Call

**What:** `generateAIResponse()` calls `fs.readFileSync(promptFilePath)` synchronously on every invocation. The file is never cached between calls.

**Why:** Enables live prompt edits without a server restart. Changing `prompts/conversation.txt` takes effect on the next AI call immediately. This is an intentional product feature that allows prompt iteration in production.

**Trade-off:** Synchronous file I/O on every AI call (which is already a hot path). The CLAUDE.md rule says "Never add synchronous file reads in hot paths — only `src/ai/generate.ts` reads files" — this single location is the deliberate exception. A misconfigured or missing prompt file throws and fails the AI generation.

**Where in code:** `src/ai/generate.ts:generateAIResponse()` — `fs.readFileSync(path.join(process.cwd(), promptFilePath), 'utf8')`; `src/ai/CLAUDE.md` — "Reads the prompt file fresh from disk on every call — this is intentional and must not be cached."

---

## Decision: Claude Tool Call as Primary Keyword Signal, Text-Scan as Fallback

**What:** Claude is given the `route_lead` tool with `tool_choice: auto`. When Claude calls it, the `action` field is used directly. Only if Claude does not call the tool does `detectKeyword()` scan the raw response text for trigger phrases.

**Why:** Tool calls are unambiguous — Claude explicitly signals intent rather than the system guessing from natural language. Reduces false positives. The text-scan fallback provides a safety net for cases where the tool call is missed (model refusal, edge cases, timeouts).

**Trade-off:** Two detection layers that can produce different results. If the prompt is poorly maintained, Claude may stop calling the tool reliably. The text-scan fallback may produce false positives if trigger phrases appear in non-trigger contexts (e.g. the word "renting" in a question).

**Where in code:** `src/ai/generate.ts:ROUTE_LEAD_TOOL` (tool definition, 6-action enum), `src/workflows/ai-send-router.ts:detectKeyword()` (text-scan), `src/workflows/ai-send-router.ts:handleAIResponseReady()` — `const keyword = routedKeyword ?? detectKeyword(responseText)`

---

## Decision: Anthropic Prompt Caching on System Prompt

**What:** The system prompt (injected prompt file content) is sent with `cache_control: { type: 'ephemeral' }`. The `prompt-caching-2024-07-31` beta header is set on every Claude API call.

**Why:** The system prompt is large and structurally identical across all calls for a given client and conversation. Caching it at Anthropic reduces input token cost and latency for back-to-back calls.

**Trade-off:** Cache TTL is ~5 minutes. If calls are spaced more than 5 minutes apart (common for leads who reply slowly), the cache is cold and no savings occur. Dynamic data must stay out of the system prompt and into the user message — otherwise every call invalidates the cache.

**Where in code:** `src/ai/generate.ts:generateAIResponse()` — `{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }` and `anthropic.beta.messages.create({ betas: ['prompt-caching-2024-07-31'] })`

---

## Decision: Two Claude Models — Sonnet for Conversation, Haiku for Notes

**What:** `generateAIResponse()` uses `claude-sonnet-4-6` (1000 max tokens). `generateContactNote()` uses `claude-haiku-4-5-20251001` (500 max tokens).

**Why:** Conversation requires the highest quality output — Sonnet. Contact note summarisation is a simpler, shorter task — Haiku is faster and significantly cheaper. Notes are non-critical (failure is caught and logged).

**Trade-off:** Adds a dependency on two model versions. If either is deprecated, both functions need updating independently. Haiku failures are silent (non-fatal), so degraded note quality won't surface in errors.

**Where in code:** `src/ai/generate.ts:generateAIResponse()` — `model: 'claude-sonnet-4-6'`; `src/ai/generate.ts:generateContactNote()` — `model: 'claude-haiku-4-5-20251001'`

---

## Decision: Client Credentials Stored in DB, Not Environment Variables

**What:** Per-client credentials — WhatsApp tokens, Twilio SIDs, CRM API keys, OpenAI keys — are stored in the `clients` table and loaded via `getClientConfig()`. Only system-wide credentials shared across all clients are in `.env`.

**Why:** Supports multi-tenancy. Each client has independent credentials without separate deployments or env files per client. Credentials can be updated at runtime via `POST /admin/clients` without a server restart or redeployment.

**Trade-off:** Client credentials are in the database. A DB breach exposes all client credentials simultaneously. The `clients` table has no column-level encryption. The 5-minute config cache means a credential update takes up to 5 minutes to take effect (or `clearClientCache()` must be called manually).

**Where in code:** `src/config/client-config.ts:getClientConfig()`, `src/db/schema.sql` clients table (`wa_access_token`, `crm_api_key`, `sms_auth_token`, `openai_api_key`), `src/crm/CLAUDE.md` — "Never hardcode credentials — always read from the clients table"

---

## Decision: CRM Write Failures Are Non-Fatal

**What:** `writeToCrm()` wraps all CRM API calls in try/catch. Errors are logged via `logger.error()` but never re-thrown. The calling workflow always continues regardless of whether the CRM write succeeded.

**Why:** CRM APIs are external dependencies — they can be slow, rate-limited, or temporarily unavailable. A CRM outage should never prevent a message from being sent to a lead or leave the contact in a corrupted state.

**Trade-off:** CRM failures are only visible in server logs. If the CRM is down for an extended period, tag and note updates are permanently lost — there is no retry queue for CRM writes. Silent failures could cause the CRM to drift from the actual contact state.

**Where in code:** `src/crm/adapter.ts:writeToCrm()` — top-level try/catch with `logger.error('CRM write failed', ...)`, no re-throw; `src/crm/CLAUDE.md` — "CRM write failures are non-fatal — log and continue, never throw or crash the workflow"

---

## Decision: `FOR UPDATE SKIP LOCKED` for All Queue Processing

**What:** Every queue processor selects pending jobs using `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 10`. This allows concurrent scheduler ticks (or, theoretically, multiple processes) to work on different jobs simultaneously without conflicts.

**Why:** Safe concurrent queue processing without a separate lock table, mutex, or external queue broker. Built into Postgres — no additional infrastructure needed. `SKIP LOCKED` means contended rows are skipped rather than causing waits.

**Trade-off:** Jobs are locked at the row level for the duration of the processing transaction. A long-running job holds its lock for that duration. If the process crashes mid-job, the row remains locked until Postgres detects the connection drop (typically seconds to minutes).

**Where in code:** `src/queue/scheduler.ts:processFollowUpQueue()`, `processBumpQueue()`, `processBumpCloseQueue()`, `processReachBackOutQueue()` — all use `FOR UPDATE SKIP LOCKED LIMIT 10`

---

## Decision: Dashboard and Weekly Report Updates Are Fire-and-Forget

**What:** All calls to `updateDashboard()` and `buildWeeklyReport()` within workflow code are followed by `.catch(() => {})` — errors are silently discarded.

**Why:** Reporting is a non-critical side effect of workflow events. A Google Sheets API failure (rate limit, OAuth token expiry, network timeout) should never block a message send, keyword routing action, or CRM update.

**Trade-off:** Reporting failures are invisible unless server logs are actively monitored. If the Google OAuth refresh token expires or is revoked, the dashboard silently stops updating — there is no alert or fallback.

**Where in code:** `src/workflows/ai-send-router.ts:handleKeyword()` — `updateDashboard(contact.client_id).catch(() => {})`, same pattern in `src/queue/scheduler.ts:processBumpCloseJob()`, `processReachBackOutJob()`

---

## Decision: WhatsApp Template Preferred Over Freeform, SMS as Final Fallback

**What:** Every send path follows a fixed priority: (1) WhatsApp template if `wa_*_template_name` is configured, (2) WhatsApp freeform message, (3) SMS via Twilio.

**Why:** Meta requires approved templates for initiating or re-initiating WhatsApp conversations outside the 24-hour reply window. Freeform is only allowed within the window. SMS is the universal fallback for unreachable WhatsApp numbers or unconfigured templates.

**Trade-off:** Template misconfiguration (wrong variable count, unapproved name) causes a send failure that falls back to freeform or SMS — which may or may not be the desired behaviour. Template approval through Meta adds external operational overhead and delays.

**Where in code:** `src/workflows/outbound-first-message.ts:sendFirstMessage()`, `src/queue/scheduler.ts:processFollowUpJob()`, `processBumpJob()`, `processReachBackOutJob()` — all share the same priority logic

---

## Decision: `bump_variation_index` Rotates Across Bump Cycles

**What:** `contacts.bump_variation_index` cycles 0 → 1 → 2 → 0 across successive bump cycles (a new cycle begins after each AI reply). `contacts.bump_index` advances through groups (0, 1, 2) within a single cycle.

**Why:** Prevents a lead from seeing the exact same bump message if they go through multiple no-reply cycles. Variation maintains engagement and avoids the repetition that makes automated messages feel robotic.

**Trade-off:** The bump template matrix must be fully populated (3 groups × 3 variations = 9 messages total) or an index can point to an empty/null slot, causing the send to fall back to freeform or SMS silently. Managing 9 template variants per client adds configuration overhead.

**Where in code:** `src/workflows/ai-send-router.ts:handleAIResponseReady()` — `bump_variation_index = (current + 1) % 3`; `src/queue/scheduler.ts:processBumpJob()` — `config.bump_templates[contact.bump_index][contact.bump_variation_index]`

---

## Decision: Inbound Phone Lookup Uses Fuzzy Suffix Match

**What:** When a WhatsApp or SMS webhook arrives, the contact is looked up using `WHERE phone_number LIKE '%{digits}'` — a suffix match on the digits of the incoming number.

**Why:** Phone numbers arrive in different formats from different sources (E.164, local, with/without country code prefix). A suffix match tolerates format inconsistencies without requiring normalisation at ingest time.

**Trade-off:** In theory, two contacts with phone numbers ending in the same digits could collide (e.g. `+61412345678` and `+1412345678`). In practice, this is extremely unlikely given the suffix length. A more robust solution would normalise all numbers to E.164 at ingest.

**Where in code:** `src/index.ts` — `WHERE phone_number LIKE '%' || $1` in both the WhatsApp and SMS webhook handlers
