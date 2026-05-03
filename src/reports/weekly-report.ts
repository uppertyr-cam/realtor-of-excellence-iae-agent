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
       SUM(total_cost_usd)                                                                      AS total_cost_usd,
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
  const totalCostUsd = Number(kpi.total_cost_usd || 0)
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
    ['Total tracked cost (USD)', `$${totalCostUsd.toFixed(4)}`],
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
                backgroundColor: { red: 0.043, green: 0.071, blue: 0.125 },
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
                backgroundColor: { red: 0.082, green: 0.122, blue: 0.212 },
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

const TAB_ORDER = [
  'Dashboard',
  'Workflow Status',
  'Weekly Report',
  'Weekly Metrics',
  'Monthly Metrics',
  '4 Month Metrics',
  '8 Month Metrics',
  '12 Month Metrics',
]

const STALE_TABS = ['1 Month Overview', '4 Month Overview', '8 Month Overview', 'Yearly Metrics']

async function cleanupAndReorderTabs(sheets: any, spreadsheetId: string) {
  const metaRes = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties)' })
  const allSheets: { title: string; sheetId: number; index: number }[] =
    (metaRes.data.sheets || []).map((s: any) => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      index: s.properties.index,
    }))

  const requests: any[] = []

  // Delete stale Overview tabs
  for (const stale of STALE_TABS) {
    const found = allSheets.find(s => s.title === stale)
    if (found) requests.push({ deleteSheet: { sheetId: found.sheetId } })
  }

  // Reorder remaining tabs
  const remaining = allSheets.filter(s => !STALE_TABS.includes(s.title))
  TAB_ORDER.forEach((title, desiredIndex) => {
    const sheet = remaining.find(s => s.title === title)
    if (sheet && sheet.index !== desiredIndex) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet.sheetId, index: desiredIndex },
          fields: 'index',
        }
      })
    }
  })

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
  }
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
    const existing = metaRes.data.sheets?.find((s: any) => s.properties?.title === tabTitle)
    let sheetId: number

    if (existing) {
      sheetId = existing.properties!.sheetId!
      // Clear existing content so stale rows don't linger
      await sheets.spreadsheets.values.clear({ spreadsheetId: masterId, range: `'${tabTitle}'` })
      // Delete all existing conditional format rules so they don't accumulate across runs
      const cfCount = existing.conditionalFormats?.length || 0
      if (cfCount > 0) {
        const delRequests = Array.from({ length: cfCount }, () => ({
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
      const chatHistory = formatChatHistory(contact.ai_memory || '')
      const aiNoteTaker = contact.ai_note
        ? formatNotes(contact.ai_note)
        : formatChatHistory(contact.ai_memory || '')
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
            backgroundColor: { red: 0.043, green: 0.071, blue: 0.125 },
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

    // Clean up old Overview tabs if they exist, then reorder all tabs
    await cleanupAndReorderTabs(sheets, masterId)
  }

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
}

// ─── LIVE METRICS UPDATE ─────────────────────────────────────
// Called after every message event — current-period windows (this week, this month, YTD, rolling)
export async function updateMetrics(clientId: string): Promise<void> {
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })

    const freshRes = await db.query(`SELECT dashboard_sheet_id FROM clients WHERE id=$1`, [clientId])
    const masterId: string = freshRes.rows[0]?.dashboard_sheet_id || ''
    if (!masterId) return

    const now = new Date()

    // Current week: Monday 00:00 → now
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1))
    weekStart.setHours(0, 0, 0, 0)
    await buildMetricsTab(sheets, masterId, clientId, 'Weekly Metrics', weekStart, now, 'week')

    // Current month: 1st → now
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    await buildMetricsTab(sheets, masterId, clientId, 'Monthly Metrics', monthStart, now, 'month')

    // Rolling 4 months
    const fourStart = new Date(now)
    fourStart.setMonth(fourStart.getMonth() - 4)
    await buildMetricsTab(sheets, masterId, clientId, '4 Month Metrics', fourStart, now, '4 month')

    // Rolling 8 months
    const eightStart = new Date(now)
    eightStart.setMonth(eightStart.getMonth() - 8)
    await buildMetricsTab(sheets, masterId, clientId, '8 Month Metrics', eightStart, now, '8 month')

    // Rolling 12 months
    const twelveStart = new Date(now)
    twelveStart.setMonth(twelveStart.getMonth() - 12)
    await buildMetricsTab(sheets, masterId, clientId, '12 Month Metrics', twelveStart, now, '12 month')

    await cleanupAndReorderTabs(sheets, masterId)
    logger.info('Metrics updated', { clientId })
  } catch (err: any) {
    logger.error('Metrics update failed — non-fatal', { clientId, error: err.message })
  }
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
  const yearStart = new Date(now.getFullYear(), 0, 1)     // Jan 1st of current year
  const yearEnd = now                                      // now (year-to-date)

  for (const clientRow of clientsRes.rows) {
    const freshRes = await db.query(`SELECT dashboard_sheet_id FROM clients WHERE id=$1`, [clientRow.id])
    const masterId: string = freshRes.rows[0]?.dashboard_sheet_id || ''
    if (!masterId) continue
    await buildMetricsTab(sheets, masterId, clientRow.id, '12 Month Metrics', yearStart, yearEnd, '12 month')
  }
  logger.info('Yearly metrics updated')
}

export async function sendWeeklyReport() {
  logger.info('Building weekly Google Sheets report...')

  const url = await buildWeeklyReport()

  // Get client details for subject line and email summary metrics
  const clientRes = await db.query(`SELECT id, name FROM clients ORDER BY name LIMIT 1`)
  const clientId = clientRes.rows[0]?.id || ''
  const clientName = clientRes.rows[0]?.name || 'Client'

  const summaryRes = clientId
    ? await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE 'interested_in_purchasing' = ANY(tags)) AS interested_count,
           COUNT(*) FILTER (WHERE 'already_purchased' = ANY(tags)) AS already_bought_count,
           COUNT(*) FILTER (WHERE 'bump_no_reply' = ANY(tags)) AS no_reply_count,
           COUNT(*) FILTER (WHERE 'renting' = ANY(tags)) AS renting_count,
           COUNT(*) FILTER (WHERE 'not_interested' = ANY(tags)) AS not_interested_count
         FROM contacts
         WHERE client_id=$1`,
        [clientId]
      )
    : { rows: [{}] }

  const summary = summaryRes.rows[0] || {}
  const interestedCount = Number(summary.interested_count || 0)
  const alreadyBoughtCount = Number(summary.already_bought_count || 0)
  const noReplyCount = Number(summary.no_reply_count || 0)
  const rentingCount = Number(summary.renting_count || 0)
  const notInterestedCount = Number(summary.not_interested_count || 0)

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
    <div style="background:#0B1220;padding:28px 36px 34px 36px;border-top:1px solid rgba(92,225,230,0.18);">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="vertical-align:top;">
            <div style="font-family:Georgia,'Times New Roman',serif;color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:0.4px;">
              UpperTyr
            </div>
            <div style="margin-top:8px;font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#5CE1E6;">
              Automate smarter, grow faster
            </div>
          </td>
          <td style="vertical-align:bottom;text-align:right;padding-left:24px;">
            <div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#9CA3AF;">
              CEO Cameron Britt
            </div>
            <div style="margin-top:4px;font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#FFFFFF;">
              +27 76 153 6498
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
      <div style="margin:0;padding:32px 16px;background:#E8EDF2;">
        <table role="presentation" style="width:100%;border-collapse:collapse;">
          <tr>
            <td align="center">
              <table role="presentation" style="width:100%;max-width:720px;border-collapse:collapse;background:#FFFFFF;border:1px solid #D7DEE7;border-radius:18px;overflow:hidden;box-shadow:0 18px 40px rgba(11,18,32,0.12);">
                <tr>
                  <td style="background:#0B1220;height:8px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="background:#FFFFFF;padding:26px 36px 30px 36px;border-bottom:1px solid #E2E8F0;">
                    <table role="presentation" style="width:100%;border-collapse:collapse;">
                      <tr>
                        <td style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#5CE1E6;padding-bottom:10px;">
                          Weekly Client Report
                        </td>
                        <td align="right" style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.2px;color:#9CA3AF;padding-bottom:10px;">
                          ${now}
                        </td>
                      </tr>
                    </table>
                    <div style="font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.08;color:#0B1220;font-weight:700;letter-spacing:-0.8px;">
                      ${clientName}
                    </div>
                    <div style="margin-top:10px;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#4B5563;max-width:540px;">
                      A concise weekly briefing covering pipeline movement, recent engagement, and the current status of active records.
                    </div>
                    <div style="margin-top:22px;width:72px;height:2px;background:#5CE1E6;"></div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 36px 0 36px;">
                    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0;background:#F7FAFC;border:1px solid #DCE4EC;border-radius:14px;">
                      <tr>
                        <td width="20%" style="padding:16px 12px 16px 18px;border-right:1px solid #E2E8F0;">
                          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#9CA3AF;margin-bottom:8px;">Interested</div>
                          <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1;color:#0B1220;">${interestedCount}</div>
                        </td>
                        <td width="20%" style="padding:16px 12px 16px 18px;border-right:1px solid #E2E8F0;">
                          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#9CA3AF;margin-bottom:8px;">Already Bought</div>
                          <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1;color:#0B1220;">${alreadyBoughtCount}</div>
                        </td>
                        <td width="20%" style="padding:16px 12px 16px 18px;border-right:1px solid #E2E8F0;">
                          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#9CA3AF;margin-bottom:8px;">Wanting to Rent</div>
                          <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1;color:#0B1220;">${rentingCount}</div>
                        </td>
                        <td width="20%" style="padding:16px 12px 16px 18px;border-right:1px solid #E2E8F0;">
                          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#9CA3AF;margin-bottom:8px;">Not Interested</div>
                          <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1;color:#0B1220;">${notInterestedCount}</div>
                        </td>
                        <td width="20%" style="padding:16px 18px 16px 18px;">
                          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#9CA3AF;margin-bottom:8px;">No Response</div>
                          <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1;color:#0B1220;">${noReplyCount}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:32px 36px 12px 36px;font-family:Arial,sans-serif;color:#111827;">
                    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#374151;">Good day,</p>
                    <p style="margin:0;font-size:15px;line-height:1.8;color:#4B5563;">
                      Your weekly report is ready for review. The attached reporting view consolidates contact activity, disposition status, and conversation history into a single operational record for the week.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 36px 0 36px;">
                    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0;background:#F7FAFC;border:1px solid #DCE4EC;border-radius:14px;">
                      <tr>
                        <td style="padding:18px 22px;font-family:Arial,sans-serif;">
                          <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#5CE1E6;margin-bottom:10px;">Report Coverage</div>
                          <div style="font-size:14px;line-height:1.8;color:#4B5563;">
                            Dashboard tab for live pipeline visibility and current movement<br/>
                            Weekly Report tab for record-level review across all tracked contacts
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:30px 36px 36px 36px;">
                    <a href="${url}" style="display:inline-block;background:#0B1220;color:#FFFFFF;padding:15px 34px;border-radius:999px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.4px;border:1px solid #5CE1E6;box-shadow:0 10px 24px rgba(11,18,32,0.18);">
                      Open Weekly Report
                    </a>
                    <div style="margin-top:12px;font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#9CA3AF;">
                      Secure Google Sheets access for authorised review
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    ${footer}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>`,
  })

  logger.info('Weekly report sent', { to: REPORT_EMAIL, url })
  return url
}
