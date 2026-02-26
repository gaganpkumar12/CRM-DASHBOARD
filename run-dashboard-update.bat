@echo off
REM ============================================================================
REM  Dashboard Data Updater
REM  Schedule this AFTER the CRM quiet period for fastest runs + freshest data.
REM  Runs at 10:00 AM IST and 5:00 PM IST daily.
REM
REM  To schedule via Task Scheduler (run these two commands once as Admin):
REM    schtasks /create /tn "DashboardUpdate_10AM" /tr "E:\Dashboard\run-dashboard-update.bat" ^
REM      /sc daily /st 10:00 /ru SYSTEM
REM    schtasks /create /tn "DashboardUpdate_5PM" /tr "E:\Dashboard\run-dashboard-update.bat" ^
REM      /sc daily /st 17:00 /ru SYSTEM
REM ============================================================================
setlocal
cd /d E:\Dashboard
set LOG_DIR=E:\Dashboard\logs
set LOG_FILE=%LOG_DIR%\scheduled-run.log
if not exist %LOG_DIR% mkdir %LOG_DIR%
>> %LOG_FILE% echo ==========================================================================
>> %LOG_FILE% echo Started at %date% %time%

REM --- 1. Core metrics + 7-day category-wise lead conversion => data/metrics.json ---
>> %LOG_FILE% echo [1/4] Updating core metrics (KPIs, retention, NC ladder, 7-day category lead conversion)...
CALL "C:\Program Files\nodejs\npm.cmd" run update >> %LOG_FILE% 2>&1
if %ERRORLEVEL% NEQ 0 (
  >> %LOG_FILE% echo [WARN] Core metrics update failed with exit code %ERRORLEVEL%
) else (
  >> %LOG_FILE% echo [OK] Core metrics + 7-day category conversions written to data/metrics.json
)

REM --- 2. Bulk call analysis (all history) => data/bulk-call-analysis.json ---
>> %LOG_FILE% echo [2/4] Running bulk call analysis...
CALL "C:\Program Files\nodejs\npm.cmd" run bulk-call >> %LOG_FILE% 2>&1
if %ERRORLEVEL% NEQ 0 (
  >> %LOG_FILE% echo [WARN] Bulk call analysis failed with exit code %ERRORLEVEL%
)

REM --- 3. Bulk call analysis (7-day) => data/bulk-call-analysis-7d-full.json ---
>> %LOG_FILE% echo [3/4] Running 7-day bulk call analysis...
CALL "C:\Program Files\nodejs\npm.cmd" run bulk-call-7d >> %LOG_FILE% 2>&1
if %ERRORLEVEL% NEQ 0 (
  >> %LOG_FILE% echo [WARN] 7-day bulk call analysis failed with exit code %ERRORLEVEL%
)

REM --- 4. Call duration insights => data/call-duration-insights.json ---
>> %LOG_FILE% echo [4/4] Running call duration analysis...
CALL "C:\Program Files\nodejs\npm.cmd" run call-duration >> %LOG_FILE% 2>&1
if %ERRORLEVEL% NEQ 0 (
  >> %LOG_FILE% echo [WARN] Call duration analysis failed with exit code %ERRORLEVEL%
)

set EXIT_CODE=0
>> %LOG_FILE% echo All data updates finished at %date% %time%

REM --- Auto-push ALL changes to GitHub Pages ---
>> %LOG_FILE% echo Pushing changes to GitHub...
git add -A >> %LOG_FILE% 2>&1
git diff --cached --quiet
if %ERRORLEVEL% NEQ 0 (
  git commit -m "data: auto-update %date% %time%" >> %LOG_FILE% 2>&1

  REM Pull remote changes first to avoid rejection
  >> %LOG_FILE% echo Pulling remote changes before push...
  git pull origin main --rebase >> %LOG_FILE% 2>&1

  git push origin main >> %LOG_FILE% 2>&1
  if %ERRORLEVEL% NEQ 0 (
    >> %LOG_FILE% echo [WARN] Push failed, retrying with force-with-lease...
    git push origin main --force-with-lease >> %LOG_FILE% 2>&1
  )
  >> %LOG_FILE% echo Push completed at %date% %time%
) else (
  >> %LOG_FILE% echo No data changes to push.
)

endlocal
exit /b %EXIT_CODE%
