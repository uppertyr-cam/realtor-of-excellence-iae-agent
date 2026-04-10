# Common Tasks

## Add a new CRM type
Edit `src/crm/normalizer.ts` — add a new case to the switch statement mapping their field names to our internal schema.
Edit `src/crm/adapter.ts` — add a new write function for their API.

## Add a new keyword
Edit `src/workflows/workflow-02.ts` — add detection in `detectKeyword()` and a new case in `handleKeyword()`.
Also update `prompts/conversation.txt` to instruct Claude to use the new keyword phrase.

## Change debounce window
Edit `src/workflows/workflow-01.ts` — change `DEBOUNCE_MS` at the top of the file.

## Change drip rate
Update the client's record in the `clients` table: `daily_send_limit` and `send_interval_minutes`.

## Edit the AI conversation prompt
Edit `prompts/conversation.txt` directly. Changes are live immediately — no restart needed.

## Add a new notification channel for manual takeover
Edit the `notifyAgent()` function in `src/workflows/workflow-01.ts`.

## Test a full flow

1. Start the server: `npm run dev`
2. Add a test client via `POST /admin/clients`
3. Trigger Workflow 00:
```bash
curl -X POST http://localhost:3000/webhook/crm \
  -H "x-iae-secret: your_secret" \
  -H "Content-Type: application/json" \
  -d '{
    "contact_id": "test_001",
    "phone_number": "+61412345678",
    "first_name": "John",
    "client_id": "your_client_id",
    "crm_type": "generic",
    "crm_callback_url": "https://your-crm.com/callback"
  }'
```
4. Watch the logs — contact enters the drip queue
5. Simulate an inbound reply via `POST /webhook/sms` or set up real Meta/Twilio webhooks
