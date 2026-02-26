# CRM-DASHBOARD

## Quick Reference

This README documents the full automation pipeline so it's preserved in the repo even if session context is lost.

---

## Dashboard Update Workflow

### Entry Point
- **`run-dashboard-update.bat`** — orchestrates the complete data refresh pipeline
- **`refresh-dashboard.bat`** — shortcut that calls `run-dashboard-update.bat` (use `/refresh dashboard` to trigger)

### Scheduling
Two Windows Task Scheduler jobs run the batch daily:
- `DashboardUpdate_10AM` → 10:00 AM IST
- `DashboardUpdate_5PM` → 5:00 PM IST

Logs are written to `logs/scheduled-run.log`.

---

## Pipeline Steps (run-dashboard-update.bat)

### Step [1/4] — Core Metrics + Category Lead Conversion
**Script:** `npm run update` → `node scripts/update-data.mjs`
**Output:** `data/metrics.json`

Fetches from Zoho CRM API and computes:

| Section | What it produces | Scope |
|---------|-----------------|-------|
| **CRM KPIs** | todaysLeadsCount, NC1/NC2/NC3 counts, leadToDealConversion%, totalDeals, totalTasks, taskCompletion%, avgCallDuration | Today + 7d lookback for NC |
| **Category Lead → Deal Conversion** | Per-category leads, deals, conversion% using `I_am_looking_for` field (auto-detected) | **Last 7 days** incl. today |
| **Retention Trend** | Hourly retention% (called leads / created leads per IST hour) | Today |
| **Call Duration & Volume** | Call count + avg duration by day of week | All fetched calls (200) |
| **NC Ladder Intelligence** | NC1→NC2→NC3 progression%, avg hours between stages, SLA overdue counts, cumulative & direct funnels | 7d lookback |
| **NC Best Time Insights** | Ideal callback hour, peak NC1/NC2 hours, per-stage ideal time | 7d lookback |
| **Latest Leads** | Name, phone, owner, status, sub-status, called flag, modified time | 7d lookback (max 200) |
| **Owner-wise Retention** | Per-rep today's leads, called leads, retention% | Today |
| **Owner-wise Performance** | Per-rep leads, deals, lead→deal%, tasks, task completion%, retention% | Today |
| **Overdue Follow-ups** | Leads not called beyond configured SLA minutes | 7d lookback |

**Category conversion logic:**
1. Auto-detects the best category field from Zoho leads (priority: `I_am_looking_for` → `Service_Category_n` → `Lead_Source` → others). Configurable via `config.json` → `dashboard.categoryFields`.
2. Filters leads & deals to the last 7 days (uses `dashboard.lookbackDays` from config).
3. Matches leads to deals by phone number, contact name, or converted/won lead status.
4. Handles array fields (e.g. `I_am_looking_for: ["Cleaning Services"]`) and object fields (e.g. `Contact_Name: { name: "..." }`).

### Step [2/4] — Bulk Call Analysis (All History)
**Script:** `npm run bulk-call` → `node scripts/bulk-call-analysis.mjs minRecords=1200 lookback=7`
**Output:** `data/bulk-call-analysis.json`

Analyzes the last 1,200+ calls — agent breakdown, call type summary, sentiment/intent distribution, duration buckets.

### Step [3/4] — Bulk Call Analysis (7-Day)
**Script:** `npm run bulk-call-7d` → `node scripts/bulk-call-analysis.mjs minRecords=1200 lookback=7 output=bulk-call-analysis-7d-full.json`
**Output:** `data/bulk-call-analysis-7d-full.json`

Same analysis scoped to the last 7 days for the AI Insights page.

### Step [4/4] — Call Duration Insights
**Script:** `npm run call-duration` → `node scripts/call-duration-analysis.mjs`
**Output:** `data/call-duration-insights.json`

Talk time breakdown, duration vs outcome, agent efficiency scores.

### Post-Steps — Git Push
After all 4 data steps complete:
1. `git add -A` — stages all changed files
2. `git commit` — only if there are changes
3. `git pull --rebase` + `git push origin main` — pushes to GitHub Pages
4. Falls back to `--force-with-lease` if normal push fails

---

## Frontend Rendering (app.js)

When `index.html` loads (or the ↻ Refresh button is clicked):

1. **`loadData()`** fetches `data/metrics.json?t=<cache-bust>`
2. Computes data freshness indicator (🟢 ≤5m, 🟡 ≤30m, 🔴 stale)
3. Calls in order:
   - `buildKpis()` → CRM KPI cards
   - `buildCategoryConversionCards()` → summary cards (overall conv%, top category, count) + per-category cards
   - `buildCharts()` → retention line chart, call duration/volume chart, NC trend, NC funnels
   - `buildTables()` → latest leads table, owner retention table, owner performance table, NC ideal time table
4. Auto-refresh runs every 6 hours via `setInterval`

---

## Dashboard Sections

### Home Page (index.html)
| Widget | Data Source |
|--------|-----------|
| CRM KPIs (9 cards) | `metrics.json → kpis` |
| Category Lead → Deal Conversion (7 Days) | `metrics.json → categoryConversions` |
| Today Retention Trend (Hourly) | `metrics.json → retention` |
| Call Duration & Volume | `metrics.json → calls` |
| NC Ladder Intelligence (KPIs + funnels) | `metrics.json → ncLadder` |
| Ideal Callback Time by Stage | `metrics.json → ncLadder.idealByStage` |
| Latest Leads table | `metrics.json → latestLeadsToday` |
| Owner-wise Retention table | `metrics.json → ownerStats` |
| Owner-wise Performance table | `metrics.json → ownerStats` |

### AI Insights Page (ai-insights.html)
| Widget | Data Source |
|--------|-----------|
| Latest CRM Signals | `metrics.json` |
| Call Analytics KPIs | `bulk-call-analysis-7d-full.json` |
| Duration Mix / Status Distribution | `bulk-call-analysis-7d-full.json` |
| Talk Time Summary | `call-duration-insights.json` |
| Agent Talk Time Leaderboard | `call-duration-insights.json` |
| Agent Efficiency | `bulk-call-analysis.json` |
| Repeat Loss Audit | `bulk-call-analysis-7d-full.json` |
| Call Duration vs Outcome | `call-duration-insights.json` |
| Customer Engagement Engine | `bulk-call-analysis-7d-full.json` |
| Win-Back Prediction Hub | `bulk-call-analysis-7d-full.json` |

---

## Config (config.json)

```json
{
  "zoho": { "region": "in", "clientId": "...", "clientSecret": "...", "refreshToken": "..." },
  "dashboard": {
    "lookbackDays": 7,
    "maxLeadPages": 10,
    "overdueMinutes": 30,
    "ncSlaHours": { "nc1ToNc2": 4, "nc2ToNc3": 24 },
    "categoryFields": ["I_am_looking_for", "Service_Category_n", "Lead_Source", "..."]
  }
}
```

`categoryFields` controls which Zoho lead field is used for category conversion. The first field with data wins.

---

## Manual Refresh
```
run-dashboard-update.bat          # full pipeline
refresh-dashboard.bat             # same thing, shorter name
npm run update                    # just core metrics + category conversions
npm run update-all                # all 4 data scripts in sequence
npm run serve                     # local dev server on port 8080
```
