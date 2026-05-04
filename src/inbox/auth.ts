import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/client'

const SESSION_COOKIE = 'iae_inbox_session'
const TRUSTED_DEVICE_COOKIE = 'iae_inbox_trusted_device'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOGIN_CHALLENGE_TTL_MS = 10 * 60 * 1000
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export type InboxUser = {
  id: number
  email: string
  display_name: string | null
  is_active: boolean
  two_factor_enabled?: boolean
}

type TwoFactorStatus = {
  enabled: boolean
  pending_setup: boolean
}

type LoginResult =
  | { user: InboxUser; requires_two_factor: false }
  | { user: Pick<InboxUser, 'id' | 'email' | 'display_name' | 'is_active'>; requires_two_factor: true; challenge_token: string }

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

function appendCookieHeader(res: Response, cookie: string) {
  const existing = res.getHeader('Set-Cookie')
  if (!existing) {
    res.setHeader('Set-Cookie', cookie)
    return
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie])
    return
  }
  res.setHeader('Set-Cookie', [String(existing), cookie])
}

function buildCookie(name: string, value: string, expiresAt: Date): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

function setSessionCookie(res: Response, sessionId: string, expiresAt: Date) {
  appendCookieHeader(res, buildCookie(SESSION_COOKIE, sessionId, expiresAt))
}

function clearCookie(res: Response, name: string) {
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  appendCookieHeader(res, parts.join('; '))
}

function clearSessionCookie(res: Response) {
  clearCookie(res, SESSION_COOKIE)
}

function setTrustedDeviceCookie(res: Response, value: string, expiresAt: Date) {
  appendCookieHeader(res, buildCookie(TRUSTED_DEVICE_COOKIE, value, expiresAt))
}

function clearTrustedDeviceCookie(res: Response) {
  clearCookie(res, TRUSTED_DEVICE_COOKIE)
}

function getTwoFactorEncryptionKey(): Buffer {
  const source = process.env.INBOX_2FA_ENCRYPTION_KEY || process.env.INTERNAL_WEBHOOK_SECRET || 'iae-inbox-2fa-fallback'
  return crypto.createHash('sha256').update(source).digest()
}

function encryptSecret(secret: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getTwoFactorEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null
  const [version, ivHex, tagHex, dataHex] = payload.split(':')
  if (version !== 'v1' || !ivHex || !tagHex || !dataHex) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', getTwoFactorEncryptionKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}

function bufferToBase32(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function base32ToBuffer(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let current = 0
  const bytes: number[] = []
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) continue
    current = (current << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function generateTwoFactorSecret(): string {
  return bufferToBase32(crypto.randomBytes(20))
}

function buildOtpAuthUrl(email: string, secret: string): string {
  const issuer = 'UpperTyr Inbox'
  const label = `${issuer}:${normalizeEmail(email)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

function generateTotp(secret: string, timestampMs = Date.now()): string {
  const counter = Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', base32ToBuffer(secret)).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff)
  return String(code % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0')
}

function verifyTotp(secret: string, code: string): boolean {
  const normalized = String(code || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(normalized)) return false
  for (let offset = -1; offset <= 1; offset += 1) {
    const candidate = generateTotp(secret, Date.now() + offset * TOTP_STEP_SECONDS * 1000)
    if (candidate === normalized) return true
  }
  return false
}

async function createLoginChallenge(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + LOGIN_CHALLENGE_TTL_MS)
  await db.query(`DELETE FROM inbox_login_challenges WHERE expires_at < NOW()`)
  await db.query(
    `INSERT INTO inbox_login_challenges (id, user_id, expires_at)
     VALUES ($1,$2,$3)`,
    [token, userId, expiresAt]
  )
  return token
}

async function getUserWithPassword(email: string) {
  const result = await db.query(
    `SELECT id, email, password_hash, display_name, is_active,
            two_factor_enabled, two_factor_secret_enc, two_factor_temp_secret_enc
     FROM inbox_users
     WHERE email=$1`,
    [email]
  )
  return result.rowCount ? result.rows[0] : null
}

function hashTrustedDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

async function findTrustedDevice(userId: number, rawCookie: string | undefined) {
  if (!rawCookie) return null
  const [deviceId, token] = String(rawCookie).split('.')
  if (!deviceId || !token) return null
  const tokenHash = hashTrustedDeviceToken(token)
  const result = await db.query(
    `SELECT id, user_id, expires_at
     FROM inbox_trusted_devices
     WHERE id=$1
       AND user_id=$2
       AND token_hash=$3
       AND revoked_at IS NULL
       AND expires_at > NOW()`,
    [deviceId, userId, tokenHash]
  )
  if (!result.rowCount) return null
  await db.query(`UPDATE inbox_trusted_devices SET last_used_at=NOW() WHERE id=$1`, [deviceId]).catch(() => {})
  return result.rows[0]
}

async function createTrustedDevice(userId: number, userAgent: string | null | undefined, res: Response) {
  const id = crypto.randomBytes(16).toString('hex')
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS)
  await db.query(`DELETE FROM inbox_trusted_devices WHERE expires_at < NOW() OR revoked_at IS NOT NULL`)
  await db.query(
    `INSERT INTO inbox_trusted_devices (id, user_id, token_hash, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, userId, hashTrustedDeviceToken(token), userAgent?.slice(0, 500) || null, expiresAt]
  )
  setTrustedDeviceCookie(res, `${id}.${token}`, expiresAt)
}

async function finalizeLogin(userId: number, res: Response) {
  const { sessionId, expiresAt } = await createSession(userId)
  setSessionCookie(res, sessionId, expiresAt)
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
    `SELECT id, email, display_name, is_active, two_factor_enabled, created_at, updated_at
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

export async function loginInboxUser(req: Request, email: string, password: string, res: Response) {
  const normalizedEmail = normalizeEmail(email)
  const user = await getUserWithPassword(normalizedEmail)
  if (!user) return null
  if (!user.is_active) return null
  if (!verifyPassword(password, user.password_hash)) return null

  const baseUser = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_active: user.is_active,
  } as InboxUser

  if (user.two_factor_enabled) {
    const trusted = await findTrustedDevice(user.id, parseCookies(req)[TRUSTED_DEVICE_COOKIE])
    if (trusted) {
      await finalizeLogin(user.id, res)
      return { user: { ...baseUser, two_factor_enabled: true }, requires_two_factor: false } as LoginResult
    }
    const challengeToken = await createLoginChallenge(user.id)
    return {
      user: baseUser,
      requires_two_factor: true,
      challenge_token: challengeToken,
    } as LoginResult
  }

  await finalizeLogin(user.id, res)
  return { user: baseUser, requires_two_factor: false } as LoginResult
}

export async function verifyInboxUserTwoFactor(challengeToken: string, code: string, trustDevice: boolean, userAgent: string | undefined, res: Response) {
  const result = await db.query(
    `SELECT c.id, c.user_id, u.email, u.display_name, u.is_active, u.two_factor_enabled, u.two_factor_secret_enc
     FROM inbox_login_challenges c
     JOIN inbox_users u ON u.id = c.user_id
     WHERE c.id=$1
       AND c.expires_at > NOW()`,
    [String(challengeToken || '').trim()]
  )
  if (result.rowCount === 0) return null

  const challenge = result.rows[0]
  if (!challenge.is_active || !challenge.two_factor_enabled) return null
  const secret = decryptSecret(challenge.two_factor_secret_enc)
  if (!secret || !verifyTotp(secret, code)) return null

  await db.query(`DELETE FROM inbox_login_challenges WHERE id=$1`, [challenge.id])
  await finalizeLogin(challenge.user_id, res)
  if (trustDevice) {
    await createTrustedDevice(challenge.user_id, userAgent, res)
  }
  return {
    id: challenge.user_id,
    email: challenge.email,
    display_name: challenge.display_name,
    is_active: challenge.is_active,
    two_factor_enabled: true,
  } as InboxUser
}

export async function logoutInboxUser(req: Request, res: Response) {
  const cookies = parseCookies(req)
  const sessionId = cookies[SESSION_COOKIE]
  if (sessionId) {
    await db.query(`DELETE FROM inbox_sessions WHERE id=$1`, [sessionId])
  }
  await db.query(`DELETE FROM inbox_login_challenges WHERE expires_at < NOW()`).catch(() => {})
  clearSessionCookie(res)
}

export async function getInboxUserFromRequest(req: Request): Promise<InboxUser | null> {
  const cookies = parseCookies(req)
  const sessionId = cookies[SESSION_COOKIE]
  if (!sessionId) return null

  await db.query(`DELETE FROM inbox_sessions WHERE expires_at < NOW()`)
  const result = await db.query(
    `SELECT u.id, u.email, u.display_name, u.is_active, u.two_factor_enabled
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

export async function getInboxUserTwoFactorStatus(userId: number): Promise<TwoFactorStatus> {
  const result = await db.query(
    `SELECT two_factor_enabled, two_factor_temp_secret_enc
     FROM inbox_users
     WHERE id=$1`,
    [userId]
  )
  if (result.rowCount === 0) throw new Error('User not found')
  const row = result.rows[0]
  return {
    enabled: Boolean(row.two_factor_enabled),
    pending_setup: Boolean(row.two_factor_temp_secret_enc),
  }
}

export async function beginInboxUserTwoFactorSetup(userId: number) {
  const userResult = await db.query(
    `SELECT email, two_factor_enabled
     FROM inbox_users
     WHERE id=$1`,
    [userId]
  )
  if (userResult.rowCount === 0) throw new Error('User not found')
  const user = userResult.rows[0]
  if (user.two_factor_enabled) throw new Error('Two-factor authentication is already enabled')

  const secret = generateTwoFactorSecret()
  await db.query(
    `UPDATE inbox_users
     SET two_factor_temp_secret_enc=$2, updated_at=NOW()
     WHERE id=$1`,
    [userId, encryptSecret(secret)]
  )

  return {
    secret,
    otpauth_url: buildOtpAuthUrl(user.email, secret),
  }
}

export async function confirmInboxUserTwoFactorSetup(userId: number, code: string): Promise<TwoFactorStatus> {
  const result = await db.query(
    `SELECT two_factor_temp_secret_enc
     FROM inbox_users
     WHERE id=$1`,
    [userId]
  )
  if (result.rowCount === 0) throw new Error('User not found')
  const secret = decryptSecret(result.rows[0].two_factor_temp_secret_enc)
  if (!secret) throw new Error('No pending two-factor setup found')
  if (!verifyTotp(secret, code)) throw new Error('Invalid authentication code')

  await db.query(
    `UPDATE inbox_users
     SET two_factor_secret_enc=$2,
         two_factor_temp_secret_enc=NULL,
         two_factor_enabled=TRUE,
         two_factor_enabled_at=NOW(),
         updated_at=NOW()
     WHERE id=$1`,
    [userId, encryptSecret(secret)]
  )

  return { enabled: true, pending_setup: false }
}

export async function disableInboxUserTwoFactor(userId: number, code: string): Promise<TwoFactorStatus> {
  const result = await db.query(
    `SELECT two_factor_secret_enc, two_factor_enabled
     FROM inbox_users
     WHERE id=$1`,
    [userId]
  )
  if (result.rowCount === 0) throw new Error('User not found')
  if (!result.rows[0].two_factor_enabled) throw new Error('Two-factor authentication is not enabled')
  const secret = decryptSecret(result.rows[0].two_factor_secret_enc)
  if (!secret || !verifyTotp(secret, code)) throw new Error('Invalid authentication code')

  await db.query(
    `UPDATE inbox_users
     SET two_factor_enabled=FALSE,
         two_factor_secret_enc=NULL,
         two_factor_temp_secret_enc=NULL,
         two_factor_enabled_at=NULL,
         updated_at=NOW()
     WHERE id=$1`,
    [userId]
  )
  await db.query(`UPDATE inbox_trusted_devices SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [userId])

  return { enabled: false, pending_setup: false }
}

export async function revokeCurrentTrustedDevice(req: Request, userId: number, res: Response): Promise<void> {
  const rawCookie = parseCookies(req)[TRUSTED_DEVICE_COOKIE]
  const [deviceId] = String(rawCookie || '').split('.')
  if (deviceId) {
    await db.query(
      `UPDATE inbox_trusted_devices
       SET revoked_at=NOW()
       WHERE id=$1 AND user_id=$2`,
      [deviceId, userId]
    ).catch(() => {})
  }
  clearTrustedDeviceCookie(res)
}

export async function requireInboxAuth(req: Request, res: Response, next: NextFunction) {
  const user = await getInboxUserFromRequest(req)
  if (!user) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  ;(req as any).inboxUser = user
  next()
}
