import { exec } from 'child_process'
import fs from 'fs'
import { promisify } from 'util'
import { db } from '../db/client'
import { handleCrmWebhook } from '../workflows/outbound-first-message'

const execAsync = promisify(exec)

export async function getStatus(): Promise<string> {
  const [contacts, queue, locked] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM contacts WHERE workflow_stage != 'closed'`),
    db.query(`SELECT COUNT(*) FROM outbound_queue WHERE status = 'pending'`),
    db.query(`SELECT COUNT(*) FROM contacts WHERE processing_locked = TRUE`),
  ])

  return [
    `*System Status*`,
    `Active contacts: ${contacts.rows[0].count}`,
    `In queue (not yet sent): ${queue.rows[0].count}`,
    `Processing locks held: ${locked.rows[0].count}`,
  ].join('\n')
}

export async function getContacts(limit = 10): Promise<string> {
  const res = await db.query(
    `SELECT first_name, last_name, phone_number, tags, first_message_sent, updated_at
     FROM contacts
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  )

  if (!res.rows.length) return 'No contacts found.'

  const lines = res.rows.map((r: any) => {
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown'
    const sent = r.first_message_sent ? 'yes' : 'pending'
    const tags = Array.isArray(r.tags) && r.tags.length ? r.tags.join(', ') : 'no tags'
    return `- ${name} (${r.phone_number}) | first message: ${sent} | ${tags}`
  })

  return `*Recent Contacts (${limit})*\n${lines.join('\n')}`
}

export async function getRecentEvents(limit = 20): Promise<string> {
  const res = await db.query(
    `SELECT ml.direction, ml.content, ml.created_at,
            c.first_name, c.last_name
     FROM message_log ml
     LEFT JOIN contacts c ON c.id = ml.contact_id
     ORDER BY ml.created_at DESC
     LIMIT $1`,
    [limit]
  )

  if (!res.rows.length) return 'No recent events.'

  const lines = res.rows.map((r: any) => {
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown'
    const dir = r.direction === 'inbound' ? 'inbound' : 'outbound'
    const preview = String(r.content || '').replace(/\s+/g, ' ').slice(0, 60)
    return `- ${dir} | ${name}: ${preview}`
  })

  return `*Recent Messages*\n${lines.join('\n')}`
}

export async function getDailySummary(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)
  const [sent, received, qualified] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM message_log WHERE direction='outbound' AND created_at::date = $1::date`, [today]),
    db.query(`SELECT COUNT(*) FROM message_log WHERE direction='inbound' AND created_at::date = $1::date`, [today]),
    db.query(
      `SELECT first_name, last_name
       FROM contacts
       WHERE 'buyer_qualified' = ANY(tags)
         AND updated_at::date = $1::date`,
      [today]
    ),
  ])

  const qualNames = qualified.rows
    .map((r: any) => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown')
    .join(', ') || 'None'

  return [
    `*Today's Summary*`,
    `Sent: ${sent.rows[0].count}`,
    `Received: ${received.rows[0].count}`,
    `Qualified today: ${qualNames}`,
  ].join('\n')
}

export async function runBash(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000, cwd: '/root/iae-agent' })
    const out = (stdout || '').trim()
    const err = (stderr || '').trim()
    if (!out && !err) return '(no output)'
    return [out, err].filter(Boolean).join('\n').slice(0, 3000)
  } catch (err: any) {
    return `Error: ${err.message}`.slice(0, 1000)
  }
}

export async function readFile(filePath: string): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.slice(0, 3000)
  } catch (err: any) {
    return `Cannot read file: ${err.message}`
  }
}

export async function getActivityLog(): Promise<string> {
  return readFile('/root/iae-agent/logs/activity.log')
}

export async function restartServer(): Promise<string> {
  return runBash('pm2 restart iae-agent')
}

export async function approveImport(): Promise<string> {
  const pending = await db.query(
    `SELECT id, contacts FROM bulk_import_pending WHERE status='pending' ORDER BY created_at DESC LIMIT 1`
  )
  if (!pending.rows.length) return 'No pending import found. Nothing to approve.'

  const { id, contacts } = pending.rows[0]
  const list: any[] = contacts

  for (const contact of list) {
    handleCrmWebhook({
      contact_id:            contact.contact_id,
      phone_number:          contact.phone,
      phone_numbers:         contact.phone_numbers,
      first_name:            contact.first_name,
      last_name:             contact.last_name,
      email:                 contact.email,
      client_id:             contact.client_id,
      assigned_to:           contact.assigned_to,
      crm_last_contacted_at: contact.last_contacted,
      crm_type:              'followupboss',
      crm_callback_url:      '',
    }, 'followupboss').catch(() => {})
    await new Promise(r => setTimeout(r, 200))
  }

  await db.query(`UPDATE bulk_import_pending SET status='approved' WHERE id=$1`, [id])
  return `✅ Import approved. ${list.length} contact${list.length !== 1 ? 's' : ''} queued for outreach.`
}

export async function skipImport(): Promise<string> {
  const pending = await db.query(
    `SELECT id FROM bulk_import_pending WHERE status='pending' ORDER BY created_at DESC LIMIT 1`
  )
  if (!pending.rows.length) return 'No pending import found.'
  await db.query(`UPDATE bulk_import_pending SET status='skipped' WHERE id=$1`, [pending.rows[0].id])
  return `⏭ Today's import skipped. No contacts queued.`
}
