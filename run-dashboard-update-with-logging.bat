@echo off
cd /d %~dp0
set LOGFILE=logs\hourly-run.log
echo [%DATE% %TIME%] Starting hourly dashboard refresh >> "%LOGFILE%"
call run-dashboard-update.bat >> "%LOGFILE%" 2>&1
if %ERRORLEVEL%==0 (
  echo [%DATE% %TIME%] Completed successfully – exit code 0 >> "%LOGFILE%"
) else (
  echo [%DATE% %TIME%] Failed with exit code %ERRORLEVEL% >> "%LOGFILE%"
)
