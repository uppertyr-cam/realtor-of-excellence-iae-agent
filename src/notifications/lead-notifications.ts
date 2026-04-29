import nodemailer from 'nodemailer'
import { logger } from '../utils/logger'

type NotificationOutcome =
  | 'buyer_qualified'
  | 'interested_in_purchasing'
  | 'not_interested'
  | 'already_purchased'

type NotificationContact = {
  first_name: string | null
  last_name: string | null
  phone_number: string
  email: string | null
  crm_callback_url: string | null
}

const NOTIFICATION_FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || process.env.FROM_EMAIL || ''
const NOTIFICATION_APP_PASSWORD = process.env.NOTIFICATION_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD || ''
const CC_EMAIL = 'cameron@uppertyr.com'
const TEST_TO_EMAIL = process.env.NOTIFICATION_TEST_TO || ''

const FOOTER_HTML = `
  <div style="background:#0B1220;padding:28px 36px 34px 36px;border-top:1px solid rgba(92,225,230,0.18);">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="vertical-align:top;">
          <div style="font-family:Georgia,'Times New Roman',serif;color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:0.4px;">
            UpperTyr
          </div>
          <div style="margin-top:8px;font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#5CE1E6;">
            Automate smarter, grow faster
          </div>
        </td>
        <td style="vertical-align:bottom;text-align:right;padding-left:24px;">
          <div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#9CA3AF;">
            CEO Cameron Britt
          </div>
          <div style="margin-top:4px;font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#FFFFFF;">
            +27 76 153 6498
          </div>
        </td>
      </tr>
    </table>
  </div>
`

function fullName(contact: NotificationContact) {
  return `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown Lead'
}

function crmLink(contact: NotificationContact) {
  if (!contact.crm_callback_url) return '—'
  return `<a href="${contact.crm_callback_url}" style="color:#5CE1E6;text-decoration:none;font-weight:700;">Open in CRM</a>`
}

function actionLink(contact: NotificationContact) {
  return contact.crm_callback_url || '#'
}

function buildEmailHtml(params: {
  label: string
  heading: string
  headingColor: string
  greeting: string
  bodyCopy: string
  contact: NotificationContact
}) {
  const { label, heading, headingColor, greeting, bodyCopy, contact } = params

  return `
    <div style="margin:0;padding:32px 16px;background:#E8EDF2;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          <td align="center">
            <table role="presentation" style="width:100%;max-width:720px;border-collapse:collapse;background:#FFFFFF;border:1px solid #D7DEE7;border-radius:18px;overflow:hidden;box-shadow:0 18px 40px rgba(11,18,32,0.12);">
              <tr>
                <td style="background:#0B1220;height:8px;font-size:0;line-height:0;">&nbsp;</td>
              </tr>
              <tr>
                <td style="background:#FFFFFF;padding:26px 36px 30px 36px;border-bottom:1px solid #E2E8F0;">
                  <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#5CE1E6;padding-bottom:10px;">
                    ${label}
                  </div>
                  <div style="font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.08;color:#0B1220;font-weight:700;letter-spacing:-0.8px;">
                    ${fullName(contact)}
                  </div>
                  <div style="margin-top:10px;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:${headingColor};">
                    ${heading}
                  </div>
                  <div style="margin-top:22px;width:72px;height:2px;background:#5CE1E6;"></div>
                </td>
              </tr>
              <tr>
                <td style="background:#F9FAFB;padding:28px 36px 24px 36px;">
                  <p style="margin:0 0 14px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#374151;">${greeting}</p>
                  <p style="margin:0 0 20px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#4B5563;">${bodyCopy}</p>
                  <div style="background:#FFFFFF;border:1px solid rgba(92,225,230,0.2);border-radius:14px;padding:18px 20px;">
                    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#374151;">📞&nbsp; Phone: ${contact.phone_number}</div>
                    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#374151;">✉️&nbsp; Email: ${contact.email || 'Not provided'}</div>
                    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#374151;">🔗&nbsp; CRM: ${crmLink(contact)}</div>
                  </div>
                  <div style="margin-top:24px;text-align:center;">
                    <a href="${actionLink(contact)}" style="display:inline-block;background:#5CE1E6;color:#0B1220;padding:14px 30px;border-radius:8px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:800;">View in CRM</a>
                  </div>
                </td>
              </tr>
              <tr>
                <td>${FOOTER_HTML}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `
}

function getConfig(contact: NotificationContact, outcome: NotificationOutcome) {
  const name = fullName(contact)

  switch (outcome) {
    case 'buyer_qualified':
      return {
        to: 'sean@realgroup.co.za,charmaine@realgroup.co.za,reception@realgroup.co.za',
        subject: `[Buyer Qualified] ${name}`,
        html: buildEmailHtml({
          label: 'LEAD NOTIFICATION — BUYER QUALIFIED',
          heading: 'Qualified Buyer',
          headingColor: '#5CE1E6',
          greeting: 'Hi Vennessa,',
          bodyCopy: `Great news — <strong>${name}</strong> has been through the full AI qualification conversation and is confirmed interested in purchasing a property. Please reach out and take it from here.`,
          contact,
        }),
      }
    case 'interested_in_purchasing':
      return {
        to: 'sean@realgroup.co.za,reception@realgroup.co.za,charmaine@realgroup.co.za',
        subject: `[Buyer Interested] ${name} — Qualification Pending`,
        html: buildEmailHtml({
          label: 'LEAD NOTIFICATION — BUYER INTERESTED',
          heading: 'Interested in Buying — Not Yet Qualified',
          headingColor: '#5CE1E6',
          greeting: 'Hi Vennessa,',
          bodyCopy: `<strong>${name}</strong> has expressed interest in purchasing a property but has not yet completed full qualification. Please follow up and progress the qualification process when ready.`,
          contact,
        }),
      }
    case 'not_interested':
      return {
        to: 'charmaine@realgroup.co.za,dorinda@realgroup.co.za,sean@realgroup.co.za',
        subject: `[Not Interested] ${name}`,
        html: buildEmailHtml({
          label: 'LEAD NOTIFICATION — NOT INTERESTED',
          heading: 'Lead is No Longer Interested',
          headingColor: '#9CA3AF',
          greeting: 'Hi Charmaine,',
          bodyCopy: `<strong>${name}</strong> has indicated they are not interested in purchasing a property at this time. Please update Follow Up Boss and close the lead accordingly.`,
          contact,
        }),
      }
    case 'already_purchased':
      return {
        to: 'charmaine@realgroup.co.za,dorinda@realgroup.co.za,sean@realgroup.co.za',
        subject: `[Already Purchased] ${name}`,
        html: buildEmailHtml({
          label: 'LEAD NOTIFICATION — ALREADY PURCHASED',
          heading: 'Has Already Purchased a Property',
          headingColor: '#9CA3AF',
          greeting: 'Hi Charmaine,',
          bodyCopy: `<strong>${name}</strong> has already purchased a property. Please update Follow Up Boss and archive the lead.`,
          contact,
        }),
      }
  }
}

export async function sendLeadNotification(contact: NotificationContact, outcome: NotificationOutcome): Promise<void> {
  if (!NOTIFICATION_FROM_EMAIL || !NOTIFICATION_APP_PASSWORD) {
    logger.warn('Lead notification skipped — missing notification email credentials', { outcome })
    return
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: NOTIFICATION_FROM_EMAIL,
      pass: NOTIFICATION_APP_PASSWORD.replace(/\s/g, ''),
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  const config = getConfig(contact, outcome)

  await transporter.sendMail({
    from: `Cameron Britt <${NOTIFICATION_FROM_EMAIL}>`,
    to: TEST_TO_EMAIL || config.to,
    cc: TEST_TO_EMAIL ? undefined : CC_EMAIL,
    subject: config.subject,
    html: config.html,
  })
}
