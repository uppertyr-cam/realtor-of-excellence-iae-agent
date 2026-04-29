import { Pool } from 'pg'
import { logger } from '../utils/logger'
import dotenv from 'dotenv'

// Load environment variables from .env
dotenv.config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { error: err.message })
})

export const db = {
  query: async (text: string, params?: any[]) => {
    const start = Date.now()
    const res = await pool.query(text, params)
    const duration = Date.now() - start
    if (duration > 1000) {
      logger.warn('Slow query detected', { text, duration })
    }
    return res
  },

  // Acquire a processing lock on a contact
  // Returns true if lock was acquired, false if already locked
  acquireLock: async (contactId: string): Promise<boolean> => {
    const res = await pool.query(
      `UPDATE contacts
       SET processing_locked = TRUE, processing_locked_at = NOW()
       WHERE id = $1 AND processing_locked = FALSE
       RETURNING id`,
      [contactId]
    )
    return res.rowCount! > 0
  },

  // Release the processing lock
  releaseLock: async (contactId: string): Promise<void> => {
    await pool.query(
      `UPDATE contacts SET processing_locked = FALSE, processing_locked_at = NULL WHERE id = $1`,
      [contactId]
    )
  },

  // Force release stale locks older than 2 minutes (safety net)
  releaseStaleLocks: async (): Promise<void> => {
    await pool.query(
      `UPDATE contacts
       SET processing_locked = FALSE, processing_locked_at = NULL
       WHERE processing_locked = TRUE
       AND processing_locked_at < NOW() - INTERVAL '2 minutes'`
    )
  },
}

export default pool
