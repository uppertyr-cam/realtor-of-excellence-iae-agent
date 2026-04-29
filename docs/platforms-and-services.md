# Platforms & External Services

A reference guide to all external platforms, services, and infrastructure tools used in the IAE Agent system. This includes what each tool does, why we use it, and where it's implemented in the codebase.

---

## Core Messaging

### Meta (WhatsApp Business API)
Meta's official API for sending and receiving WhatsApp messages. When the agent wants to message a lead on WhatsApp, it calls Meta's API. When a lead replies on WhatsApp, Meta sends a webhook to our server (`POST /webhook/whatsapp`).

- **Implementation:** `src/channels/whatsapp.ts`
- **Credentials:** `META_APP_SECRET`, `META_VERIFY_TOKEN` in `.env`

### Twilio
A cloud communications platform for sending and receiving SMS. Outbound SMS goes via Twilio's API, and inbound replies arrive via Twilio webhooks (`POST /webhook/sms`). Also validates message status and handles delivery receipts.

- **Implementation:** `src/channels/sms.ts`
- **Credentials:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` in `.env`

### OpenAI (Whisper)
OpenAI's audio transcription model. When a lead sends a voice note on WhatsApp, we download the audio file and send it to Whisper to convert speech to text before passing the transcription to Claude for a reply. This feature is **optional** — only active if a client has an `openai_api_key` configured in the `clients` table.

- **Implementation:** `src/channels/transcription.ts`
- **Per-client configuration:** `clients.openai_api_key`

---

## AI

### Anthropic Claude API
The AI backbone of the system. Claude reads the conversation history, current contact state, and a dynamic prompt to generate contextual replies to send to the lead. Every inbound message triggers a Claude API call. The prompt (`skills/prompts/conversation.txt`) is injected fresh for each call to support live prompt edits without server restart.

- **Implementation:** `src/ai/generate.ts`
- **Configuration:** Prompt file at `skills/prompts/conversation.txt`
- **Credentials:** `ANTHROPIC_API_KEY` in `.env`
- **Behavior:** 30s timeout, up to 3 retries, supports tool calls (e.g. `route_lead()`)

---

## Database

### Supabase
A cloud-hosted Postgres service. We use it as a managed Postgres database host — it provides hosting, automatic backups, connection pooling, and a dashboard. No Supabase-specific features are used (no authentication, realtime subscriptions, or file storage).

- **Connection:** `DATABASE_URL` in `.env`

### PostgreSQL
The relational database engine. Stores all state: contacts, message logs, AI memory, client config, and workflow queues. The database is the single source of truth for contact state, tags, and conversation history.

- **Schema:** `src/db/schema.sql` (idempotent migrations)
- **Connection layer:** `src/db/client.ts` (lock acquire/release, query builder)
- **Key tables:** `contacts`, `message_log`, `clients`, `outbound_queue`, `message_buffer`, `ai_responses`

---

## Infrastructure

### Contabo
A budget VPS (Virtual Private Server) provider. Our Node.js server runs 24/7 on a Contabo machine. The VPS is a physical computer in Contabo's data centre that we rent and control via SSH.

- **Credentials:** `VPS_IP`, `VPS_USER`, `VPS_PASSWORD`, `VPS_APP_DIR` in `.env`
- **Memory:** Stored in auto-memory at `~/.claude/projects/-Users-phone121212-Downloads-iae-agent/memory/project_iae_deployment.md`

### Docker
A containerisation tool. The app is packaged into a Docker container — this means the entire environment (OS, Node.js, dependencies) is bundled together so it runs consistently on any machine. Containers can be restarted cleanly without affecting the host system.

- **Containerised environment:** Ensures dev/prod parity
- **Deployment:** Pushed to Contabo VPS and restarted via PM2

### Caddy
A web server that sits in front of the Node.js app. Caddy handles:
- **HTTPS/TLS:** Automatically issues and renews SSL certificates via Let's Encrypt
- **Reverse proxy:** Routes incoming traffic to the Node.js server on the correct port
- **Security:** Enforces HTTPS for all incoming requests

Without Caddy, Meta and Twilio couldn't send webhooks to us over HTTPS, which they require.

### PM2
A Node.js process manager. Keeps the app running in the background, automatically restarts it if it crashes, captures and rotates logs, and allows graceful restarts. Inside Docker, PM2 is the main process supervisor.

- **Usage:** Manages the Node.js server lifecycle on the Contabo VPS

---

## Development & Version Control

### GitHub
Version control hosting. The entire codebase is stored and version-controlled on GitHub. All changes are committed here, with a full history of who changed what and when.

### Node.js
The JavaScript/TypeScript runtime. Executes the server-side code. The app runs on the Node.js process on the Contabo VPS.

### TypeScript
A typed superset of JavaScript. The entire codebase is written in TypeScript for type safety and better IDE support. TypeScript is compiled to JavaScript before execution.

- **Configuration:** `tsconfig.json`
- **Compilation:** Happens at build time; JavaScript is what actually runs

---

## Integrations

### Google Sheets (OAuth 2.0)
Connected via Google's OAuth2 flow. Allows read/write access to Google Sheets owned by the client. Used for data sync or reporting — exact usage is client-specific and configured per client.

- **Credentials:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` in `.env`
- **Usage:** Client-specific — may sync leads to a master sheet, export conversation logs, etc.

---

## Maintenance

**When adding a new platform/service:**
1. Add an entry above with the name, description, implementation path, and any relevant credentials
2. Update any relevant docs (`docs/workflows.md`, `docs/database.md`, `CLAUDE.md`)
3. Add env var or config table columns if needed

**When removing a platform/service:**
1. Remove the entry above
2. Delete the implementation file(s) or functions
3. Remove any related env vars from `.env` and `CLAUDE.md`
4. Update other docs as needed

---

**Last Updated:** 2026-04-10
