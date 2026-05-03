import nodemailer from 'nodemailer'
import { db } from '../db/client'

const cooldowns = new Map<string, number>()
const COOLDOWN_MS = 30 * 60 * 1000 // 30 min per subject — prevents email floods on repeated failures

export function alertEmail(subject: string, context: Record<string, unknown>): void {
  const last = cooldowns.get(subject) || 0
  if (Date.now() - last < COOLDOWN_MS) return
  cooldowns.set(subject, Date.now())
  const FROM_EMAIL   = process.env.FROM_EMAIL || ''
  const REPORT_EMAIL = process.env.ALERT_EMAIL || process.env.REPORT_EMAIL || ''
  const APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '')

  if (!FROM_EMAIL || !REPORT_EMAIL || !APP_PASSWORD) return

  const body = [
    subject,
    '',
    ...Object.entries(context).map(([k, v]) => `${k}: ${String(v)}`),
    '',
    `timestamp: ${new Date().toISOString()}`,
  ].join('\n')

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: APP_PASSWORD },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  transporter.sendMail({
    from: `IAE Agent <${FROM_EMAIL}>`,
    to: REPORT_EMAIL,
    subject: `[IAE Alert] ${subject}`,
    text: body,
  }).then((info) => {
    return db.query(
      `INSERT INTO email_log (
         category, recipient_to, subject, html_body, send_status, provider_message_id
       ) VALUES ('alert', $1, $2, $3, 'sent', $4)`,
      [REPORT_EMAIL, `[IAE Alert] ${subject}`, body.replace(/\n/g, '<br/>'), info.messageId || null]
    )
  }).catch(async (err) => {
    await db.query(
      `INSERT INTO email_log (
         category, recipient_to, subject, html_body, send_status, error
       ) VALUES ('alert', $1, $2, $3, 'failed', $4)`,
      [REPORT_EMAIL, `[IAE Alert] ${subject}`, body.replace(/\n/g, '<br/>'), err.message || 'Alert email failed']
    ).catch(() => {})
  })
}
