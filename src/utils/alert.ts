import nodemailer from 'nodemailer'
import { db } from '../db/client'
import { sendTelegramMessage } from '../telegram/index'

export function noNumberEmail(contact: { name: string; phone: string; id: string }): void {
  const FROM_EMAIL   = process.env.FROM_EMAIL || ''
  const APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '')
  const TO           = process.env.NOTIFICATION_TO_CLOSED || '' // Charmaine
  const CC           = process.env.ALERT_EMAIL || ''

  if (!FROM_EMAIL || !APP_PASSWORD || !TO) return

  sendTelegramMessage(`No WhatsApp Number\nContact: ${contact.name} (${contact.phone})\nCharmaine has been emailed.`)

  const subject = `Action Required: No WhatsApp Number — ${contact.name}`

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e;padding:28px 32px;">
            <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;">Realtor of Excellence</p>
            <p style="margin:4px 0 0;color:#a0a0b0;font-size:13px;">AI Agent Notification</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 8px;color:#111;font-size:20px;font-weight:bold;">No Valid WhatsApp Number</p>
            <p style="margin:0 0 24px;color:#555;font-size:14px;line-height:1.6;">
              The AI agent attempted to send a first message to the contact below but could not reach them on WhatsApp.
              All available numbers were tried. Please update the contact in Follow Up Boss with a valid number,
              or mark them as not contactable.
            </p>

            <!-- Contact card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8fa;border-radius:6px;border:1px solid #e4e4e7;">
              <tr>
                <td style="padding:20px 24px;">
                  <p style="margin:0 0 12px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Contact Details</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:4px 16px 4px 0;color:#555;font-size:13px;white-space:nowrap;">Name</td>
                      <td style="padding:4px 0;color:#111;font-size:13px;font-weight:bold;">${contact.name}</td>
                    </tr>
                    <tr>
                      <td style="padding:4px 16px 4px 0;color:#555;font-size:13px;white-space:nowrap;">Number on File</td>
                      <td style="padding:4px 0;color:#111;font-size:13px;">${contact.phone}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Action needed -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:#fff8e1;border-radius:6px;border-left:4px solid #f59e0b;">
              <tr>
                <td style="padding:16px 20px;">
                  <p style="margin:0;color:#92400e;font-size:13px;font-weight:bold;">Action Required</p>
                  <p style="margin:6px 0 0;color:#92400e;font-size:13px;line-height:1.5;">
                    Please check Follow Up Boss for an updated number or mark this contact as not contactable.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;color:#aaa;font-size:12px;">
              This is an automated message from the Realtor of Excellence AI Agent.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: APP_PASSWORD },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  transporter.sendMail({
    from: `Realtor of Excellence AI <${FROM_EMAIL}>`,
    to: TO,
    cc: CC || undefined,
    subject,
    html,
  }).then((info) => {
    return db.query(
      `INSERT INTO email_log (category, recipient_to, subject, html_body, send_status, provider_message_id)
       VALUES ('notification', $1, $2, $3, 'sent', $4)`,
      [TO, subject, html, info.messageId || null]
    )
  }).catch(async (err) => {
    await db.query(
      `INSERT INTO email_log (category, recipient_to, subject, html_body, send_status, error)
       VALUES ('notification', $1, $2, $3, 'failed', $4)`,
      [TO, subject, html, err.message || 'noNumberEmail failed']
    ).catch(() => {})
  })
}

const cooldowns = new Map<string, number>()
const COOLDOWN_MS = 30 * 60 * 1000 // 30 min per subject — prevents email floods on repeated failures

export function alertEmail(subject: string, context: Record<string, unknown>): void {
  const last = cooldowns.get(subject) || 0
  if (Date.now() - last < COOLDOWN_MS) return
  cooldowns.set(subject, Date.now())
  sendTelegramMessage(`Alert: ${subject}\n${Object.entries(context).map(([k, v]) => `${k}: ${String(v)}`).join('\n')}`)
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
