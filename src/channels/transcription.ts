import axios from 'axios'
import FormData from 'form-data'
import { logger } from '../utils/logger'

const META_API_BASE = 'https://graph.facebook.com/v19.0'
const OPENAI_API_BASE = 'https://api.openai.com/v1/audio/transcriptions'

/**
 * Download a WhatsApp voice note from Meta's media server
 * @param mediaId - The media_id from the incoming WhatsApp webhook
 * @param phoneNumberId - The WhatsApp Business phone number ID
 * @param accessToken - WhatsApp Business API access token
 * @returns Object with buffer (audio data) and mimeType
 */
export async function downloadWhatsAppAudio(
  mediaId: string,
  phoneNumberId: string,
  accessToken: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    // Step 1: Get the media URL from Meta API
    const mediaRes = await axios.get(
      `${META_API_BASE}/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30_000,
      }
    )

    const mediaUrl = mediaRes.data?.url
    const mimeType = mediaRes.data?.mime_type || 'audio/ogg'

    if (!mediaUrl) {
      throw new Error('No media URL returned from Meta API')
    }

    // Step 2: Download the audio file
    const audioRes = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: 'arraybuffer',
      timeout: 30_000,
    })

    const buffer = Buffer.from(audioRes.data)
    logger.info('WhatsApp audio downloaded', { mediaId, size: buffer.length, mimeType })

    return { buffer, mimeType }
  } catch (err: any) {
    const errorMsg = err.response?.data?.error?.message || err.message
    logger.error('Failed to download WhatsApp audio', { mediaId, error: errorMsg })
    throw new Error(`WhatsApp media download failed: ${errorMsg}`)
  }
}

/**
 * Transcribe audio using OpenAI Whisper API
 * @param audioBuffer - The audio file as a Buffer
 * @param mimeType - MIME type of the audio (e.g. 'audio/ogg')
 * @param openaiApiKey - OpenAI API key
 * @returns Transcribed text
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  openaiApiKey: string
): Promise<string> {
  try {
    // Build FormData with the audio file
    const form = new FormData()
    form.append('file', audioBuffer, {
      filename: 'audio.ogg',
      contentType: mimeType,
    })
    form.append('model', 'whisper-1')
    // No language specified — Whisper auto-detects (supports English, Afrikaans, etc.)

    const res = await axios.post(OPENAI_API_BASE, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${openaiApiKey}`,
      },
      timeout: 120_000, // Whisper can be slow for long audio
    })

    const transcribedText = res.data?.text
    if (!transcribedText) {
      throw new Error('No transcription returned from Whisper API')
    }

    logger.info('Audio transcribed successfully', { length: transcribedText.length })
    return transcribedText
  } catch (err: any) {
    const errorMsg = err.response?.data?.error?.message || err.message
    logger.error('Whisper transcription failed', { error: errorMsg })
    throw new Error(`Whisper transcription failed: ${errorMsg}`)
  }
}
