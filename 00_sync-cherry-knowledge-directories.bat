@echo off
if /i "%~1"=="--run-logged" goto :run_logged

setlocal
set "SCRIPT_DIR=%~dp0"
if not exist "%SCRIPT_DIR%scripts\run-logged-batch.ps1" (
  echo Cannot find "%SCRIPT_DIR%scripts\run-logged-batch.ps1".
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\run-logged-batch.ps1" -BatchPath "%~f0"
exit /b %ERRORLEVEL%

:run_logged
shift
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul
set "PATH=C:\Program Files\nodejs;%PATH%"
set "TSX=node_modules\.bin\tsx.cmd"
set "PODCAST_SOURCE=Z:\007 Podcasts\_cherry_knowledge_inputs\preferred\general"

if not exist "%TSX%" (
  echo Cannot find "%TSX%".
  echo.
  echo Run "corepack pnpm install" in this folder first.
  echo.
  goto :failed
)

if not exist "scripts\cherry-knowledge.ts" (
  echo Cannot find "scripts\cherry-knowledge.ts".
  echo.
  goto :failed
)

if not exist "scripts\check-cherry-knowledge-api.ps1" (
  echo Cannot find "scripts\check-cherry-knowledge-api.ps1".
  echo.
  goto :failed
)

if not exist "01_generate-cherry-knowledge-browser.ts" (
  echo Cannot find "01_generate-cherry-knowledge-browser.ts".
  echo.
  goto :failed
)

if not exist "kb-dirs.yaml" (
  echo Cannot find "kb-dirs.yaml".
  echo.
  goto :failed
)

if not exist "scripts\sync-podcast-directories.ts" (
  echo Cannot find "scripts\sync-podcast-directories.ts".
  echo.
  goto :failed
)

if not exist "%PODCAST_SOURCE%\." (
  echo Cannot access the podcast source directory:
  echo "%PODCAST_SOURCE%"
  echo.
  echo Make sure Z: is mapped in this Windows session and the NAS is reachable.
  for /f "delims=" %%A in ('whoami') do echo Current account: %%A
  echo.
  goto :failed
)

echo Discovering new podcast directories...
echo.
call "%TSX%" scripts\sync-podcast-directories.ts --config .\kb-dirs.yaml --source "%PODCAST_SOURCE%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Failed while updating the podcast directory list.
  goto :finish
)

echo.

set "API_KEY="
set "API_KEY_FILE="
set "API_BASE="

if defined CHERRY_KB_API_KEY (
  set "API_KEY=%CHERRY_KB_API_KEY%"
)

if not defined API_KEY if defined CHERRY_API_KEY (
  if exist "%CHERRY_API_KEY%" (
    set "API_KEY_FILE=%CHERRY_API_KEY%"
  ) else (
    set "API_KEY=%CHERRY_API_KEY%"
  )
)

if not defined API_KEY if not defined API_KEY_FILE if defined CHERRY_API_KEY_FILE (
  set "API_KEY_FILE=%CHERRY_API_KEY_FILE%"
)

if not defined API_KEY if not defined API_KEY_FILE if exist "%USERPROFILE%\.cherry-api-key" (
  set "API_KEY_FILE=%USERPROFILE%\.cherry-api-key"
)

if not defined API_KEY if not defined API_KEY_FILE if exist ".cherry-api-key.txt" (
  set "API_KEY_FILE=.cherry-api-key.txt"
)

if defined API_KEY_FILE (
  for /f "usebackq tokens=* delims=" %%A in ("%API_KEY_FILE%") do (
    if not defined API_KEY set "API_KEY=%%A"
  )
)

if not defined API_KEY (
  echo Missing Cherry Studio API key.
  echo.
  echo Set CHERRY_KB_API_KEY, set CHERRY_API_KEY, set CHERRY_API_KEY_FILE,
  echo create "%USERPROFILE%\.cherry-api-key",
  echo or create ".cherry-api-key.txt" in this folder with the API key on the first line.
  echo.
  goto :failed
)

if defined CHERRY_KB_API_BASE (
  set "API_BASE=%CHERRY_KB_API_BASE%"
)

if not defined API_BASE if defined CHERRY_API_BASE (
  set "API_BASE=%CHERRY_API_BASE%"
)

if not defined API_BASE (
  set "API_BASE=http://127.0.0.1:23333"
)

echo Checking Cherry API server...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\check-cherry-knowledge-api.ps1" -ApiUrl "%API_BASE%" -ApiKey "%API_KEY%" -ExpectedCherryPath "%SCRIPT_DIR%dist\win-unpacked\Cherry Studio.exe"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  goto :finish
)

echo.
echo Syncing Cherry knowledge directories...
echo.

echo Step 1/3: adding directories that are not bound yet...
echo.
call "%TSX%" scripts\cherry-knowledge.ts sync-directories --api-key "%API_KEY%" --wait --config .\kb-dirs.yaml
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Failed while adding unbound directories.
  goto :finish
)

echo.
echo Step 2/3: incrementally refreshing already-bound directories...
echo.
set "FAILURE_REPORT=%SCRIPT_DIR%reports\sync-failures-latest.txt"
if exist "%FAILURE_REPORT%" del /f /q "%FAILURE_REPORT%" >nul 2>&1
call "%TSX%" scripts\cherry-knowledge.ts sync-directories --api-key "%API_KEY%" --refresh-existing --mode incremental --wait --config .\kb-dirs.yaml --allow-failures --failure-report "%FAILURE_REPORT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Sync failed with exit code %EXIT_CODE%.
  goto :finish
)

echo Sync completed successfully.
echo.
echo Step 3/3: generating knowledge browser HTML...
echo.
call "%TSX%" 01_generate-cherry-knowledge-browser.ts --config .\kb-dirs.yaml --output .\reports\knowledge-browser.html
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Knowledge browser generated successfully:
  echo "%SCRIPT_DIR%reports\knowledge-browser.html"
) else (
  echo Knowledge browser generation failed with exit code %EXIT_CODE%.
)

if exist "%FAILURE_REPORT%" (
  echo.
  echo *******************************************************
  echo WARNING: some directories failed to refresh this run:
  findstr /b "failed_directories= total_directories=" "%FAILURE_REPORT%"
  echo The failed paths are listed in:
  echo "%FAILURE_REPORT%"
  echo *******************************************************
)

goto :finish

:failed
set "EXIT_CODE=1"

:finish
echo.
if defined CHERRY_KB_NO_PAUSE goto :done
echo Press any key to close this window.
pause >nul

:done

popd >nul
exit /b %EXIT_CODE%
