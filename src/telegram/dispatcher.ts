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

const SYSTEM_PROMPT = `You are an AI assistant controlling the IAE Agent - a WhatsApp lead automation server for Realtor of Excellence.

Your job is to understand the user's message and either:
1. Answer a question directly with plain text
2. Return a JSON action object (no markdown, no explanation - raw JSON only)

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
- If the user wants system status, contacts, events, logs, or to run a command, return JSON
- If the user asks a question you can answer from knowledge, answer in plain text
- Never mix JSON with text, return ONLY JSON or ONLY plain text
- For "restart", use restart_server action
- For "deploy" or "pull latest", use run_bash with "cd /root/iae-agent && git pull && npm install && npm run build && pm2 restart iae-agent"
- For bash/shell requests, use run_bash
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
  return `I couldn't interpret that. Try: "status", "contacts", "today's summary", "activity log", or "run: <bash command>"`
}
