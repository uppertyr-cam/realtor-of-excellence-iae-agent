# skills/

Workflow SOPs, AI prompt files, and automation skill definitions.

## Files

| File | What it contains |
|------|-----------------|
| `prompts/conversation.txt` | Main AI conversation prompt — injected for every lead reply |
| `prompts/ai-note-taker.txt` | Prompt for generating contact notes after conversation |
| `prompts/bumps.txt` | Prompt for bump message generation (24h/48h/72h follow-ups) |
| `prompts/reach-back-out.txt` | Prompt for re-engagement messages |
| `iae_00_outbound_first_message.md` | SOP: how the outbound first message workflow operates |
| `iae_01_inbound_reply_handler.md` | SOP: how inbound replies are received, debounced, and routed |
| `iae_02_send_keyword_routing.md` | SOP: keyword detection logic and pipeline routing |
| `scheduler_queue_processors.md` | SOP: scheduler tick, queue processors, drip queue |
| `meta_skill.skill` | Skill Architect pattern for detecting and standardising recurring workflows |

---

## Rules

- Never change keyword strings in `detectKeyword()` without also updating `skills/prompts/conversation.txt`
- Prompt files are read at runtime by `src/ai/generate.ts` — changes take effect immediately (no restart needed)
- To add a new skill: use the Detect → Standardize → Commit pattern in `meta_skill.skill`
