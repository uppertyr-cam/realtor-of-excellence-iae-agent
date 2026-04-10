# Workflows

See full step-by-step docs: `@../../docs/workflows.md`

## Rules
- DB lock must be acquired before processing and released in `try/finally` — no exceptions
- Routing is now tool-based: Claude calls `route_lead({ action })` in `generate.ts`; the keyword is passed directly to `handleAIResponseReady(contactId, keyword)`
- `detectKeyword()` in `workflow-02.ts` is a text-scan fallback only — Claude's tool call takes priority
- Adding a new keyword: add the action to the `ROUTE_LEAD_TOOL` enum in `src/ai/generate.ts`, add the case to `handleKeyword()` in `workflow-02.ts`, add the type to `DetectedKeyword` in `src/utils/types.ts`, and update `prompts/conversation.txt`
- Debounce window is `DEBOUNCE_MS` at the top of `workflow-01.ts`
- Workflow 02 is triggered inline by Workflow 01 — not via HTTP
