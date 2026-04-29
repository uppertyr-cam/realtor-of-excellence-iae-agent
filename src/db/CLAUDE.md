# Database

See full schema docs: `@../../docs/database.md`

## Rules
- Never change the schema without also updating `schema.sql`
- Always wrap lock acquire/release in `try/finally`
- `db.acquireLock(contactId)` before processing, `db.releaseLock(contactId)` when done
- Stale locks (>2min) are auto-released by the scheduler — do not build workarounds for this
