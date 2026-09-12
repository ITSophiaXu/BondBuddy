@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0start.ps1" -Port 8766 -Background -OpenBrowser -Restart
if errorlevel 1 (
  echo Restart did not finish. Please share the error message shown above.
  pause
)
endlocal
