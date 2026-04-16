import { db } from '../db/client'
import { getClientConfig } from '../config/client-config'
import { sendWhatsAppMessage, sendWhatsAppTemplate } from '../channels/whatsapp'
import { sendSmsMessage } from '../channels/sms'
import { writeToCrm } from '../crm/adapter'
import { processDripQueue } from '../workflows/outbound-first-message'
import { processBumpQueue, processBumpCloseQueue, scheduleBumps } from '../workflows/bump-handler'
import { sendWeeklyReport, buildWeeklyReport } from '../reports/weekly-report'
import { updateDashboard } from '../reports/dashboard'
import { logger } from '../utils/logger'

// ─── START SCHEDULER ─────────────────────────────────────────
export function startScheduler() {
  logger.info('Scheduler started')

  // Process all queues every 60 seconds
  setInterval(async () => {
    try {
      await processDripQueue()
      await processFollowUpQueue()
      await processBumpQueue()
      await processBumpCloseQueue()
      await processReachBackOutQueue()
      await db.releaseStaleLocks() // Safety net for stuck locks
    } catch (err: any) {
      logger.error('Scheduler tick error', { error: err.message })
    }
  }, 60_000)

  // Run immediately on startup
  setTimeout(async () => {
    await processDripQueue()
    await processFollowUpQueue()
    await processBumpQueue()
    await processBumpCloseQueue()
    await processReachBackOutQueue()
  }, 2000)

  // Weekly report — every Monday at 9am Africa/Johannesburg
  scheduleWeeklyReport()
}

// ─── WEEKLY REPORT SCHEDULER ─────────────────────────────────
function scheduleWeeklyReport() {
  function msUntilNextMonday9am(): number {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }))
    const target = new Date(now)
    const day = now.getDay() // 0=Sun, 1=Mon
    const daysUntilMonday = day === 1 ? (now.getHours() < 9 || (now.getHours() === 9 && now.getMinutes() === 0) ? 0 : 7) : (8 - day) % 7 || 7
    target.setDate(now.getDate() + daysUntilMonday)
    target.setHours(9, 0, 0, 0)
    return target.getTime() - now.getTime()
  }

  function scheduleNext() {
    const ms = msUntilNextMonday9am()
    logger.info(`Weekly report scheduled in ${Math.round(ms / 3600000)}h`)
    setTimeout(async () => {
      try {
        await sendWeeklyReport()
      } catch (err: any) {
        logger.error('Weekly report failed', { error: err.message })
      }
      scheduleNext() // schedule the following week
    }, ms)
  }

  scheduleNext()
}

// ─── FOLLOW-UP QUEUE PROCESSOR (7 / 14 / 21 day cold follow-ups) ────────────
async function processFollowUpQueue() {
  const res = await db.query(
    `UPDATE outbound_queue SET status='processing'
     WHERE id IN (
       SELECT id FROM outbound_queue
       WHERE status='pending'
       AND scheduled_at <= NOW()
       AND message_type IN ('followup1','followup2','followup3')
       ORDER BY scheduled_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`
  )

  for (const job of res.rows) {
    try {
      await processFollowUpJob(job)
    } catch (err: any) {
      logger.error('Follow-up job error', { job_id: job.id, error: err.message })
      await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [err.message, job.id])
    }
  }
}

async function processFollowUpJob(job: any) {
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [job.contact_id])
  if (contactRes.rowCount === 0) return
  const contact = contactRes.rows[0]

  // Skip if contact has replied, been closed, or gone to manual takeover
  if (
    ['replied', 'closed', 'completed'].includes(contact.workflow_stage) ||
    contact.tags?.includes('manual_takeover')
  ) {
    await db.query(`UPDATE outbound_queue SET status='cancelled' WHERE id=$1`, [job.id])
    return
  }

  const config = await getClientConfig(contact.client_id)
  const channel = contact.channel || config.channel

  const templateMap: Record<string, string> = {
    followup1: config.followup1_message_template,
    followup2: config.followup2_message_template,
    followup3: config.followup3_message_template,
  }
  const waTemplateNameMap: Record<string, string | null> = {
    followup1: config.wa_followup1_template_name,
    followup2: config.wa_followup2_template_name,
    followup3: config.wa_followup3_template_name,
  }
  const template = templateMap[job.message_type] || config.followup1_message_template
  const waTemplateName = waTemplateNameMap[job.message_type] ?? null

  const message = template
    .replace(/{{first_name}}/g, contact.first_name || '')
    .replace(/{{last_name}}/g, contact.last_name || '')

  let result
  if (channel === 'whatsapp' && waTemplateName) {
    result = await sendWhatsAppTemplate(
      contact.phone_number,
      waTemplateName,
      [contact.first_name || '', contact.last_name || ''],
      config.wa_phone_number_id!,
      config.wa_access_token!
    )
  } else if (channel === 'whatsapp') {
    result = await sendWhatsAppMessage(contact.phone_number, message, config.wa_phone_number_id!, config.wa_access_token!)
  } else {
    result = await sendSmsMessage(contact.phone_number, message, config.sms_account_sid!, config.sms_auth_token!, config.sms_from_number!)
  }

  if (!result.success) {
    await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [result.error, job.id])
    return
  }

  const now = new Date()
  const stageMap: Record<string, string> = {
    followup1: 'followup1_sent',
    followup2: 'followup2_sent',
    followup3: 'followup3_sent',
  }
  const tsColMap: Record<string, string> = {
    followup1: 'followup1_sent_at',
    followup2: 'followup2_sent_at',
    followup3: 'followup3_sent_at',
  }

  await db.query(
    `UPDATE contacts SET ${tsColMap[job.message_type]}=$1, workflow_stage=$2 WHERE id=$3`,
    [now, stageMap[job.message_type], contact.id]
  )
  await db.query(`UPDATE outbound_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [job.id])

  const labelMap: Record<string, string> = { followup1: 'Follow-up 1 (Day 7)', followup2: 'Follow-up 2 (Day 14)', followup3: 'Follow-up 3 (Day 21)' }
  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: [`${job.message_type}_sent`],
      note: `IAE: ${labelMap[job.message_type]} sent via ${channel}.\n\nMessage: ${message}\n\nTimestamp: ${now.toISOString()}`,
      fields: { ai_memory: (contact.ai_memory || '') + `\nAI (${job.message_type}): ${message}` },
    },
    config, contact.crm_callback_url
  )

  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type)
     VALUES ($1,$2,'outbound',$3,$4,$5)`,
    [contact.id, config.id, channel, message, job.message_type]
  )

  logger.info(`${job.message_type} sent`, { contact_id: contact.id, channel })
}

// ─── REACH-BACK-OUT QUEUE PROCESSOR ──────────────────────────
async function processReachBackOutQueue() {
  const res = await db.query(
    `UPDATE outbound_queue SET status='processing'
     WHERE id IN (
       SELECT id FROM outbound_queue
       WHERE status='pending'
       AND scheduled_at <= NOW()
       AND message_type = 'reach_back_out'
       ORDER BY scheduled_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`
  )

  for (const job of res.rows) {
    try {
      await processReachBackOutJob(job)
    } catch (err: any) {
      logger.error('Reach-back-out job error', { job_id: job.id, error: err.message })
      await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [err.message, job.id])
    }
  }
}

async function processReachBackOutJob(job: any) {
  const contactRes = await db.query(`SELECT * FROM contacts WHERE id=$1`, [job.contact_id])
  if (contactRes.rowCount === 0) return
  const contact = contactRes.rows[0]

  // Skip if contact has since replied, been closed, or gone to manual takeover
  if (
    ['replied', 'closed', 'completed'].includes(contact.workflow_stage) ||
    contact.tags?.includes('manual_takeover')
  ) {
    await db.query(`UPDATE outbound_queue SET status='cancelled' WHERE id=$1`, [job.id])
    logger.info('reach_back_out skipped — contact no longer reachable', { contact_id: contact.id })
    return
  }

  const config = await getClientConfig(contact.client_id)

  if (!config.reach_back_out_message_template) {
    await db.query(`UPDATE outbound_queue SET status='failed', error='reach_back_out_message_template not configured' WHERE id=$1`, [job.id])
    logger.warn('reach_back_out_message_template not configured — skipping', { contact_id: contact.id })
    return
  }

  const message = config.reach_back_out_message_template
    .replace(/{{first_name}}/g, contact.first_name || '')
    .replace(/{{last_name}}/g, contact.last_name || '')

  const channel = contact.channel || config.channel
  const waTemplateName = config.wa_reach_back_out_template_name ?? null

  let result
  if (channel === 'whatsapp' && waTemplateName) {
    result = await sendWhatsAppTemplate(
      contact.phone_number,
      waTemplateName,
      [contact.first_name || '', contact.last_name || ''],
      config.wa_phone_number_id!,
      config.wa_access_token!
    )
  } else if (channel === 'whatsapp') {
    result = await sendWhatsAppMessage(contact.phone_number, message, config.wa_phone_number_id!, config.wa_access_token!)
  } else {
    result = await sendSmsMessage(contact.phone_number, message, config.sms_account_sid!, config.sms_auth_token!, config.sms_from_number!)
  }

  if (!result.success) {
    await db.query(`UPDATE outbound_queue SET status='failed', error=$1 WHERE id=$2`, [result.error, job.id])
    return
  }

  const now = new Date()

  await db.query(`UPDATE outbound_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [job.id])
  await db.query(
    `UPDATE contacts SET tags=array_append(tags,'reach_back_out_sent'), updated_at=NOW() WHERE id=$1`,
    [contact.id]
  )

  await writeToCrm(
    {
      contact_id: contact.id,
      tags_add: ['reach-back-out-sent'],
      note: `IAE: Reach-back-out message sent via ${channel}.\n\nMessage: ${message}\n\nTimestamp: ${now.toISOString()}`,
      fields: { ai_memory: (contact.ai_memory || '') + `\nAI (reach_back_out): ${message}` },
    },
    config, contact.crm_callback_url
  )

  await db.query(
    `INSERT INTO message_log (contact_id, client_id, direction, channel, content, message_type)
     VALUES ($1,$2,'outbound',$3,$4,'reach_back_out')`,
    [contact.id, config.id, channel, message]
  )

  // Schedule 3 bumps + bump_close in case the lead doesn't respond
  await scheduleBumps(contact.id, config.id)

  updateDashboard(contact.client_id).catch(() => {})

  logger.info('reach_back_out sent — bumps scheduled', { contact_id: contact.id, channel })
}
