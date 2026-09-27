$ErrorActionPreference = 'Continue'
$out = @()
$out += '--- Cherry Studio processes (path) ---'
$procs = Get-CimInstance Win32_Process -Filter "Name like '%Cherry%'"
if ($procs) {
  foreach ($p in $procs) { $out += ('pid={0}  {1}' -f $p.ProcessId, $p.ExecutablePath) }
} else {
  $out += 'NO Cherry Studio process running'
}
$out += ''
$out += '--- app.asar mtime ---'
$asar = 'C:\Users\alexy\workspace\cherry-studio\dist\win-unpacked\resources\app.asar'
if (Test-Path -LiteralPath $asar) { $out += (Get-Item -LiteralPath $asar).LastWriteTime.ToString('o') }
Set-Content -LiteralPath 'C:\Users\alexy\workspace\cherry-studio\reports\diag-exepath.txt' -Value $out -Encoding UTF8
