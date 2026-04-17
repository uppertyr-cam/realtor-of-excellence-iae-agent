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

async function buildMetricsTab(
  sheets: any,
  spreadsheetId: string,
  clientId: string,
  tabTitle: string,
  periodStart: Date,
  periodEnd: Date,
  periodLabel: string
) {
  const metaRes = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties)' })
  const existing = metaRes.data.sheets?.find((s: any) => s.properties?.title === tabTitle)
  let sheetId: number

  if (existing) {
    sheetId = existing.properties!.sheetId!
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabTitle}'` })
  } else {
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabTitle } } }] }
    })
    sheetId = addRes.data.replies![0].addSheet!.properties!.sheetId!
  }

  const periodStartStr = periodStart.toISOString()
  const periodEndStr = periodEnd.toISOString()
  const dateRange = `${periodStart.toLocaleDateString('en-ZA')} – ${periodEnd.toLocaleDateString('en-ZA')}`

  const kpiRes = await db.query(
    `SELECT
       COUNT(*)                                                                                 AS total_new,
       COUNT(first_reply_at)                                                                    AS replied,
       ROUND(COUNT(first_reply_at)::numeric / NULLIF(COUNT(*),0) * 100, 1)                     AS reply_rate_pct,
       ROUND(AVG(EXTRACT(EPOCH FROM (first_message_at - webhook_received_at))/60)::numeric, 1)  AS avg_speed_to_lead_mins,
       ROUND(AVG(EXTRACT(EPOCH FROM (first_reply_at - first_message_at))/3600)::numeric, 1)     AS avg_time_to_reply_hrs,
       SUM(total_tokens_used)                                                                   AS total_tokens,
       SUM(crm_sync_failures)                                                                   AS crm_failures
     FROM contacts
     WHERE client_id=$1 AND created_at >= $2 AND created_at < $3`,
    [clientId, periodStartStr, periodEndStr]
  )
  const kpi = kpiRes.rows[0]

  // Sent counts — first message + bumps from contacts, follow-ups from outbound_queue
  const contactSentRes = await db.query(
    `SELECT
       COUNT(CASE WHEN first_message_at IS NOT NULL THEN 1 END) AS first_message,
       COUNT(CASE WHEN bump_index >= 1 THEN 1 END)              AS bump_1,
       COUNT(CASE WHEN bump_index >= 2 THEN 1 END)              AS bump_2,
       COUNT(CASE WHEN bump_index >= 3 THEN 1 END)              AS bump_3
     FROM contacts
     WHERE client_id=$1 AND created_at >= $2 AND created_at < $3`,
    [clientId, periodStartStr, periodEndStr]
  )
  const followupSentRes = await db.query(
    `SELECT
       COUNT(CASE WHEN message_type='followup1' THEN 1 END) AS followup_1,
       COUNT(CASE WHEN message_type='followup2' THEN 1 END) AS followup_2,
       COUNT(CASE WHEN message_type='followup3' THEN 1 END) AS followup_3
     FROM outbound_queue
     WHERE client_id=$1 AND status='sent' AND sent_at >= $2 AND sent_at < $3`,
    [clientId, periodStartStr, periodEndStr]
  )
  const sent = { ...contactSentRes.rows[0], ...followupSentRes.rows[0] }

  // Reply counts per touchpoint
  const replyRes = await db.query(
    `SELECT replied_after, COUNT(*) AS replies
     FROM contacts
     WHERE client_id=$1 AND replied_after IS NOT NULL AND created_at >= $2 AND created_at < $3
     GROUP BY replied_after`,
    [clientId, periodStartStr, periodEndStr]
  )
  const replyMap: Record<string, number> = {}
  for (const r of replyRes.rows) replyMap[r.replied_after] = Number(r.replies)

  function rate(replies: number, sentCount: number) {
    if (!sentCount) return '—'
    return `${Math.round(replies / sentCount * 100)}%`
  }

  const touchpoints = [
    { label: '📩  First Message',           key: 'first_message' },
    { label: '📅  Follow-Up 1 — Day 7',     key: 'followup_1'    },
    { label: '📅  Follow-Up 2 — Day 14',    key: 'followup_2'    },
    { label: '📅  Follow-Up 3 — Day 21',    key: 'followup_3'    },
    { label: '🔔  Bump 1 — 24h no reply',   key: 'bump_1'        },
    { label: '🔔  Bump 2 — 48h no reply',   key: 'bump_2'        },
    { label: '🔔  Bump 3 — 72h no reply',   key: 'bump_3'        },
  ]

  const totalTokens = Number(kpi.total_tokens || 0)
  const approxCost = (totalTokens / 1_000_000 * 18).toFixed(2)
  const periodName = periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)

  const rows: any[][] = [
    [`${periodName} Performance Metrics — ${dateRange}`],
    [],
    ['Metric', 'Value'],
    [`New contacts this ${periodLabel}`, kpi.total_new],
    ['Overall reply rate', `${kpi.reply_rate_pct ?? 0}%`],
    ['Avg speed-to-lead (mins)', kpi.avg_speed_to_lead_mins ?? '—'],
    ['Avg time to first reply (hrs)', kpi.avg_time_to_reply_hrs ?? '—'],
    ['Total AI tokens used', totalTokens],
    ['Approx AI cost (USD)', `$${approxCost}`],
    ['CRM sync failures', kpi.crm_failures ?? 0],
    [],
    ['Touchpoint Reply Rates'],
    ['Touchpoint', 'Times Sent', 'Replies', 'Reply Rate'],
    ...touchpoints.map(tp => {
      const s = Number(sent[tp.key] || 0)
      const r = replyMap[tp.key] || 0
      return [tp.label, s, r, rate(r, s)]
    }),
  ]

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabTitle}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  })

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.102, green: 0.102, blue: 0.180 },
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 13 },
                verticalAlignment: 'MIDDLE',
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 2, endRowIndex: 3 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.2, blue: 0.35 },
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)'
          }
        },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
      ]
    }
  })
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

    // ── Weekly Metrics tab (previous Mon–Sun) + rolling windows
    const now = new Date()
    const weekEnd = new Date(now)
    weekEnd.setDate(now.getDate() - (now.getDay() === 0 ? 0 : now.getDay()))
    weekEnd.setHours(0, 0, 0, 0)
    const weekStart = new Date(weekEnd)
    weekStart.setDate(weekEnd.getDate() - 7)
    await buildMetricsTab(sheets, masterId, clientRow.id, 'Weekly Metrics', weekStart, weekEnd, 'week')

    // Rolling windows — update every Monday alongside weekly
    for (const p of [{ title: '1 Month Overview', months: 1 }, { title: '4 Month Overview', months: 4 }, { title: '8 Month Overview', months: 8 }]) {
      const end = new Date(now)
      const start = new Date(now)
      start.setMonth(start.getMonth() - p.months)
      await buildMetricsTab(sheets, masterId, clientRow.id, p.title, start, end, `${p.months} month`)
    }
  }

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
}

// ─── MONTHLY METRICS ─────────────────────────────────────────
// Called on the 1st of each month — shows the previous calendar month
export async function buildMonthlyMetrics() {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const clientsRes = await db.query(`SELECT id FROM clients ORDER BY name`)

  const now = new Date()
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1)   // 1st of current month
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1) // 1st of previous month

  for (const clientRow of clientsRes.rows) {
    const freshRes = await db.query(`SELECT dashboard_sheet_id FROM clients WHERE id=$1`, [clientRow.id])
    const masterId: string = freshRes.rows[0]?.dashboard_sheet_id || ''
    if (!masterId) continue
    await buildMetricsTab(sheets, masterId, clientRow.id, 'Monthly Metrics', monthStart, monthEnd, 'month')
  }
  logger.info('Monthly metrics updated')
}

// ─── YEARLY METRICS ──────────────────────────────────────────
// Called on Jan 1st — shows the previous calendar year
export async function buildYearlyMetrics() {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const clientsRes = await db.query(`SELECT id FROM clients ORDER BY name`)

  const now = new Date()
  const yearEnd = new Date(now.getFullYear(), 0, 1)       // Jan 1st of current year
  const yearStart = new Date(now.getFullYear() - 1, 0, 1) // Jan 1st of previous year

  for (const clientRow of clientsRes.rows) {
    const freshRes = await db.query(`SELECT dashboard_sheet_id FROM clients WHERE id=$1`, [clientRow.id])
    const masterId: string = freshRes.rows[0]?.dashboard_sheet_id || ''
    if (!masterId) continue
    await buildMetricsTab(sheets, masterId, clientRow.id, 'Yearly Metrics', yearStart, yearEnd, 'year')
  }
  logger.info('Yearly metrics updated')
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
