import axios from 'axios'
import { SendResult } from '../utils/types'
import { logger } from '../utils/logger'

const META_API_BASE = 'https://graph.facebook.com/v19.0'
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '27'

// Send an approved WhatsApp template message with dynamic variable substitution.
// On Meta's side, template body placeholders are {{1}}, {{2}}, etc.
// Pass variables in that order — e.g. ['John', 'Smith'] fills {{1}}=John, {{2}}=Smith.
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  variables: string[],
  phoneNumberId: string,
  accessToken: string
): Promise<SendResult> {
  try {
    const components = variables.length > 0
      ? [{
          type: 'body',
          parameters: variables.map((v) => ({ type: 'text', text: v })),
        }]
      : []

    const res = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanPhone(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en_US' },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    )
    return { success: true, message_id: res.data?.messages?.[0]?.id }
  } catch (err: any) {
    const errorMsg = err.response?.data?.error?.message || err.message
    logger.error('WhatsApp template send failed', { to, templateName, error: errorMsg })
    return { success: false, error: errorMsg }
  }
}

export async function sendWhatsAppMessage(
  to: string,
  message: string,
  phoneNumberId: string,
  accessToken: string
): Promise<SendResult> {
  try {
    const res = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanPhone(to),
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    )
    return { success: true, message_id: res.data?.messages?.[0]?.id }
  } catch (err: any) {
    const errorMsg = err.response?.data?.error?.message || err.message
    logger.error('WhatsApp send failed', { to, error: errorMsg })
    return { success: false, error: errorMsg }
  }
}

// Normalise phone number to E.164 format (digits only, no leading +)
function cleanPhone(phone: string): string {
  const trimmed = phone.trim()
  let digits: string

  if (trimmed.startsWith('+')) {
    digits = trimmed.slice(1).replace(/\D/g, '')
  } else {
    digits = trimmed.replace(/\D/g, '')
    if (digits.startsWith('00')) {
      digits = digits.slice(2)
    } else if (digits.startsWith('0')) {
      digits = `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`
    }
  }

  if (digits.length < 7 || digits.length > 15) {
    throw new Error(`Invalid phone number format: "${phone}"`)
  }

  return digits
}
