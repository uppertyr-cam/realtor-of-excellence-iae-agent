# Session Notes — 2026-05-02

## What Was Done

### Scheduler tick alert flood — diagnosed and fixed
- Root cause: `processDripQueue` had zero per-client error handling — any failure in `getClientConfig` or `sendFirstMessage` bubbled straight to the scheduler tick catch and fired an alert email every 60 seconds
- `alertEmail` had no rate-limiting — once broken, 1,440 emails/day
- Fixes applied:
  - `src/utils/alert.ts` — 30-minute cooldown per alert subject
  - `src/queue/scheduler.ts` — `runSchedulerStep` now wraps error with step name so email says `[processDripQueue] column not found` instead of just `column not found`
  - `src/queue/scheduler.ts` — startup `setTimeout` now has try/catch (was causing unhandled rejections)
  - `src/workflows/outbound-first-message.ts` — `processDripQueue` loop body wrapped in per-client try/catch
- Deployed to VPS: `git pull && npm run build && npm run db:migrate && pm2 restart iae-agent`
- VPS restart counter was at 142 before fix

### Committed all pending local-only files
- `src/inbox/` — live conversation inbox (SSE events, auth, queries, UI)
- `src/config/pricing.ts` — WhatsApp marketing template cost calculator
- `src/notifications/lead-notifications.ts` — branded HTML lead notification emails
- Resolved merge conflict with remote (remote had an older `runSchedulerStep` without step-name wrapping)

### Security audit before public repo release
- Removed hardcoded client emails from `src/notifications/lead-notifications.ts` → moved to `NOTIFICATION_TO_QUALIFIED`, `NOTIFICATION_TO_CLOSED`, `NOTIFICATION_CC_EMAIL` env vars
- Removed `cameron@hyperzenai.com` from `src/reports/dashboard.ts` → moved to `GOOGLE_SHEETS_SHARE_EMAIL` env var
- `infrastructure/deploy.sh` was never committed (gitignored via `*.sh`) — no issue
- Cape Town Lux Reputation Management: clean, no secrets in committed files

## Pending / Next Session

- Add 4 new env vars to VPS `.env` before lead notifications will work:
  ```
  NOTIFICATION_CC_EMAIL=cameron@uppertyr.com
  NOTIFICATION_TO_QUALIFIED=sean@realgroup.co.za,charmaine@realgroup.co.za,reception@realgroup.co.za
  NOTIFICATION_TO_CLOSED=charmaine@realgroup.co.za,dorinda@realgroup.co.za,sean@realgroup.co.za
  GOOGLE_SHEETS_SHARE_EMAIL=cameron@hyperzenai.com
  ```
- Confirm scheduler tick alerts have stopped (restart counter should stay at 142)
- GitHub repo moved to `uppertyr-cam/realtor-of-excellence-iae-agent` — update local remote URL if needed
- Inbox is live at `http://149.102.130.181:3000/inbox` (HTTP only, no SSL — expected)
- Session handoff rule added to ROE and Cape Town Lux CLAUDE.md — matches Uppertyr's `sessions/current.md` pattern

## State of the System
- VPS: online, pm2 process ID 0, last restarted this session
- All source files committed and pushed
- DB migrations current
