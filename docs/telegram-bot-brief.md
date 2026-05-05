# Codex Brief — Telegram Remote Control Bot

## Project context

Node.js/TypeScript Express server (`src/index.ts`). Entry point is `src/index.ts`.
Working directory on VPS: `/root/iae-agent/`. The app runs under PM2 as `iae-agent`.
DB: Postgres via `db.query()` from `src/db/client.ts` (exports `const db`).
Logger: Winston via `src/utils/logger.ts` (exports `const logger`).
Env vars loaded via `dotenv/config` at top of `src/index.ts`.

---

## Step 1 — Install dependency

```
npm install node-telegram-bot-api
npm install --save-dev @types/node-telegram-bot-api
```

Add to `package.json` dependencies:
- `"node-telegram-bot-api": "^0.66.0"`

Add to `package.json` devDependencies:
- `"@types/node-telegram-bot-api": "^0.66.0"`

---

## Step 2 — Create `src/telegram/index.ts`

Full file — create from scratch:

```typescript
import TelegramBot from 'node-telegram-bot-api'
import { db } from '../db/client'
import { logger } from '../utils/logger'
import fs from 'fs'
import path from 'path'
import { dispatch } from './dispatcher'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID || ''

let bot: TelegramBot | null = null

export function startTelegramBot(): void {
  if (!TOKEN) {
    logger.warn('Telegram bot not started — TELEGRAM_BOT_TOKEN not set')
    return
  }

  bot = new TelegramBot(TOKEN, { polling: true })
  logger.info('Telegram bot started (polling)')

  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id)

    // Security: only respond to whitelisted chat
    if (!ALLOWED_CHAT_ID) {
      // Log the chat ID on first contact so the user can add it to .env
      logger.info(`Telegram message from unwhitelisted chat: ${chatId}`)
      await bot!.sendMessage(chatId, `Your chat ID is: ${chatId}\nAdd TELEGRAM_ALLOWED_CHAT_ID=${chatId} to .env and restart.`)
      return
    }
    if (chatId !== ALLOWED_CHAT_ID) {
      return // silently ignore
    }

    const text = msg.text || ''
    if (!text) return

    try {
      await bot!.sendChatAction(chatId, 'typing')
      const reply = await dispatch(text)
      await bot!.sendMessage(chatId, reply, { parse_mode: 'Markdown' })
    } catch (err: any) {
      await bot!.sendMessage(chatId, `Error: ${err.message}`)
    }
  })

  bot.on('polling_error', (err) => {
    logger.error('Telegram polling error', { error: err.message })
  })

  scheduleDailySummary()
}

export function sendTelegramMessage(text: string): void {
  if (!bot || !ALLOWED_CHAT_ID) return
  bot.sendMessage(ALLOWED_CHAT_ID, text, { parse_mode: 'Markdown' }).catch((err) => {
    logger.warn('Failed to send Telegram message', { error: err.message })
  })
}

const ACTIVITY_LOG_PATH = '/root/iae-agent/logs/activity.log'

export function appendActivityLog(event: string, data: Record<string, string>): void {
  try {
    const dir = path.dirname(ACTIVITY_LOG_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n'
    fs.appendFileSync(ACTIVITY_LOG_PATH, line)
  } catch {
    // non-fatal
  }
}

function scheduleDailySummary(): void {
  const now = new Date()
  // 18:00 Africa/Johannesburg = 16:00 UTC
  const next = new Date(now)
  next.setUTCHours(16, 0, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)

  const delay = next.getTime() - now.getTime()
  setTimeout(() => {
    sendDailySummary()
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000)
  }, delay)
}

async function sendDailySummary(): Promise<void> {
  if (!bot || !ALLOWED_CHAT_ID) return
  try {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    const [sent, received, outcomes, errors] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM message_log WHERE direction='outbound' AND created_at::date = $1::date`, [today]),
      db.query(`SELECT COUNT(*) FROM message_log WHERE direction='inbound' AND created_at::date = $1::date`, [today]),
      db.query(`SELECT tag, COUNT(*) as count FROM contacts WHERE updated_at::date = $1::date AND tag IS NOT NULL GROUP BY tag ORDER BY count DESC LIMIT 5`, [today]),
      db.query(`SELECT COUNT(*) FROM email_log WHERE category='alert' AND created_at::date = $1::date`, [today]),
    ])

    const dateLabel = new Date().toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' })
    const outcomeLines = outcomes.rows.map((r: any) => `  ${r.tag}: ${r.count}`).join('\n') || '  None'

    const msg = [
      `📊 *Daily Summary — ${dateLabel}*`,
      '',
      `Messages sent: ${sent.rows[0].count}`,
      `Replies received: ${received.rows[0].count}`,
      `Alerts triggered: ${errors.rows[0].count}`,
      '',
      `*Outcomes today:*`,
      outcomeLines,
    ].join('\n')

    await bot.sendMessage(ALLOWED_CHAT_ID, msg, { parse_mode: 'Markdown' })
  } catch (err: any) {
    logger.warn('Daily Telegram summary failed', { error: err.message })
  }
}
```

---

## Step 3 — Create `src/telegram/actions.ts`

Full file — create from scratch:

```typescript
import { db } from '../db/client'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'

const execAsync = promisify(exec)

export async function getStatus(): Promise<string> {
  const [contacts, queue, locked] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM contacts WHERE automation_paused = FALSE`),
    db.query(`SELECT COUNT(*) FROM contacts WHERE first_message_sent = FALSE AND automation_paused = FALSE`),
    db.query(`SELECT COUNT(*) FROM contacts WHERE processing_locked = TRUE`),
  ])
  return [
    `*System Status*`,
    `Active contacts: ${contacts.rows[0].count}`,
    `In queue (not yet sent): ${queue.rows[0].count}`,
    `Processing locks held: ${locked.rows[0].count}`,
  ].join('\n')
}

export async function getContacts(limit = 10): Promise<string> {
  const res = await db.query(
    `SELECT first_name, last_name, phone_number, tag, first_message_sent, updated_at
     FROM contacts
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  )
  if (!res.rows.length) return 'No contacts found.'
  const lines = res.rows.map((r: any) => {
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown'
    const sent = r.first_message_sent ? '✓' : '⏳'
    return `${sent} ${name} (${r.phone_number}) — ${r.tag || 'no tag'}`
  })
  return `*Recent Contacts (${limit})*\n` + lines.join('\n')
}

export async function getRecentEvents(limit = 20): Promise<string> {
  const res = await db.query(
    `SELECT ml.direction, ml.content, ml.created_at,
            c.first_name, c.last_name
     FROM message_log ml
     LEFT JOIN contacts c ON c.id = ml.contact_id
     ORDER BY ml.created_at DESC
     LIMIT $1`,
    [limit]
  )
  if (!res.rows.length) return 'No recent events.'
  const lines = res.rows.map((r: any) => {
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown'
    const dir = r.direction === 'inbound' ? '⬅️' : '➡️'
    const preview = (r.content || '').slice(0, 60)
    return `${dir} ${name}: ${preview}`
  })
  return `*Recent Messages*\n` + lines.join('\n')
}

export async function getDailySummary(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)
  const [sent, received, qualified] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM message_log WHERE direction='outbound' AND created_at::date = $1::date`, [today]),
    db.query(`SELECT COUNT(*) FROM message_log WHERE direction='inbound' AND created_at::date = $1::date`, [today]),
    db.query(`SELECT first_name, last_name FROM contacts WHERE tag = 'buyer_qualified' AND updated_at::date = $1::date`, [today]),
  ])
  const qualNames = qualified.rows.map((r: any) => `${r.first_name || ''} ${r.last_name || ''}`.trim()).join(', ') || 'None'
  return [
    `*Today's Summary*`,
    `Sent: ${sent.rows[0].count}`,
    `Received: ${received.rows[0].count}`,
    `Qualified today: ${qualNames}`,
  ].join('\n')
}

export async function runBash(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000, cwd: '/root/iae-agent' })
    const out = (stdout || '').trim()
    const err = (stderr || '').trim()
    if (!out && !err) return '(no output)'
    return [out, err].filter(Boolean).join('\n').slice(0, 3000)
  } catch (err: any) {
    return `Error: ${err.message}`.slice(0, 1000)
  }
}

export async function readFile(filePath: string): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.slice(0, 3000) // cap at 3000 chars for Telegram
  } catch (err: any) {
    return `Cannot read file: ${err.message}`
  }
}

export async function getActivityLog(): Promise<string> {
  return readFile('/root/iae-agent/logs/activity.log')
}

export async function restartServer(): Promise<string> {
  return runBash('pm2 restart iae-agent')
}
```

---

## Step 4 — Create `src/telegram/dispatcher.ts`

Full file — create from scratch:

```typescript
import { exec } from 'child_process'
import { promisify } from 'util'
import { logger } from '../utils/logger'
import {
  getStatus,
  getContacts,
  getRecentEvents,
  getDailySummary,
  runBash,
  readFile,
  getActivityLog,
  restartServer,
} from './actions'

const execAsync = promisify(exec)

const SYSTEM_PROMPT = `You are an AI assistant controlling the IAE Agent — a WhatsApp lead automation server for Realtor of Excellence.

Your job is to understand the user's message and either:
1. Answer a question directly with plain text
2. Return a JSON action object (no markdown, no explanation — raw JSON only)

Available JSON actions:
{"action":"get_status"}
{"action":"get_contacts","limit":10}
{"action":"get_recent_events","limit":20}
{"action":"get_daily_summary"}
{"action":"get_activity_log"}
{"action":"restart_server"}
{"action":"run_bash","command":"<bash command>"}
{"action":"read_file","path":"<absolute file path>"}

Rules:
- If the user wants system status, contacts, events, logs, or to run a command → return JSON
- If the user asks a question you can answer from knowledge → answer in plain text
- Never mix JSON with text — return ONLY JSON or ONLY plain text
- For "restart" → use restart_server action
- For "deploy" or "pull latest" → use run_bash with "cd /root/iae-agent && git pull && npm install && npm run build && pm2 restart iae-agent"
- For bash/shell requests → use run_bash
- Keep answers short and clear`

export async function dispatch(userMessage: string): Promise<string> {
  // Try Claude Code CLI first
  try {
    const prompt = `${SYSTEM_PROMPT}\n\nUser: ${userMessage}`
    const escaped = prompt.replace(/'/g, `'\\''`)
    const { stdout } = await execAsync(`claude -p '${escaped}'`, { timeout: 60000 })
    const raw = stdout.trim()

    // Detect if Claude returned a JSON action
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        return await executeAction(parsed)
      } catch {
        // Not valid JSON — treat as plain text
        return raw
      }
    }
    return raw
  } catch (err: any) {
    logger.warn('Claude CLI dispatch failed, falling back to keyword routing', { error: err.message })
    return keywordFallback(userMessage)
  }
}

async function executeAction(action: Record<string, any>): Promise<string> {
  switch (action.action) {
    case 'get_status':
      return getStatus()
    case 'get_contacts':
      return getContacts(action.limit || 10)
    case 'get_recent_events':
      return getRecentEvents(action.limit || 20)
    case 'get_daily_summary':
      return getDailySummary()
    case 'get_activity_log':
      return getActivityLog()
    case 'restart_server':
      return restartServer()
    case 'run_bash':
      return runBash(action.command || '')
    case 'read_file':
      return readFile(action.path || '')
    default:
      return `Unknown action: ${action.action}`
  }
}

// Fallback if Claude CLI is not available — simple keyword routing
async function keywordFallback(msg: string): Promise<string> {
  const lower = msg.toLowerCase()
  if (lower.includes('status')) return getStatus()
  if (lower.includes('contact')) return getContacts(10)
  if (lower.includes('log') || lower.includes('activity')) return getActivityLog()
  if (lower.includes('summary') || lower.includes('today')) return getDailySummary()
  if (lower.includes('event') || lower.includes('message')) return getRecentEvents(10)
  if (lower.includes('restart')) return restartServer()
  const bashMatch = msg.match(/^(?:run|bash|exec|shell)[:\s]+(.+)/i)
  if (bashMatch) return runBash(bashMatch[1])
  return `I couldn't interpret that. Try: "status", "contacts", "today's summary", "activity log", or "run: <bash command>"`
}
```

---

## Step 5 — Modify `src/index.ts`

### 5a. Add import at top (after existing imports, before `const app = express()`)

Add this line after line 17 (`import { alertEmail, noNumberEmail } from './utils/alert'`):

```typescript
import { startTelegramBot } from './telegram/index'
```

### 5b. Modify the app.listen block (currently lines 988–991)

Change:
```typescript
app.listen(PORT, () => {
  logger.info(`IAE Agent running on port ${PORT}`)
  startScheduler()
})
```

To:
```typescript
app.listen(PORT, () => {
  logger.info(`IAE Agent running on port ${PORT}`)
  startScheduler()
  startTelegramBot()
})
```

---

## Step 6 — Modify `src/utils/alert.ts`

### 6a. Add import at top (after existing imports)

```typescript
import { sendTelegramMessage } from '../telegram/index'
```

### 6b. In `noNumberEmail()` — add Telegram notification

After the line `if (!FROM_EMAIL || !APP_PASSWORD || !TO) return`, add:

```typescript
  sendTelegramMessage(`⚠️ *No WhatsApp Number*\nContact: ${contact.name} (${contact.phone})\nCharmaine has been emailed.`)
```

### 6c. In `alertEmail()` — add Telegram notification

After the line `cooldowns.set(subject, Date.now())`, add:

```typescript
  sendTelegramMessage(`🚨 *Alert: ${subject}*\n${Object.entries(context).map(([k,v]) => `${k}: ${v}`).join('\n')}`)
```

---

## Step 7 — Modify `src/notifications/lead-notifications.ts`

### 7a. Add import at top (after existing imports)

```typescript
import { sendTelegramMessage } from '../telegram/index'
```

### 7b. In `sendLeadNotification()` — add Telegram for qualified leads

Find the `try {` block that calls `transporter.sendMail(...)`. After the `await db.query(...)` inside the try block (after the email log insert), add:

```typescript
    if (outcome === 'buyer_qualified') {
      const name = fullName(contact)
      sendTelegramMessage(`🏆 *Qualified Buyer!*\n${name}\n📞 ${contact.phone_number}`)
    }
```

---

## Step 8 — Update `docs/configuration.md`

Find the section that lists environment variables and add these two rows to the table:

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | Cameron's Telegram chat ID — bot ignores all other senders |

---

## TypeScript notes

- `node-telegram-bot-api` ships its own types via `@types/node-telegram-bot-api`
- All three new files import from `'../db/client'` and `'../utils/logger'` — these already exist
- `src/telegram/index.ts` imports from `'./dispatcher'` — make sure all three files are in the same `src/telegram/` directory
- The `dispatch()` function in dispatcher.ts uses `child_process.exec` (Node built-in) — no extra import needed beyond `import { exec } from 'child_process'`

---

## After implementation

Run:
```
npx tsc --noEmit
```

Expected: zero errors.

---

## Setup instructions for Cameron (after deploy)

1. On Telegram: message `@BotFather` → `/newbot` → follow prompts → copy token
2. On VPS: `echo "TELEGRAM_BOT_TOKEN=<token>" >> /root/iae-agent/.env`
3. Message the bot from your Telegram — it will reply with your chat ID
4. On VPS: `echo "TELEGRAM_ALLOWED_CHAT_ID=<your_chat_id>" >> /root/iae-agent/.env`
5. `pm2 restart iae-agent`
6. On VPS: install Claude Code CLI if not already: `npm install -g @anthropic-ai/claude-code` then `claude login`
7. Test: send "status" to the bot — should get queue/contact summary back
