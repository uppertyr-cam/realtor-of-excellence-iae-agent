# Webhook Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/webhook/crm` | CRM fires this to start reactivation (requires `x-iae-secret` header) |
| `GET` | `/webhook/whatsapp` | Meta verification challenge |
| `POST` | `/webhook/whatsapp` | Inbound WhatsApp message from Meta |
| `POST` | `/webhook/sms` | Inbound SMS from Twilio |
| `GET` | `/admin/clients` | List all clients (requires `x-iae-secret` header) |
| `POST` | `/admin/clients` | Create or update a client |
| `GET` | `/admin/contacts/:id` | Get contact status |

All admin routes and `/webhook/crm` require the `x-iae-secret` header.
