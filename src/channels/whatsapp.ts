import axios from 'axios'
import { SendResult } from '../utils/types'
import { logger } from '../utils/logger'

const META_API_BASE = 'https://graph.facebook.com/v19.0'
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '27'

// Validate if a number is on WhatsApp using the contacts API
// This does NOT send any message to the user
export async function validateWhatsAppNumber(
  phoneNumber: string,
  phoneNumberId: string,
  accessToken: string
): Promise<boolean> {
  try {
    const clean = cleanPhone(phoneNumber)
    const res = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/contacts`,
      {
        messaging_product: 'whatsapp',
        contacts: [clean],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      }
    )

    // contacts API returns wa_id if the number is on WhatsApp
    const contact = res.data?.contacts?.[0]
    if (contact?.wa_id) return true

    // If API returned an error (e.g. not supported for this account), skip validation and proceed
    if (res.data?.error) {
      logger.warn('WhatsApp contacts API not available — skipping validation', { error: res.data.error.message })
      return true
    }

    return false
  } catch (err: any) {
    logger.error('WhatsApp validation error', { phone: phoneNumber, error: err.message })
    return true // Skip validation on network errors — let the send attempt fail if number is invalid
  }
}

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

// Normalise phone number to E.164 format
function cleanPhone(phone: string): string {
  const trimmed = phone.trim()
  if (trimmed.startsWith('+')) {
    return trimmed.slice(1).replace(/\D/g, '')
  }

  const digits = trimmed.replace(/\D/g, '')
  if (digits.startsWith('00')) {
    return digits.slice(2)
  }
  if (digits.startsWith('0')) {
    return `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`
  }
  return digits
}
