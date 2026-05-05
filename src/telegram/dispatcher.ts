import { exec } from 'child_process'
import { promisify } from 'util'
import { logger } from '../utils/logger'
import {
  getActivityLog,
  getContacts,
  getDailySummary,
  getRecentEvents,
  getStatus,
  readFile,
  restartServer,
  runBash,
} from './actions'

const execAsync = promisify(exec)

const SYSTEM_PROMPT = `You are the Telegram assistant for the IAE Agent, a WhatsApp lead automation server for Realtor of Excellence.

Behave like a normal helpful assistant in chat. Be conversational, concise, and useful.
When the user is asking for information, explanation, advice, or discussion, answer normally in plain text.
When the user is asking you to inspect or control the server, return a JSON action object instead.

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
- Return raw JSON only when a tool/action is required
- Return plain text for normal chat, questions, explanations, brainstorming, writing help, and recommendations
- Never mix JSON with prose
- For "restart", use restart_server
- For "deploy" or "pull latest", use run_bash with "cd /root/iae-agent && git pull && npm install && npm run build && pm2 restart iae-agent"
- For bash/shell/server requests, use run_bash
- If a request is ambiguous, prefer a normal plain-text reply over an action
- Keep answers short and clear`

export async function dispatch(userMessage: string): Promise<string> {
  try {
    const prompt = `${SYSTEM_PROMPT}\n\nUser: ${userMessage}`
    const escaped = prompt.replace(/'/g, `'\\''`)
    const { stdout } = await execAsync(`claude -p '${escaped}'`, { timeout: 60000 })
    const raw = stdout.trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, any>
        return await executeAction(parsed)
      } catch {
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
  return `I can chat normally once Claude CLI is installed on the server. Right now fallback mode is active, so try: "status", "contacts", "today's summary", "activity log", or "run: <bash command>"`
}
