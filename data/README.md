# Data

AIOS data layer for local file-based inputs and exports.

## Purpose

Supabase is the live data source for all contacts, leads, queue, and configs. This folder is for:
- Lead CSVs imported in bulk
- Contact exports from the CRM or Google Sheets
- Sample files used for testing automations

## Naming Convention

`YYYY-MM-DD_description.ext`

Examples:
- `2026-04-28_cape-town-leads.csv`
- `2026-04-28_inactive-contacts-export.csv`

## Important

All data files (CSV, JSON, XLSX) are gitignored — do not commit contact or lead data to the repo.
