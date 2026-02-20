@echo off
setlocal
cd /d E:\Dashboard
set LOG_DIR=E:\Dashboard\logs
set LOG_FILE=%LOG_DIR%\scheduled-run.log
if not exist %LOG_DIR% mkdir %LOG_DIR%
>> %LOG_FILE% echo ==========================================================================
>> %LOG_FILE% echo Started at %date% %time%
"C:\Program Files\nodejs\npm.cmd" run update >> %LOG_FILE% 2>&1
set EXIT_CODE=%ERRORLEVEL%
>> %LOG_FILE% echo Finished at %date% %time% with exit code %EXIT_CODE%

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
