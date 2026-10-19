param([ValidateSet('start','status','stop')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runtime = Join-Path $repo '.local-design'
$pidFile = Join-Path $runtime 'server.pid'
$vite = Join-Path $repo 'node_modules/vite/bin/vite.js'
$url = 'http://127.0.0.1:5186/#tasks'
function Get-DesignProcess {
  if (!(Test-Path -LiteralPath $pidFile)) { return $null }
  $recordedPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid"
  if (!$candidate) { return $null }
  if (!$candidate.CommandLine.Contains($vite) -or !$candidate.CommandLine.Contains('project-design') -or !$candidate.CommandLine.Contains('5186')) {
    throw 'PID now belongs to another process. No action taken.'
  }
  return $candidate
}
$existing = Get-DesignProcess
if ($Action -eq 'stop') {
  if ($existing) { Stop-Process -Id $existing.ProcessId; Write-Output 'Local design preview stopped; saved browser data retained.' }
  else { Write-Output 'Local design preview is not running.' }
  exit
}
if ($Action -eq 'status') {
  if ($existing) {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:5186/' -UseBasicParsing
    Write-Output "Running: $url (PID $($existing.ProcessId), HTTP $($response.StatusCode))"
  } else { Write-Output 'Local design preview is not running.' }
  exit
}
if ($existing) { Write-Output "Already running: $url"; exit }
if (!(Test-Path -LiteralPath $vite)) { throw 'Install repository dependencies first (npm ci from the repository root).' }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (!$node) {
  $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  if (Test-Path -LiteralPath $bundledNode) { $node = $bundledNode } else { throw 'Node.js 22 or later is required.' }
}
$child = Start-Process -FilePath $node -ArgumentList @(('"' + $vite + '"'),'--mode','project-design','--host','127.0.0.1','--port','5186','--strictPort') -WorkingDirectory (Join-Path $repo 'apps/web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'server.log') -RedirectStandardError (Join-Path $runtime 'server-error.log') -PassThru
$child.Id | Set-Content -LiteralPath $pidFile
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if ($child.HasExited) { throw (Get-Content -LiteralPath (Join-Path $runtime 'server-error.log') -Raw) }
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:5186/' -UseBasicParsing
    if ($response.StatusCode -eq 200) { Write-Output "Ready: $url (PID $($child.Id))"; exit }
  } catch { Start-Sleep -Milliseconds 500 }
}
throw 'Preview did not become ready. Check .local-design/server-error.log.'
