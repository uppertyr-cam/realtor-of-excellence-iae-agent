import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/client'

const SESSION_COOKIE = 'iae_inbox_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type InboxUser = {
  id: number
  email: string
  display_name: string | null
  is_active: boolean
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): string {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${digest}`
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [scheme, salt, digest] = storedHash.split('$')
  if (scheme !== 'scrypt' || !salt || !digest) return false
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(digest, 'hex'))
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || ''
  const pairs = header.split(';').map((value) => value.trim()).filter(Boolean)
  const cookies: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    cookies[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1))
  }
  return cookies
}

function setSessionCookie(res: Response, sessionId: string, expiresAt: Date) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(res: Response) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export async function createInboxUser(email: string, password: string, displayName?: string | null) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) throw new Error('Email is required')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  const result = await db.query(
    `INSERT INTO inbox_users (email, password_hash, display_name)
     VALUES ($1,$2,$3)
     RETURNING id, email, display_name, is_active`,
    [normalizedEmail, hashPassword(password), displayName?.trim() || null]
  )

  return result.rows[0] as InboxUser
}

export async function listInboxUsers() {
  const result = await db.query(
    `SELECT id, email, display_name, is_active, created_at, updated_at
     FROM inbox_users
     ORDER BY created_at ASC`
  )
  return result.rows
}

export async function setInboxUserActive(userId: number, isActive: boolean) {
  const result = await db.query(
    `UPDATE inbox_users
     SET is_active=$2, updated_at=NOW()
     WHERE id=$1
     RETURNING id, email, display_name, is_active`,
    [userId, isActive]
  )
  return result.rows[0] || null
}

async function createSession(userId: number) {
  const sessionId = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.query(`DELETE FROM inbox_sessions WHERE expires_at < NOW()`)
  await db.query(
    `INSERT INTO inbox_sessions (id, user_id, expires_at)
     VALUES ($1,$2,$3)`,
    [sessionId, userId, expiresAt]
  )
  return { sessionId, expiresAt }
}

export async function loginInboxUser(_req: Request, email: string, password: string, res: Response) {
  const normalizedEmail = normalizeEmail(email)
  const result = await db.query(
    `SELECT id, email, password_hash, display_name, is_active
     FROM inbox_users
     WHERE email=$1`,
    [normalizedEmail]
  )
  if (result.rowCount === 0) return null

  const user = result.rows[0]
  if (!user.is_active) return null
  if (!verifyPassword(password, user.password_hash)) return null

  const { sessionId, expiresAt } = await createSession(user.id)
  setSessionCookie(res, sessionId, expiresAt)

  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_active: user.is_active,
  } as InboxUser
}

export async function logoutInboxUser(req: Request, res: Response) {
  const cookies = parseCookies(req)
  const sessionId = cookies[SESSION_COOKIE]
  if (sessionId) {
    await db.query(`DELETE FROM inbox_sessions WHERE id=$1`, [sessionId])
  }
  clearSessionCookie(res)
}

export async function getInboxUserFromRequest(req: Request): Promise<InboxUser | null> {
  const cookies = parseCookies(req)
  const sessionId = cookies[SESSION_COOKIE]
  if (!sessionId) return null

  await db.query(`DELETE FROM inbox_sessions WHERE expires_at < NOW()`)
  const result = await db.query(
    `SELECT u.id, u.email, u.display_name, u.is_active
     FROM inbox_sessions s
     JOIN inbox_users u ON u.id = s.user_id
     WHERE s.id=$1
       AND s.expires_at > NOW()
       AND u.is_active = TRUE`,
    [sessionId]
  )
  if (result.rowCount === 0) return null

  await db.query(`UPDATE inbox_sessions SET last_seen_at=NOW() WHERE id=$1`, [sessionId]).catch(() => {})
  return result.rows[0] as InboxUser
}

export async function requireInboxAuth(req: Request, res: Response, next: NextFunction) {
  const user = await getInboxUserFromRequest(req)
  if (!user) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  ;(req as any).inboxUser = user
  next()
}
