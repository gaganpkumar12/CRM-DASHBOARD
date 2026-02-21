@echo off
REM Shortcut for manual refresh triggered by "/refresh dashboard"
cd /d %~dp0
call run-dashboard-update.bat
