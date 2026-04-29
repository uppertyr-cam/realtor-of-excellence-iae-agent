# Workflows

See full step-by-step docs: `@../../docs/workflows.md`

## Rules
- DB lock must be acquired before processing and released in `try/finally` — no exceptions
- Routing is now tool-based: Claude calls `route_lead({ action })` in `generate.ts`; the keyword is passed directly to `handleAIResponseReady(contactId, keyword)`
- `detectKeyword()` in `ai-send-router.ts` is a text-scan fallback only — Claude's tool call takes priority
- Adding a new keyword: add the action to the `ROUTE_LEAD_TOOL` enum in `src/ai/generate.ts`, add the case to `handleKeyword()` in `ai-send-router.ts`, add the type to `DetectedKeyword` in `src/utils/types.ts`, and update `skills/prompts/conversation.txt`
- Debounce window is `DEBOUNCE_MS` at the top of `inbound-reply-handler.ts`
- `ai-send-router.ts` is triggered inline by `inbound-reply-handler.ts` — not via HTTP
- Bump scheduling, cancellation, and sending live in `bump-handler.ts` — import `scheduleBumps`, `cancelBumps`, `cancelPendingBumps` from there
