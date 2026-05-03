import { db } from '../db/client'

export async function listEmailInbox(search = '') {
  const term = `%${search.trim().toLowerCase()}%`
  const result = await db.query(
    `SELECT
       e.id,
       e.contact_id,
       e.client_id,
       e.category,
       e.outcome,
       e.recipient_to,
       e.recipient_cc,
       e.subject,
       e.html_body,
       e.send_status,
       e.provider_message_id,
       e.error,
       e.created_at,
       cl.name AS client_name,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.phone_number, c.id) AS contact_name,
       c.phone_number,
       c.email AS contact_email
     FROM email_log e
     LEFT JOIN contacts c ON c.id = e.contact_id
     LEFT JOIN clients cl ON cl.id = e.client_id
     WHERE (
         $1 = '%%'
         OR LOWER(COALESCE(e.subject, '')) LIKE $1
         OR LOWER(COALESCE(e.recipient_to, '')) LIKE $1
         OR LOWER(COALESCE(e.category, '')) LIKE $1
         OR LOWER(COALESCE(e.outcome, '')) LIKE $1
         OR LOWER(COALESCE(cl.name, '')) LIKE $1
         OR LOWER(COALESCE(c.first_name, '')) LIKE $1
         OR LOWER(COALESCE(c.last_name, '')) LIKE $1
         OR LOWER(COALESCE(c.phone_number, '')) LIKE $1
       )
     ORDER BY e.created_at DESC
     LIMIT 250`,
    [term]
  )

  return result.rows
}
