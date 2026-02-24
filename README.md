# CRM-DASHBOARD

## Dashboard Update Workflow

- `run-dashboard-update.bat` orchestrates the full refresh: it reruns the core metrics script (`npm run update`), the full and 7-day bulk call analyses (`bulk-call`, `bulk-call-7d`), and the call duration insights (`call-duration`).
- After rebuilding the JSON assets it stages and commits the `data/` folder and pushes to `origin/main`, so the hosted dashboard always picks up the latest files.
- Scheduled Windows Task Scheduler jobs (`DashboardUpdate10` and `DashboardUpdate17`) now run the batch every day at 10:00 AM and 5:00 PM IST. The log lives under `logs/scheduled-run.log`.
- This README is the quick reference for the automation in case this session context isn’t available.
- When you type `/refresh dashboard`, run `refresh-dashboard.bat` (it simply calls `run-dashboard-update.bat`, so the command is case-insensitive shorthand for kicking off the update pipeline).
- I’m writing this so it’s preserved in the repo: if this session memory disappears, the README contains the instructions you asked to remember.

## Dashboard Update Flow
- Run `run-dashboard-update.bat` to pull the freshest CRM data and rebuild the analytics assets.
- Perform any manual analysis and update the dashboard/AI insights so the new insights are captured in HTML/JS content.
- After the analytic updates are complete, rerun `run-dashboard-update.bat` so the final dataset and dashboard files (including AI insights) are rebuilt and pushed.

## Today’s Call Follow-up Flow
1. Fetch today’s calls using the Zoho CRM API (refresh token → access token → `GET /crm/v2/Calls` with sort_by=Created_Time desc) and filter to records with non-empty Zia summaries.
2. Write the filtered detail list to `E:/Dashboard/calls_with_summary_YYYYMMDD.json` for future reference.
3. Analyze each record for intent, sentiment, callbacks, and summary completeness, then generate per-call tasks (capture owner, subject, summary snippet, and recommended next steps). Export the full action list to `E:/Dashboard/today_call_tasks.txt` and optionally prepare a top follow-ups message (`followup_message.txt`).
4. Post the summary message (top leads) or the full per-call tasks in the designated Cliq channel (e.g., `testing`) using the `/company/{org}/api/v2/channelsbyname/{channel}/message` endpoint with the `ZohoCliq.Webhooks.CREATE` scope.
5. When requested, cycle through all qualifying calls to deliver structured action-item messages (owner, call IDs, summary snippet, ➊/➋ steps) to the same Cliq channel so the team can execute follow-ups without missing any record.
6. Keep the README current with each additional automation step so the process survives session restarts.
