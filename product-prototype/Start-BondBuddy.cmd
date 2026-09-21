@echo off
setlocal
cd /d "%~dp0"
set "BOND_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BOND_NODE%" (
  echo BondBuddy: http://127.0.0.1:4320
  "%BOND_NODE%" server.mjs
) else (
  node server.mjs
)
pause
