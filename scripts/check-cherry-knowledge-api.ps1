param(
  [string]$ApiUrl = "",
  [string]$ApiKey = "",
  [string]$ExpectedCherryPath = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RequiredPaths = @(
  "/v1/knowledge-bases/{id}/directories",
  "/v1/knowledge-bases/{id}/directories/{itemId}/refresh",
  "/v1/knowledge-bases/jobs/{jobId}"
)

function Get-ApiRoot {
  param([string]$Value)

  $trimmed = ""
  if ($Value) {
    $trimmed = $Value.Trim().TrimEnd("/")
  }
  if (-not $trimmed) {
    $trimmed = "http://127.0.0.1:23333"
  }

  if ($trimmed.EndsWith("/v1", [System.StringComparison]::OrdinalIgnoreCase)) {
    return $trimmed.Substring(0, $trimmed.Length - 3)
  }

  return $trimmed
}

function Write-Failure {
  param([string[]]$Lines)

  Write-Host "Cherry API preflight failed." -ForegroundColor Red
  Write-Host ""
  foreach ($line in $Lines) {
    Write-Host $line
  }
  Write-Host ""
}

$ApiRoot = Get-ApiRoot $ApiUrl
$DocsUrl = "$ApiRoot/openapi/json"
$Headers = @{
  Accept = "application/json"
}

if ($ApiKey) {
  $Headers.Authorization = "Bearer $ApiKey"
}

try {
  $response = Invoke-WebRequest -Uri $DocsUrl -Headers $Headers -UseBasicParsing -TimeoutSec 12
} catch {
  Write-Failure @(
    "Could not reach Cherry API Server at $ApiRoot.",
    "Make sure Cherry Studio is open and Settings > API Server is enabled.",
    "If you use a custom port, set CHERRY_KB_API_BASE or CHERRY_API_BASE before running this script."
  )
  Write-Host "Details: $($_.Exception.Message)"
  exit 1
}

$contentType = ($response.Headers["Content-Type"] -join ",")
try {
  $payload = $response.Content | ConvertFrom-Json
} catch {
  $prefix = ""
  if ($response.Content) {
    $prefix = $response.Content
  }
  if ($prefix.Length -gt 180) {
    $prefix = $prefix.Substring(0, 180)
  }

  Write-Failure @(
    "The API Server at $ApiRoot did not return JSON from /openapi/json.",
    "Content-Type: $contentType",
    "Response prefix: $prefix"
  )
  exit 1
}

$paths = @()
if ($payload.paths) {
  $paths = @($payload.paths.PSObject.Properties.Name)
}

$missing = @($RequiredPaths | Where-Object { $paths -notcontains $_ })
if ($missing.Count -gt 0) {
  $lines = @(
    "Connected to Cherry API Server at $ApiRoot, but it does not expose the knowledge directory refresh API.",
    "This usually means the regular installed Cherry Studio is running instead of this fork build.",
    "Missing API path(s):"
  )

  foreach ($path in $missing) {
    $lines += "  - $path"
  }

  if ($ExpectedCherryPath) {
    $lines += ""
    $lines += "Close the current Cherry Studio instance, then start this fork build:"
    $lines += "  $ExpectedCherryPath"
  }

  Write-Failure $lines
  exit 1
}

Write-Host "Cherry API preflight passed: $ApiRoot"
exit 0
