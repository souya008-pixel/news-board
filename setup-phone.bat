@echo off
rem News Board: one-time setup so the app can be opened from a phone via Tailscale.
rem   setup-phone.bat          ... set up
rem   setup-phone.bat -Remove  ... undo
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-phone.ps1" %*
pause
