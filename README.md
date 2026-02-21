# CRM-DASHBOARD

## Dashboard Update Workflow

- `run-dashboard-update.bat` orchestrates the full refresh: it reruns the core metrics script (`npm run update`), the full and 7-day bulk call analyses (`bulk-call`, `bulk-call-7d`), and the call duration insights (`call-duration`).
- After rebuilding the JSON assets it stages and commits the `data/` folder and pushes to `origin/main`, so the hosted dashboard always picks up the latest files.
- Scheduled Windows Task Scheduler jobs (`DashboardUpdate10` and `DashboardUpdate17`) now run the batch every day at 10:00 AM and 5:00 PM IST. The log lives under `logs/scheduled-run.log`.
- This README is the quick reference for the automation in case this session context isn’t available.
- When you type `/refresh dashboard`, run `refresh-dashboard.bat` (it simply calls `run-dashboard-update.bat`, so the command is case-insensitive shorthand for kicking off the update pipeline).
- I’m writing this so it’s preserved in the repo: if this session memory disappears, the README contains the instructions you asked to remember.
