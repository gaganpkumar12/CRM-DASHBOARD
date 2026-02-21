@echo off
REM ============================================================================
REM  Dashboard Data Updater
REM  Schedule this AFTER the CRM quiet period for fastest runs + freshest data.
REM  Recommended: 6:30 AM IST (01:00 UTC) when overnight syncs are done.
REM
REM  To schedule via Task Scheduler:
REM    schtasks /create /tn "DashboardUpdate" /tr "E:\Dashboard\run-dashboard-update.bat" ^
REM      /sc daily /st 06:30 /ru SYSTEM
REM ============================================================================
setlocal
cd /d E:\Dashboard
set LOG_DIR=E:\Dashboard\logs
set LOG_FILE=%LOG_DIR%\scheduled-run.log
if not exist %LOG_DIR% mkdir %LOG_DIR%
>> %LOG_FILE% echo ==========================================================================
>> %LOG_FILE% echo Started at %date% %time%

REM --- 1. Core metrics (leads, calls, deals, tasks) => data/metrics.json ---
>> %LOG_FILE% echo [1/4] Updating core metrics...
CALL "C:\Program Files\nodejs\npm.cmd" run update >> %LOG_FILE% 2>&1
if %ERRORLEVEL% NEQ 0 (
  >> %LOG_FILE% echo [WARN] Core metrics update failed with exit code %ERRORLEVEL%
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

REM --- Auto-push updated data to GitHub Pages ---
>> %LOG_FILE% echo Pushing data to GitHub...
git add data/ >> %LOG_FILE% 2>&1
git diff --cached --quiet
if %ERRORLEVEL% NEQ 0 (
  git commit -m "data: auto-update %date% %time%" >> %LOG_FILE% 2>&1
  git push origin main >> %LOG_FILE% 2>&1
  >> %LOG_FILE% echo Push completed at %date% %time%
) else (
  >> %LOG_FILE% echo No data changes to push.
)

endlocal
exit /b %EXIT_CODE%
