import axios from 'axios'
import { SendResult } from '../utils/types'
import { logger } from '../utils/logger'

export async function sendSmsMessage(
  to: string,
  message: string,
  accountSid: string,
  authToken: string,
  fromNumber: string
): Promise<SendResult> {
  try {
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      new URLSearchParams({ To: to, From: fromNumber, Body: message }),
      {
        auth: { username: accountSid, password: authToken },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
      }
    )
    return { success: true, message_id: res.data?.sid }
  } catch (err: any) {
    const errorMsg = err.response?.data?.message || err.message
    logger.error('SMS send failed', { to, error: errorMsg })
    return { success: false, error: errorMsg }
  }
}
