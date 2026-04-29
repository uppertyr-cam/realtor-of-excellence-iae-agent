# Configuration

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```
DATABASE_URL             Supabase/Postgres connection string
ANTHROPIC_API_KEY        Your Anthropic API key
META_APP_SECRET          From Meta developer console
META_VERIFY_TOKEN        Any string you choose — used for webhook verification
TWILIO_ACCOUNT_SID       Twilio account SID
TWILIO_AUTH_TOKEN        Twilio auth token
TWILIO_FROM_NUMBER       Your Twilio phone number
INTERNAL_WEBHOOK_SECRET  Any strong random string — required in all webhook headers
PORT                     Default 3000
```

## Client Config (stored in `clients` table, not env vars)

Each client has their own:
- WhatsApp credentials (`wa_phone_number_id`, `wa_access_token`)
- SMS credentials (`sms_account_sid`, `sms_auth_token`, `sms_from_number`)
- Working hours + timezone
- Message templates (`first_message`, `bump1`, `bump2`, `reach_back_out_message_template`)
- CRM credentials (`crm_type`, `crm_api_key`, `crm_base_url`)
- Pipeline config (`pipeline_id`, `pipeline_stage_id`)
- Prompt file path (default: `skills/prompts/conversation.txt`)
- Loop counter max (default: 20)

## Adding a New Client

POST to `/admin/clients` with `x-iae-secret` header:

```json
{
  "id": "client_abc",
  "name": "Acme Corp",
  "timezone": "Australia/Sydney",
  "channel": "whatsapp",
  "wa_phone_number_id": "...",
  "wa_access_token": "...",
  "first_message_template": "Hi {{first_name}}, ..."
}
```

## AI Prompt File

Lives at `skills/prompts/conversation.txt` (or custom path per client).

Read fresh from disk on every AI call — edit it and changes are live immediately, no restart needed.

Template variables:
- `{{first_name}}` — lead's first name
- `{{last_name}}` — lead's last name
- `{{phone_number}}` — lead's phone
- `{{client_name}}` — client business name
- `{{conversation_history}}` — full chat history
- `{{first_message}}` — the original first message sent
- `{{current_date}}` — today's date in Africa/Johannesburg timezone, injected by `generate.ts` at call time (e.g. "Wednesday, 9 April 2026") — allows Claude to calculate relative dates like "next Thursday"

**Critical:** The prompt must instruct Claude to use exact keyword phrases (`not interested`, `Goodbye`, etc.) because AI Response Send + Keyword Routing scans for these exact strings.
