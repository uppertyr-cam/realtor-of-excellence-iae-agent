import { google } from 'googleapis'
import nodemailer from 'nodemailer'
import { db } from '../db/client'
import { logger } from '../utils/logger'
import { updateDashboard } from './dashboard'

// ─── CHAT / NOTE FORMATTERS ──────────────────────────────────
function getChatPrefix(key: string): string {
  const k = key.trim().toLowerCase()
  if (k === 'ai')            return '◈🟧'
  if (k.includes('system')) return '◈⚙️'
  return '🟦'
}

function formatChatHistory(aiMemory: string): string {
  return (aiMemory || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(segment => {
      segment = segment.replace(/^\/+\s*/, '')
      const idx = segment.indexOf(':')
      if (idx === -1) return `🟦 ${segment}`
      const key     = segment.slice(0, idx).trim()
      const content = segment.slice(idx + 1).trim()
      return `${getChatPrefix(key)} ${key}: ${content}`
    })
    .join('\n')
}

function formatNotes(rawNotes: string): string {
  return (rawNotes || '')
    .split('###')
    .map(n => n.trim())
    .filter(Boolean)
    .map(note => {
      note = note.replace(/^[-*•]\s*/, '')
      return /^next steps:/i.test(note) ? `🎯 ${note}` : `📝 ${note}`
    })
    .join('\n')
}

const REPORT_EMAIL = process.env.REPORT_EMAIL || ''
const FROM_EMAIL   = process.env.FROM_EMAIL   || ''
const APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || ''

const OUTCOMES = ['Not Interested', 'Interested in Renting', 'Interested in Buying', 'Already Purchased', 'No Reply']

// RGB 0-1 scale
const OUTCOME_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  'Not Interested':        { red: 0.898, green: 0.224, blue: 0.208 },
  'Interested in Renting': { red: 0.984, green: 0.549, blue: 0.000 },
  'Interested in Buying':  { red: 0.263, green: 0.627, blue: 0.278 },
  'Already Purchased':     { red: 0.118, green: 0.533, blue: 0.898 },
  'No Reply':              { red: 0.459, green: 0.459, blue: 0.459 },
}

const TAG_TO_OUTCOME: Record<string, string> = {
  not_interested:        'Not Interested',
  renting:               'Interested in Renting',
  interested_in_purchasing: 'Interested in Buying',
  already_purchased:     'Already Purchased',
  bump_no_reply:         'No Reply',
}

function getOutcomeLabel(tags: string[]): string {
  for (const tag of tags) {
    if (TAG_TO_OUTCOME[tag]) return TAG_TO_OUTCOME[tag]
  }
  return ''
}

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return auth
}

export async function buildWeeklyReport(): Promise<string> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const clientsRes = await db.query(`SELECT id, name FROM clients ORDER BY name`)

  const tabLabel = `Report - ${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}`

  let spreadsheetId = ''

  const requests: any[] = []

  for (let i = 0; i < clientsRes.rows.length; i++) {
    const clientRow = clientsRes.rows[i]

    // ── Ensure master spreadsheet exists (dashboard creates it) ──
    await updateDashboard(clientRow.id)

    // Re-fetch client to get dashboard_sheet_id
    const freshRes = await db.query(`SELECT dashboard_sheet_id FROM clients WHERE id=$1`, [clientRow.id])
    const masterId: string = freshRes.rows[0]?.dashboard_sheet_id || ''
    if (!masterId) {
      logger.warn('No master spreadsheet for client — skipping', { clientId: clientRow.id })
      continue
    }
    if (!spreadsheetId) spreadsheetId = masterId

    // ── Get or overwrite the "Weekly Report" tab ─────────────
    const tabTitle = `Weekly Report`
    const metaRes = await sheets.spreadsheets.get({ spreadsheetId: masterId, fields: 'sheets(properties,conditionalFormats)' })
    const existing = metaRes.data.sheets?.find(s => s.properties?.title === tabTitle)
    let sheetId: number

    if (existing) {
      sheetId = existing.properties!.sheetId!
      // Clear existing content so stale rows don't linger
      await sheets.spreadsheets.values.clear({ spreadsheetId: masterId, range: `'${tabTitle}'` })
      // Delete all existing conditional format rules so they don't accumulate across runs
      const cfCount = existing.conditionalFormats?.length || 0
      if (cfCount > 0) {
        const delRequests = Array.from({ length: cfCount }, (_, i) => ({
          deleteConditionalFormatRule: { sheetId: existing.properties!.sheetId!, index: 0 }
        }))
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: masterId, requestBody: { requests: delRequests } })
      }
    } else {
      const addRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: masterId,
        requestBody: { requests: [{ addSheet: { properties: { title: tabTitle } } }] }
      })
      sheetId = addRes.data.replies![0].addSheet!.properties!.sheetId!
    }

    const contactsRes = await db.query(
      `SELECT id, first_name, last_name, phone_number, email,
              tags, ai_memory, ai_note, crm_callback_url, updated_at
       FROM contacts WHERE client_id=$1 ORDER BY updated_at DESC`,
      [clientRow.id]
    )

    const headers = ['Contact ID', 'Date Last Updated', 'Outcome', 'First Name', 'Last Name', 'Phone', 'Email', 'Chat History', 'AI Note Taker', 'CRM URL']
    const rows: any[][] = [headers]

    for (const contact of contactsRes.rows) {
      const outcome = getOutcomeLabel(contact.tags || [])
      const updatedAt = contact.updated_at ? new Date(contact.updated_at).toLocaleDateString('en-ZA') : ''
      const manualNote = (contact.tags || []).includes('manual_takeover') ? '⚠️ Manual Takeover\n' : ''
      const chatHistory = formatChatHistory(contact.ai_memory || '')
      const aiNoteTaker = contact.ai_note
        ? manualNote + formatNotes(contact.ai_note)
        : manualNote + formatChatHistory(contact.ai_memory || '')
      rows.push([contact.id, updatedAt, outcome, contact.first_name || '', contact.last_name || '', contact.phone_number, contact.email || '', chatHistory, aiNoteTaker, contact.crm_callback_url || ''])
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: masterId,
      range: `'${tabTitle}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    })

    const numDataRows = rows.length - 1

    // ── Header formatting ────────────────────────────────
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.102, green: 0.102, blue: 0.180 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 11 },
            verticalAlignment: 'MIDDLE',
          }
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)'
      }
    })

    // ── Freeze header ────────────────────────────────────
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount'
      }
    })

    // ── Column widths ────────────────────────────────────
    const colWidths = [180, 140, 200, 130, 130, 140, 200, 300, 300, 240]
    colWidths.forEach((px, col) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
          properties: { pixelSize: px },
          fields: 'pixelSize'
        }
      })
    })

    // ── Clip long-text columns (Chat History col 7, AI Note Taker col 8) ──
    if (numDataRows > 0) {
      [7, 8].forEach(col => {
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: numDataRows + 1, startColumnIndex: col, endColumnIndex: col + 1 },
            cell: { userEnteredFormat: { wrapStrategy: 'CLIP' } },
            fields: 'userEnteredFormat.wrapStrategy'
          }
        })
      })

      // Fix row height so multiline content doesn't auto-expand rows
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: numDataRows + 1 },
          properties: { pixelSize: 21 },
          fields: 'pixelSize'
        }
      })
    }

    // ── Zebra stripe (skip column 2 = Outcome so CF rules can colour it) ──
    for (let r = 0; r < numDataRows; r++) {
      const rowIndex = r + 1
      const zebra = r % 2 === 0 ? { red: 1, green: 1, blue: 1 } : { red: 0.957, green: 0.965, blue: 0.984 }
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 2 },
          cell: { userEnteredFormat: { backgroundColor: zebra } },
          fields: 'userEnteredFormat.backgroundColor'
        }
      })
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 3, endColumnIndex: headers.length },
          cell: { userEnteredFormat: { backgroundColor: zebra } },
          fields: 'userEnteredFormat.backgroundColor'
        }
      })
    }

    // ── Dropdown validation ──────────────────────────────
    if (numDataRows > 0) {
      requests.push({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numDataRows + 1, startColumnIndex: 2, endColumnIndex: 3 },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: OUTCOMES.map(v => ({ userEnteredValue: v }))
            },
            showCustomUi: true,
            strict: false,
          }
        }
      })
    }

    // ── Conditional formatting — one rule per outcome ────
    OUTCOMES.forEach((outcome, idx) => {
      const c = OUTCOME_COLORS[outcome]
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: 2, endColumnIndex: 3 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: outcome }] },
              format: {
                backgroundColor: c,
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }
              }
            }
          },
          index: idx
        }
      })
    })

    // ── Auto filter ──────────────────────────────────────
    requests.push({
      setBasicFilter: {
        filter: {
          range: { sheetId, startRowIndex: 0, endRowIndex: numDataRows + 1, startColumnIndex: 0, endColumnIndex: headers.length }
        }
      }
    })

    // Apply all formatting for this tab to its master spreadsheet
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: masterId, requestBody: { requests: requests.splice(0) } })
  }

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
}

export async function sendWeeklyReport() {
  logger.info('Building weekly Google Sheets report...')

  const url = await buildWeeklyReport()

  // Get client name for subject line
  const clientRes = await db.query(`SELECT name FROM clients ORDER BY name LIMIT 1`)
  const clientName = clientRes.rows[0]?.name || 'Client'

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: APP_PASSWORD.replace(/\s/g, '') },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  const now = new Date().toLocaleDateString('en-ZA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  const footer = `
    <div style="background:#0d0d1a;border-radius:0 0 12px 12px;padding:28px 32px;margin-top:0;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="vertical-align:top;">
            <div style="font-family:'Courier New',monospace;color:#00e5ff;font-size:18px;font-weight:bold;letter-spacing:2px;">
              CAMERON BRITT
            </div>
            <div style="font-family:'Courier New',monospace;color:#7b2ff7;font-size:11px;letter-spacing:4px;text-transform:uppercase;margin-top:3px;">
              Chief Operating Executive
            </div>
            <div style="width:48px;height:2px;background:linear-gradient(90deg,#7b2ff7,#00e5ff);margin:10px 0 14px 0;border-radius:2px;"></div>
            <table style="border-collapse:collapse;">
              <tr>
                <td style="padding:3px 0;color:#00e5ff;font-family:'Courier New',monospace;font-size:12px;">📞</td>
                <td style="padding:3px 0 3px 8px;color:#ccc;font-family:Arial,sans-serif;font-size:12px;">+27 76 153 6498</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#00e5ff;font-family:'Courier New',monospace;font-size:12px;">✉️</td>
                <td style="padding:3px 0 3px 8px;font-family:Arial,sans-serif;font-size:12px;">
                  <a href="mailto:cameronbritt111@gmail.com" style="color:#00e5ff;text-decoration:none;">cameronbritt111@gmail.com</a>
                </td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#00e5ff;font-family:'Courier New',monospace;font-size:12px;">🌐</td>
                <td style="padding:3px 0 3px 8px;font-family:Arial,sans-serif;font-size:12px;">
                  <a href="https://hyperzenai.com" style="color:#00e5ff;text-decoration:none;">hyperzenai.com</a>
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align:right;vertical-align:middle;padding-left:24px;">
            <div style="font-family:'Courier New',monospace;color:#7b2ff7;font-size:10px;letter-spacing:3px;text-transform:uppercase;line-height:1.8;">
              AUTOMATE SMARTER.<br/>
              <span style="color:#00e5ff;">GROW FASTER.</span>
            </div>
            <div style="margin-top:10px;font-family:'Courier New',monospace;font-size:9px;color:#333;letter-spacing:2px;">
              ▸ POWERED BY HYPERZEN AI ◂
            </div>
          </td>
        </tr>
      </table>
    </div>`

  await transporter.sendMail({
    from: `IAE Agent <${FROM_EMAIL}>`,
    to: REPORT_EMAIL,
    subject: `${clientName} Weekly Client Report — ${now}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;box-shadow:0 4px 24px rgba(0,0,0,0.12);border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#0d0d1a 0%,#1a0a2e 50%,#0a1628 100%);padding:32px 32px 28px 32px;">
          <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:4px;color:#7b2ff7;text-transform:uppercase;margin-bottom:8px;">Weekly Intelligence Report</div>
          <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px;">${clientName}</h1>
          <h2 style="color:#00e5ff;margin:4px 0 0 0;font-size:15px;font-weight:400;letter-spacing:1px;">Weekly Client Report</h2>
          <div style="margin-top:16px;display:inline-block;background:rgba(0,229,255,0.08);border:1px solid rgba(0,229,255,0.2);border-radius:4px;padding:4px 12px;">
            <span style="font-family:'Courier New',monospace;font-size:11px;color:#aaa;letter-spacing:1px;">${now}</span>
          </div>
        </div>
        <div style="background:#f8f9fc;padding:32px 32px 24px 32px;">
          <p style="margin-top:0;color:#444;font-size:15px;">Hi Cameron,</p>
          <p style="color:#555;font-size:14px;line-height:1.6;">Your weekly lead activity report is ready. All contact details, outcomes, and conversation history are in the sheet below.</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#7b2ff7,#0a84ff);color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.5px;box-shadow:0 4px 16px rgba(123,47,247,0.4);">
              📊 &nbsp;Open Full Report in Google Sheets
            </a>
          </div>
          <div style="background:#fff;border:1px solid #e8eaf0;border-radius:8px;padding:16px 20px;margin-top:8px;">
            <p style="margin:0;font-size:12px;color:#888;font-family:'Courier New',monospace;letter-spacing:0.5px;">
              ▸ Dashboard tab — live pipeline view &nbsp;|&nbsp; Weekly Report tab — full contact list with outcomes
            </p>
          </div>
        </div>
        ${footer}
      </div>`,
  })

  logger.info('Weekly report sent', { to: REPORT_EMAIL, url })
  return url
}
