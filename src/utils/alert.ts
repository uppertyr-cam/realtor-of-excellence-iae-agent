import nodemailer from 'nodemailer'

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

  nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: APP_PASSWORD },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  }).sendMail({
    from: `IAE Agent <${FROM_EMAIL}>`,
    to: REPORT_EMAIL,
    subject: `[IAE Alert] ${subject}`,
    text: body,
  }).catch(() => {})
}
