import fs from 'fs'
import path from 'path'
import TelegramBot from 'node-telegram-bot-api'
import type { Message } from 'node-telegram-bot-api'
import { db } from '../db/client'
import { logger } from '../utils/logger'
import { dispatch } from './dispatcher'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID || ''
const ACTIVITY_LOG_PATH = '/root/iae-agent/logs/activity.log'

let bot: TelegramBot | null = null

export function startTelegramBot(): void {
  if (!TOKEN) {
    logger.warn('Telegram bot not started - TELEGRAM_BOT_TOKEN not set')
    return
  }

  bot = new TelegramBot(TOKEN, { polling: true })
  logger.info('Telegram bot started (polling)')

  bot.on('message', async (msg: Message) => {
    const chatId = String(msg.chat.id)

    if (!ALLOWED_CHAT_ID) {
      logger.info(`Telegram message from unwhitelisted chat: ${chatId}`)
      await bot!.sendMessage(chatId, `Your chat ID is: ${chatId}\nAdd TELEGRAM_ALLOWED_CHAT_ID=${chatId} to .env and restart.`)
      return
    }

    if (chatId !== ALLOWED_CHAT_ID) return

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

  bot.on('polling_error', (err: Error) => {
    logger.error('Telegram polling error', { error: err.message })
  })

  scheduleDailySummary()
}

export function sendTelegramMessage(text: string): void {
  if (!bot || !ALLOWED_CHAT_ID) return
  bot.sendMessage(ALLOWED_CHAT_ID, text, { parse_mode: 'Markdown' }).catch((err: Error) => {
    logger.warn('Failed to send Telegram message', { error: err.message })
  })
}

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
  const next = new Date(now)
  next.setUTCHours(16, 0, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)

  const delay = next.getTime() - now.getTime()
  setTimeout(() => {
    void sendDailySummary()
    setInterval(() => {
      void sendDailySummary()
    }, 24 * 60 * 60 * 1000)
  }, delay)
}

async function sendDailySummary(): Promise<void> {
  if (!bot || !ALLOWED_CHAT_ID) return

  try {
    const today = new Date().toISOString().slice(0, 10)

    const [sent, received, outcomes, errors] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM message_log WHERE direction='outbound' AND created_at::date = $1::date`, [today]),
      db.query(`SELECT COUNT(*) FROM message_log WHERE direction='inbound' AND created_at::date = $1::date`, [today]),
      db.query(
        `SELECT tag, COUNT(*) AS count
         FROM (
           SELECT UNNEST(tags) AS tag
           FROM contacts
           WHERE updated_at::date = $1::date
         ) t
         WHERE tag IN ('buyer_qualified', 'interested_in_purchasing', 'not_interested', 'already_purchased', 'renting')
         GROUP BY tag
         ORDER BY count DESC
         LIMIT 5`,
        [today]
      ),
      db.query(`SELECT COUNT(*) FROM email_log WHERE category='alert' AND created_at::date = $1::date`, [today]),
    ])

    const dateLabel = new Date().toLocaleDateString('en-ZA', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Africa/Johannesburg',
    })
    const outcomeLines = outcomes.rows.map((r: any) => `  ${r.tag}: ${r.count}`).join('\n') || '  None'

    const msg = [
      `Daily Summary - ${dateLabel}`,
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
