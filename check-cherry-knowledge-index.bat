@echo off
setlocal

set SCRIPT_DIR=%~dp0
set PS_SCRIPT=%SCRIPT_DIR%scripts\check-cherry-knowledge-index.ps1

if not exist "%PS_SCRIPT%" (
  echo Cannot find "%PS_SCRIPT%".
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

echo.
echo Done. Press any key to close this window.
pause >nul
