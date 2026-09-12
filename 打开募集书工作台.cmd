@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0start.ps1" -Port 8766 -Background -OpenBrowser
if errorlevel 1 (
  echo Startup failed. Please share the error message shown above.
  pause
)
endlocal
