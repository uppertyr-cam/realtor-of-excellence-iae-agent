// ============================================================
// LIVE DASHBOARD — Google Sheets
// One persistent sheet per client, updated in real-time as
// contacts move through the pipeline.
// ============================================================

import { google } from 'googleapis'
import { db } from '../db/client'
import { logger } from '../utils/logger'

// ─── CATEGORIES (order = column order in the sheet) ──────────
const CATEGORIES = [
  { label: 'Never Responded',                  tag: 'bump_no_reply',            color: { red: 0.6,   green: 0.6,   blue: 0.6   } },
  { label: 'New Message Sent / No Response Yet', tag: '__new_message__',         color: { red: 0.984, green: 0.737, blue: 0.020 } },
  { label: 'Lead Responded',                   tag: '__responded__',             color: { red: 0.204, green: 0.659, blue: 0.325 } },
  { label: 'Interested in Purchasing',         tag: 'interested_in_purchasing',  color: { red: 0.263, green: 0.627, blue: 0.278 } },
  { label: 'Buyer Already Purchased',          tag: 'already_purchased',         color: { red: 0.118, green: 0.533, blue: 0.898 } },
  { label: 'Interested in Renting',            tag: 'renting',                   color: { red: 0.984, green: 0.549, blue: 0.000 } },
  { label: 'Not Interested',                   tag: 'not_interested',            color: { red: 0.898, green: 0.224, blue: 0.208 } },
  { label: 'Reach Back Out',                   tag: 'reach_back_out',            color: { red: 0.608, green: 0.282, blue: 0.737 } },
  { label: 'DND (Do Not Disturb)',             tag: 'goodbye_killswitch',        color: { red: 0.2,   green: 0.2,   blue: 0.2   } },
]

// ─── CATEGORISE A SINGLE CONTACT ─────────────────────────────
function categorise(contact: any): string {
  const tags: string[] = contact.tags || []
  if (tags.includes('goodbye_killswitch'))        return 'goodbye_killswitch'
  if (tags.includes('not_interested'))            return 'not_interested'
  if (tags.includes('already_purchased'))         return 'already_purchased'
  if (tags.includes('interested_in_purchasing'))  return 'interested_in_purchasing'
  if (tags.includes('renting'))                   return 'renting'
  if (tags.includes('reach_back_out_sent'))       return '__responded__'
  if (tags.includes('reach_back_out'))            return 'reach_back_out'
  if (tags.includes('bump_no_reply'))             return 'bump_no_reply'
  // Has at least one LEAD: line in memory = they replied
  const mem: string = contact.ai_memory || ''
  if (mem.includes('LEAD:')) return '__responded__'
  // Message sent but no reply yet
  return '__new_message__'
}

// ─── AUTH ─────────────────────────────────────────────────────
function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return auth
}

// ─── MAIN ENTRY POINT ────────────────────────────────────────
export async function updateDashboard(clientId: string): Promise<void> {
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })
    const drive  = google.drive({ version: 'v3', auth })

    // Load client
    const clientRes = await db.query('SELECT * FROM clients WHERE id=$1', [clientId])
    if (clientRes.rowCount === 0) return
    const client = clientRes.rows[0]

    // ── Get or create the persistent dashboard sheet ──────────
    let spreadsheetId: string = client.dashboard_sheet_id || ''

    if (!spreadsheetId) {
      const created = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: `${client.name} — IAE Reports` },
          sheets: [{ properties: { title: 'Dashboard', sheetId: 0 } }]
        }
      })
      spreadsheetId = created.data.spreadsheetId!
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: { role: 'writer', type: 'user', emailAddress: 'cameron@hyperzenai.com' }
      })
      await db.query('UPDATE clients SET dashboard_sheet_id=$1 WHERE id=$2', [spreadsheetId, clientId])
      logger.info('Dashboard sheet created', { clientId, spreadsheetId })
    }

    // ── Fetch all contacts for this client ────────────────────
    const contactsRes = await db.query(
      `SELECT * FROM contacts WHERE client_id=$1 ORDER BY updated_at DESC`,
      [clientId]
    )

    // ── Sort contacts into buckets ────────────────────────────
    const buckets: Record<string, any[]> = {}
    for (const cat of CATEGORIES) buckets[cat.tag] = []
    for (const contact of contactsRes.rows) {
      const cat = categorise(contact)
      if (buckets[cat]) buckets[cat].push(contact)
    }

    // ── Build sheet data ──────────────────────────────────────
    const maxContacts = Math.max(...CATEGORIES.map(c => buckets[c.tag].length), 0)
    const headers = CATEGORIES.map(c => c.label)
    const countRow = CATEGORIES.map(c => `${buckets[c.tag].length}`)

    const values: any[][] = [headers, countRow]
    for (let r = 0; r < maxContacts; r++) {
      values.push(
        CATEGORIES.map(c => {
          const contact = buckets[c.tag][r]
          if (!contact) return ''
          const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
          return name + (contact.phone_number ? `\n${contact.phone_number}` : '')
        })
      )
    }

    // ── Ensure Dashboard tab exists ───────────────────────────
    const meta = await sheets.spreadsheets.get({ spreadsheetId })
    const existing = meta.data.sheets || []
    let dashSheet = existing.find(s => s.properties?.title === 'Dashboard')
    let sheetId: number

    // ── Delete legacy "Contact Notes" tab if it still exists ──
    const legacyTab = existing.find(s => s.properties?.title === 'Contact Notes')
    if (legacyTab) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ deleteSheet: { sheetId: legacyTab.properties!.sheetId! } }] }
      })
      logger.info('Deleted legacy Contact Notes tab', { spreadsheetId })
    }

    const setupRequests: any[] = []

    if (!dashSheet) {
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Dashboard' } } }] }
      })
      sheetId = addRes.data.replies![0].addSheet!.properties!.sheetId!
    } else {
      sheetId = dashSheet.properties!.sheetId!
    }

    // ── Write values ──────────────────────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Dashboard!A1',
      valueInputOption: 'RAW',
      requestBody: { values }
    })

    // Clear stale rows from previous run
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `Dashboard!A${values.length + 1}:ZZ`
    })

    // ── Formatting ────────────────────────────────────────────
    // Freeze header
    setupRequests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount'
      }
    })

    // Column widths (180px each)
    for (let col = 0; col < CATEGORIES.length; col++) {
      setupRequests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
          properties: { pixelSize: 180 },
          fields: 'pixelSize'
        }
      })
    }

    // Header row: dark bg + category colour per column
    setupRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 11 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          }
        },
        fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)'
      }
    })
    CATEGORIES.forEach((cat, col) => {
      setupRequests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { backgroundColor: cat.color } },
          fields: 'userEnteredFormat.backgroundColor'
        }
      })
    })

    // Count row: light grey bg, bold, centred
    setupRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
            textFormat: { bold: true, fontSize: 12 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          }
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
      }
    })

    // Contact rows: wrap text, align top-left
    if (maxContacts > 0) {
      setupRequests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: values.length },
          cell: {
            userEnteredFormat: {
              wrapStrategy: 'WRAP',
              verticalAlignment: 'TOP',
              horizontalAlignment: 'LEFT',
            }
          },
          fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,horizontalAlignment)'
        }
      })
    }

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: setupRequests } })
    logger.info('Dashboard updated', { clientId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` })

  } catch (err: any) {
    logger.error('Dashboard update failed — non-fatal', { clientId, error: err.message })
  }
}

