export type AIUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export const PRICING = {
  sonnet: {
    input: 3.0 / 1_000_000,
    output: 15.0 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
    cacheRead: 0.3 / 1_000_000,
  },
  haiku: {
    input: 1.0 / 1_000_000,
    output: 5.0 / 1_000_000,
  },
} as const

const DEFAULT_WA_MARKETING_TEMPLATE_COST_USD = Number(process.env.DEFAULT_WA_MARKETING_TEMPLATE_COST_USD || '0.0436')

export function countLegacyTokens(usage: Pick<AIUsage, 'input_tokens' | 'output_tokens'>): number {
  return usage.input_tokens + usage.output_tokens
}

export function calcSonnetCost(usage: AIUsage): number {
  return usage.input_tokens * PRICING.sonnet.input +
    usage.output_tokens * PRICING.sonnet.output +
    (usage.cache_creation_input_tokens ?? 0) * PRICING.sonnet.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * PRICING.sonnet.cacheRead
}

export function calcHaikuCost(usage: Pick<AIUsage, 'input_tokens' | 'output_tokens'>): number {
  return usage.input_tokens * PRICING.haiku.input +
    usage.output_tokens * PRICING.haiku.output
}

export function getWhatsAppMarketingTemplateCostUsd(config: { wa_marketing_template_cost_usd?: number | string | null }): number {
  const raw = config.wa_marketing_template_cost_usd
  if (raw === null || raw === undefined || raw === '') return DEFAULT_WA_MARKETING_TEMPLATE_COST_USD
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : DEFAULT_WA_MARKETING_TEMPLATE_COST_USD
}
