# Queue

## Files
- `scheduler.ts` — tick driver; runs every 60s; calls all queue processors in order

## Tick order (every 60s)
1. `processDripQueue()` — first messages (`outbound-first-message.ts`)
2. `processFollowUpQueue()` — day-7 / day-14 / day-21 follow-ups (defined here)
3. `processBumpQueue()` — 24h / 48h / 72h bumps (`bump-handler.ts`)
4. `processBumpCloseQueue()` — 73h bump close (`bump-handler.ts`)
5. `processReachBackOutQueue()` — scheduled reach-back-outs (defined here)
6. `db.releaseStaleLocks()` — force-releases locks older than 2 minutes

## Rules
- All processors use `FOR UPDATE SKIP LOCKED LIMIT 10` — safe for concurrent ticks
- Bump logic (scheduling, cancellation, sending) lives in `src/workflows/bump-handler.ts` — do not add bump SQL here
- The weekly report scheduler runs once at startup and self-reschedules for the following Monday 09:00 Africa/Johannesburg
- Daily send counts and last-sent timestamps are in-memory Maps — they reset on server restart
