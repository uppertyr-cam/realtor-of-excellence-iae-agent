import axios from 'axios'
import { CrmUpdate, ClientConfig } from '../utils/types'
import { logger } from '../utils/logger'

export async function writeToCrm(
  update: CrmUpdate,
  config: ClientConfig,
  callbackUrl?: string | null
): Promise<void> {
  try {
    switch (config.crm_type.toLowerCase()) {
      case 'hubspot':
        await writeHubspot(update, config)
        break
      case 'salesforce':
        await writeSalesforce(update, config)
        break
      case 'gohighlevel':
      case 'ghl':
        await writeGHL(update, config)
        break
      case 'followupboss':
      case 'fub':
        await writeFollowUpBoss(update, config)
        break
      default:
        await writeGeneric(update, callbackUrl)
    }
    logger.info('CRM updated', { contact_id: update.contact_id, crm: config.crm_type })
  } catch (err: any) {
    logger.error('CRM write failed', { contact_id: update.contact_id, error: err.message })
    // Non-fatal — log and continue
  }
}

async function writeHubspot(update: CrmUpdate, config: ClientConfig) {
  const base = config.crm_base_url || 'https://api.hubapi.com'
  const headers = { Authorization: `Bearer ${config.crm_api_key}` }

  // Update properties
  if (update.fields && Object.keys(update.fields).length > 0) {
    await axios.patch(
      `${base}/crm/v3/objects/contacts/${update.contact_id}`,
      { properties: update.fields },
      { headers }
    )
  }

  // Add note
  if (update.note) {
    await axios.post(
      `${base}/crm/v3/objects/notes`,
      {
        properties: { hs_note_body: update.note, hs_timestamp: Date.now() },
        associations: [{ to: { id: update.contact_id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
      },
      { headers }
    )
  }
}

async function writeSalesforce(update: CrmUpdate, config: ClientConfig) {
  const base = config.crm_base_url
  if (!base) throw new Error('Salesforce base URL not configured')
  const headers = { Authorization: `Bearer ${config.crm_api_key}` }

  if (update.fields) {
    await axios.patch(`${base}/services/data/v58.0/sobjects/Contact/${update.contact_id}`, update.fields, { headers })
  }
  if (update.note) {
    await axios.post(`${base}/services/data/v58.0/sobjects/Task`, {
      WhoId: update.contact_id, Subject: 'IAE Note', Description: update.note, Status: 'Completed',
    }, { headers })
  }
}

async function writeGHL(update: CrmUpdate, config: ClientConfig) {
  const base = config.crm_base_url || 'https://rest.gohighlevel.com'
  const headers = { Authorization: `Bearer ${config.crm_api_key}` }

  if (update.tags_add?.length) {
    await axios.post(`${base}/v1/contacts/${update.contact_id}/tags`, { tags: update.tags_add }, { headers })
  }
  if (update.tags_remove?.length) {
    await axios.delete(`${base}/v1/contacts/${update.contact_id}/tags`, { data: { tags: update.tags_remove }, headers })
  }
  if (update.note) {
    await axios.post(`${base}/v1/contacts/${update.contact_id}/notes`, { body: update.note }, { headers })
  }
  if (update.fields) {
    await axios.put(`${base}/v1/contacts/${update.contact_id}`, update.fields, { headers })
  }
}

async function writeFollowUpBoss(update: CrmUpdate, config: ClientConfig) {
  const base = config.crm_base_url || 'https://api.followupboss.com/v1'
  const auth = { username: config.crm_api_key ?? '', password: '' }

  if (update.tags_add?.length || (update.fields && Object.keys(update.fields).length > 0)) {
    const current = await axios.get(`${base}/people/${update.contact_id}`, { auth })
    const existingTags: string[] = current.data.tags || []
    const mergedTags = [...new Set([...existingTags, ...(update.tags_add || [])])].filter(
      (tag) => !(update.tags_remove || []).includes(tag),
    )
    await axios.put(`${base}/people/${update.contact_id}`, {
      ...(update.fields || {}),
      tags: mergedTags,
    }, { auth })
  }

  if (update.note) {
    await axios.post(`${base}/notes`, {
      personId: update.contact_id,
      body: update.note,
    }, { auth })
  }
}

async function writeGeneric(update: CrmUpdate, callbackUrl?: string | null) {
  if (!callbackUrl) {
    logger.warn('No callback URL for generic CRM update', { contact_id: update.contact_id })
    return
  }
  await axios.post(callbackUrl, update, {
    headers: { 'Content-Type': 'application/json', 'X-IAE-Secret': process.env.INTERNAL_WEBHOOK_SECRET },
    timeout: 10_000,
  })
}
