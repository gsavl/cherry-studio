$ErrorActionPreference = 'Continue'
$out = @()
$log = 'C:\Users\alexy\AppData\Local\Ollama\server.log'

function Get-OllamaProcs {
  Get-Process | Where-Object { $_.ProcessName -match 'ollama' -or $_.ProcessName -match 'llama' }
}

$out += '--- before ---'
Get-OllamaProcs | ForEach-Object { $out += ('  ' + $_.ProcessName + ' pid=' + $_.Id) }

# 1) stop ollama app + server + runners
Get-OllamaProcs | ForEach-Object {
  try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; $out += "stopped pid=$($_.Id)" }
  catch { $out += "stop failed pid=$($_.Id): $($_.Exception.Message)" }
}
Start-Sleep -Seconds 4

$out += '--- after stop ---'
$left = Get-OllamaProcs
if ($left) { $left | ForEach-Object { $out += ('  still: ' + $_.ProcessName + ' pid=' + $_.Id) } } else { $out += '  none' }

# 2) mark position in log so we can read the new startup section
$marker = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { 0 }
$out += "log size before start: $marker"

# 3) start the tray app the same way Ollama normally runs
$exe = 'C:\Users\alexy\AppData\Local\Programs\Ollama\ollama app.exe'
if (Test-Path -LiteralPath $exe) {
  Start-Process -FilePath $exe
  $out += "started: $exe"
} else {
  $out += "MISSING: $exe"
}

Start-Sleep -Seconds 12

$out += '--- running now ---'
Get-OllamaProcs | ForEach-Object { $out += ('  ' + $_.ProcessName + ' pid=' + $_.Id) }

# 4) read the new log section, pull the effective config
Start-Sleep -Seconds 5
if (Test-Path -LiteralPath $log) {
  $new = (Get-Item -LiteralPath $log).Length - $marker
  $txt = ''
  if ($new -gt 0) {
    $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
    $fs.Seek($marker, 'Begin') | Out-Null
    $buf = New-Object byte[] $new
    $fs.Read($buf, 0, $new) | Out-Null
    $fs.Close()
    $txt = [System.Text.Encoding]::UTF8.GetString($buf)
  } else {
    $txt = Get-Content -LiteralPath $log -Raw -Encoding UTF8
  }
  $out += '--- new log: server config line ---'
  $m = [regex]::Match($txt, 'msg="server config" env="(?<env>[^"]*)"')
  if ($m.Success) {
    $envmap = $m.Groups['env'].Value
    foreach ($k in @('OLLAMA_MAX_LOADED_MODELS','OLLAMA_NUM_PARALLEL','OLLAMA_CONTEXT_LENGTH','OLLAMA_KEEP_ALIVE','OLLAMA_HOST')) {
      $mm = [regex]::Match($envmap, [regex]::Escape($k) + ':[^\s]*')
      $out += ('  ' + $(if ($mm.Success) { $mm.Value } else { "$k: (absent)" }))
    }
  } else {
    $out += '  server config line NOT found yet; tail:'
    $out += (($txt -split "`n") | Select-Object -Last 6)
  }
  $out += '--- listening / version ---'
  $lm = [regex]::Match($txt, 'Listening on [^\s]* \(version [^"]*\)')
  if ($lm.Success) { $out += '  ' + $lm.Value } else { $out += '  (not listening yet)' }
}

Set-Content -LiteralPath 'C:\Users\alexy\workspace\cherry-studio\reports\_diag-scratch\diag-restart-out.txt' -Value $out -Encoding UTF8
