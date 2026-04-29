import { db } from '../db/client'
import { ClientConfig } from '../utils/types'
import { logger } from '../utils/logger'

// Simple in-memory cache — refreshes every 5 minutes
const cache = new Map<string, { config: ClientConfig; expires: number }>()
const CACHE_TTL = 5 * 60 * 1000

export async function getClientConfig(clientId: string): Promise<ClientConfig> {
  const cached = cache.get(clientId)
  if (cached && cached.expires > Date.now()) {
    return cached.config
  }

  const res = await db.query('SELECT * FROM clients WHERE id = $1', [clientId])
  if (res.rowCount === 0) {
    throw new Error(`Client not found: ${clientId}`)
  }

  const config = res.rows[0] as ClientConfig
  cache.set(clientId, { config, expires: Date.now() + CACHE_TTL })
  logger.debug('Client config loaded', { clientId })
  return config
}

export function clearClientCache(clientId: string) {
  cache.delete(clientId)
}
