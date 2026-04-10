# CRM

## normalizer.ts
Maps any CRM's raw webhook payload to the internal `Contact` schema.
Add a new CRM type: add a case to the switch statement with their field mappings.

## adapter.ts
Writes tags, notes, and pipeline fields back to the originating CRM.
Add a new CRM type: add a write function for their API.

## Rules
- CRM write failures are non-fatal — log and continue, never throw or crash the workflow
- Never hardcode credentials — always read from the `clients` table via `client-config.ts`
