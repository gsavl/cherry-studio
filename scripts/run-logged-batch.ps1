param(
  [Parameter(Mandatory)]
  [string]$BatchPath
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$resolvedBatchPath = (Resolve-Path -LiteralPath $BatchPath).Path
$projectDirectory = Split-Path -Parent $resolvedBatchPath
$reportDirectory = Join-Path $projectDirectory 'reports'
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$logPath = Join-Path $reportDirectory "sync-cherry-knowledge-$timestamp.log"
$suffix = 1
while (Test-Path -LiteralPath $logPath) {
  $logPath = Join-Path $reportDirectory "sync-cherry-knowledge-$timestamp-$suffix.log"
  $suffix += 1
}

# The batch file is a native process. Start-Transcript cannot see its stdout,
# so the output is piped back into PowerShell and re-emitted with Write-Host.
# Piping also keeps the console live so the transcript captures everything.
$env:CHERRY_KB_NO_PAUSE = '1'
$exitCode = 1
Start-Transcript -Path $logPath | Out-Null
try {
  Write-Host "[log-file] $logPath"
  Write-Host "[started-at] $(Get-Date -Format 'o')"
  # tsx writes progress to stderr. Merging it into the pipeline turns those lines
  # into ErrorRecords, which would abort the script under ErrorActionPreference Stop.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $resolvedBatchPath --run-logged 2>&1 | ForEach-Object {
      Write-Host "$_"
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
} catch {
  Write-Host "Logging runner failed: $_" -ForegroundColor Red
} finally {
  $env:CHERRY_KB_NO_PAUSE = $null
  Write-Host "[batch-exit-code] $exitCode"
  Write-Host "[finished-at] $(Get-Date -Format 'o')"
  Stop-Transcript | Out-Null
}

exit $exitCode
