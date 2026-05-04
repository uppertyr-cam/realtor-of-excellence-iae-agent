# data/

AIOS data layer for local file-based inputs and exports. Supabase is the live data source — this folder is for batch operations only.

## Files

| File | What it contains |
|------|-----------------|
| `README.md` | Usage guide and naming conventions |

---

## Rules

- Naming convention: `YYYY-MM-DD_description.ext` (e.g. `2026-04-28_cape-town-leads.csv`)
- All data files (CSV, JSON, XLSX) are gitignored — never commit contact or lead data to the repo
- README.md is tracked in git; data files are not
