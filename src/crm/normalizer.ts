import { InboundWebhook } from '../utils/types'
import { logger } from '../utils/logger'

// Each CRM sends different field names.
// This normaliser maps them all to our internal schema.

export function normalizeWebhook(raw: any, crmType: string): InboundWebhook {
  logger.debug('Normalising webhook', { crmType })

  switch (crmType.toLowerCase()) {
    case 'hubspot':
      return normalizeHubspot(raw)
    case 'salesforce':
      return normalizeSalesforce(raw)
    case 'gohighlevel':
    case 'ghl':
      return normalizeGHL(raw)
    case 'followupboss':
    case 'fub':
      return normalizeFollowUpBoss(raw)
    default:
      return normalizeGeneric(raw)
  }
}

function normalizeHubspot(raw: any): InboundWebhook {
  return {
    contact_id:       raw.objectId?.toString() || raw.contact_id,
    phone_number:     raw.properties?.phone || raw.phone_number,
    first_name:       raw.properties?.firstname || raw.first_name || '',
    last_name:        raw.properties?.lastname || raw.last_name,
    email:            raw.properties?.email || raw.email,
    client_id:        raw.client_id,
    crm_type:         'hubspot',
    crm_callback_url: raw.crm_callback_url,
  }
}

function normalizeSalesforce(raw: any): InboundWebhook {
  return {
    contact_id:       raw.Id || raw.contact_id,
    phone_number:     raw.MobilePhone || raw.Phone || raw.phone_number,
    first_name:       raw.FirstName || raw.first_name || '',
    last_name:        raw.LastName || raw.last_name,
    email:            raw.Email || raw.email,
    client_id:        raw.client_id,
    crm_type:         'salesforce',
    crm_callback_url: raw.crm_callback_url,
  }
}

function normalizeGHL(raw: any): InboundWebhook {
  return {
    contact_id:       raw.contactId || raw.contact_id,
    phone_number:     raw.phone || raw.phone_number,
    first_name:       raw.firstName || raw.first_name || '',
    last_name:        raw.lastName || raw.last_name,
    email:            raw.email,
    client_id:        raw.client_id,
    crm_type:         'gohighlevel',
    crm_callback_url: raw.crm_callback_url,
  }
}

function normalizeFollowUpBoss(raw: any): InboundWebhook {
  const allPhones: string[] = raw.phones?.map((p: any) => p.value).filter(Boolean) || []
  return {
    contact_id:       raw.id?.toString() || raw.contact_id,
    phone_number:     allPhones[0] || raw.phone_number,
    phone_numbers:    allPhones.length > 1 ? allPhones : undefined,
    first_name:       raw.firstName || raw.first_name || '',
    last_name:        raw.lastName || raw.last_name,
    email:            raw.emails?.[0]?.value || raw.email,
    client_id:        raw.client_id,
    crm_type:         'followupboss',
    crm_callback_url: raw.crm_callback_url,
    assigned_to:      raw.assignedTo || undefined,
  }
}

function normalizeGeneric(raw: any): InboundWebhook {
  // Expects our standard schema directly
  return {
    contact_id:       raw.contact_id,
    phone_number:     raw.phone_number,
    first_name:       raw.first_name || '',
    last_name:        raw.last_name,
    email:            raw.email,
    client_id:        raw.client_id,
    crm_type:         raw.crm_type || 'generic',
    crm_callback_url: raw.crm_callback_url,
  }
}
