# AI

## generate.ts
Reads the prompt file fresh from disk on every call — this is intentional and must not be cached.
Injects lead data into template variables, then calls the Claude API.

## Prompt Template Variables
- `{{first_name}}`, `{{last_name}}`, `{{phone_number}}`
- `{{client_name}}`
- `{{conversation_history}}`
- `{{first_message}}`

## Rules
- Do not add synchronous file reads here or anywhere else in hot paths
- AI generation timeout is 30s with up to 3 retries
- The prompt must instruct Claude to output exact keyword phrases that Workflow 02 scans for
