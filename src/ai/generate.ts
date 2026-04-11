import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { logger } from '../utils/logger'
import type { DetectedKeyword } from '../utils/types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const TIMEOUT_MS = 30_000
const MAX_RETRIES = 3

// Tool that lets Claude explicitly signal a routing outcome — more reliable than
// scanning the message text for embedded keyword phrases.
const ROUTE_LEAD_TOOL: Anthropic.Tool = {
  name: 'route_lead',
  description:
    'Signal the conversation outcome so the system can route the lead to the correct pipeline stage. ' +
    'Only call this tool when you are certain about the outcome. ' +
    'You can still include your normal reply message alongside this tool call.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [
          'not_interested',
          'renting',
          'reach_back_out',
          'senior_team_member',
          'interested_in_purchasing',
          'already_purchased',
        ],
        description: 'The routing outcome for this lead',
      },
      scheduled_at: {
        type: 'string',
        description:
          'ISO 8601 datetime string in Africa/Johannesburg timezone (UTC+2 offset). ' +
          'Required when action is "reach_back_out". ' +
          'Example: "2026-04-10T15:00:00+02:00"',
      },
    },
    required: ['action'],
  },
}

export async function generateAIResponse(params: {
  promptFilePath: string
  chatHistory: string
  leadData: Record<string, string>
  latestMessage: string
  clientName: string
}): Promise<{ text: string; keyword: DetectedKeyword; scheduledAt: string | null }> {
  // Read the prompt file fresh every time
  // This means you can edit the file and it takes effect immediately
  const promptPath = path.resolve(process.cwd(), params.promptFilePath)
  let systemPrompt: string

  try {
    systemPrompt = fs.readFileSync(promptPath, 'utf8')
  } catch (err) {
    logger.error('Could not read prompt file', { path: promptPath })
    throw new Error(`Prompt file not found: ${promptPath}`)
  }

  // Inject lead data + today's date into system prompt
  const todayJHB = new Date().toLocaleDateString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  let populatedPrompt = systemPrompt.replace(/{{current_date}}/g, todayJHB)
  for (const [key, value] of Object.entries(params.leadData)) {
    populatedPrompt = populatedPrompt.replace(new RegExp(`{{${key}}}`, 'g'), value)
  }

  const userMessage = `
CONVERSATION HISTORY:
${params.chatHistory || 'No previous conversation.'}

LATEST MESSAGE FROM LEAD:
${params.latestMessage}
`.trim()

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Generating AI response', { attempt, client: params.clientName })

      const response = await Promise.race([
        client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: [
            {
              type: 'text',
              text: populatedPrompt,
              cache_control: { type: 'ephemeral' },
            } as any,
          ],
          tools: [ROUTE_LEAD_TOOL],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: userMessage }],
        }, {
          headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI generation timeout')), TIMEOUT_MS)
        ),
      ])

      const rawText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text)
        .join('')
        .trim()

      // Extract only the content inside <message> tags — strips any reasoning Claude
      // writes before the actual reply. Falls back to raw text if no tags present.
      const tagMatch = rawText.match(/<message>([\s\S]*?)<\/message>/)
      const text = tagMatch ? tagMatch[1].trim() : rawText

      // Extract routing outcome from tool call if Claude signalled one
      const toolUse = response.content.find(
        (b) => b.type === 'tool_use' && (b as any).name === 'route_lead'
      ) as any | undefined

      const keyword: DetectedKeyword = toolUse
        ? (toolUse.input.action as DetectedKeyword)
        : 'none'

      const scheduledAt: string | null = toolUse?.input?.scheduled_at ?? null

      logger.info('AI response generated', { length: text.length, keyword, scheduledAt })
      return { text, keyword, scheduledAt }
    } catch (err: any) {
      lastError = err
      logger.warn('AI generation attempt failed', { attempt, error: err.message })
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s
        await sleep(1000 * Math.pow(2, attempt - 1))
      }
    }
  }

  throw lastError || new Error('AI generation failed after all retries')
}

export async function generateContactNote(chatHistory: string): Promise<string> {
  const promptPath = path.resolve(process.cwd(), 'prompts/ai-note-taker.txt')
  let promptTemplate: string
  try {
    promptTemplate = fs.readFileSync(promptPath, 'utf8')
  } catch (err) {
    logger.error('Could not read ai-note-taker prompt', { path: promptPath })
    throw new Error(`Note taker prompt file not found: ${promptPath}`)
  }

  const prompt = promptTemplate.replace(/{{conversation_history}}/g, chatHistory)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  })

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as any).text)
    .join('')
    .trim()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
