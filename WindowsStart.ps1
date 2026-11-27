$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$workerImage = 'bondbuddy-local-worker:local'
$workerServices = @('worker-authoring', 'worker-review', 'worker-parse')
$baseFiles = @('deploy/local/compose.yaml')
$allFiles = @('deploy/local/compose.yaml', 'deploy/local/compose.workers.yaml')

function Invoke-LocalCompose {
  param([string[]]$Files, [string[]]$ComposeArguments)
  $common = @()
  foreach ($file in $Files) { $common += @('-f', $file) }
  $common += @('-p', 'bondbuddy_m1_local')
  & docker compose @common @ComposeArguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Build-LocalWorkerImage {
  # The root .dockerignore is for the legacy Cowork image and excludes M1 sources, so stage a
  # filtered copy of this worktree before building the production Linux worker target.
  $context = Join-Path ([System.IO.Path]::GetTempPath()) ("bondbuddy-worker-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $context -Force | Out-Null
  try {
    $archive = Join-Path $context 'context.tar'
    & tar --exclude='./.git' --exclude='./node_modules' --exclude='*/node_modules' --exclude='./dist' --exclude='*/dist' --exclude='./dist-test' --exclude='*/dist-test' --exclude='./.venv' --exclude='./.venv-wsl' --exclude='./.local' --exclude='./.tmp' --exclude='./work' --exclude='./outputs' -cf $archive .
    if ($LASTEXITCODE -ne 0) { throw 'Failed to stage the local worker build context.' }
    & tar -xf $archive -C $context
    if ($LASTEXITCODE -ne 0) { throw 'Failed to unpack the local worker build context.' }
    Remove-Item $archive -Force
    # Docker Hub CDN can be unreachable locally; use a reachable mirror unless overridden.
    $nodeImage = if ($env:BB_NODE_IMAGE) { $env:BB_NODE_IMAGE } else { 'docker.m.daocloud.io/library/node:22-bookworm-slim' }
    & docker build -q -f (Join-Path $context 'deploy/m1/Dockerfile') --target worker --build-arg BB_RELEASE_SHA=local-dev --build-arg NODE_IMAGE=$nodeImage -t $workerImage $context
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the local worker image.' }
  }
  finally {
    Remove-Item -Recurse -Force $context -ErrorAction SilentlyContinue
  }
}

# Set $env:DEEPSEEK_API_KEY in the terminal before running this script.
$env:DATABASE_URL = "postgresql://bondbuddy_local@127.0.0.1:55433/bondbuddy_local"
$env:AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true"
$env:BB_TERMS_VERSION = "synthetic-web-test-v1"
$env:BB_RUN_RUNTIME_ENABLED = '1'
$env:BB_READY_WORKER_GROUPS = 'authoring,review,parse'
$env:PORT = "3100"
$apiUrl = "http://127.0.0.1:$env:PORT"
$env:BB_API_PROXY_TARGET = $apiUrl
$scheme = if ($env:BB_WEB_TLS_CERT -and $env:BB_WEB_TLS_KEY) { 'https' } else { 'http' }
$env:BB_ALLOWED_ORIGIN = "${scheme}://127.0.0.1:5173"

if (-not $env:DEEPSEEK_API_KEY -and $env:BB_CODEX_AUTH_MODE -ne 'copilot_enterprise') {
  Write-Warning 'DEEPSEEK_API_KEY 未设置；编制任务会在模型调用阶段失败。请在启动本脚本的终端设置后重启。'
}

# Host Python is still used by the API's template helpers. Running workers live in the Linux image.
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw 'Python is required for the local API template helpers.' }
$venv = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venv 'Scripts/python.exe'
if (-not (Test-Path $venvPython)) { & $python -m venv $venv }
& $venvPython -c 'import lxml, docx, pdfplumber, openpyxl, pypdf, pypdfium2, PIL, numpy' 2>$null
if ($LASTEXITCODE -ne 0) {
  & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'python/requirements.txt')
}
$env:BB_PYTHON = $venvPython

Write-Host 'Building the Linux worker image (production Codex sandbox)...'
Build-LocalWorkerImage

# Infrastructure first: migrations must finish before workers claim jobs.
Invoke-LocalCompose -Files $baseFiles -ComposeArguments @('up', '-d', '--wait')
npm run migrate:api
if ($LASTEXITCODE -ne 0) { throw "npm run migrate:api failed with exit code $LASTEXITCODE" }

# Workers share the base compose network and reach postgres/azurite by service name.
Invoke-LocalCompose -Files $allFiles -ComposeArguments @('up', '-d', '--wait')
foreach ($service in $workerServices) {
  $name = "bondbuddy_m1_local-$service-1"
  $running = (& docker inspect -f '{{.State.Running}}' $name 2>$null | Out-String).Trim()
  if ($running -ne 'true') {
    & docker logs --tail 80 $name 2>$null
    throw "$service worker container did not stay running."
  }
}
Write-Host "Worker containers started: $($workerServices -join ', ')"

$api = Start-Process -FilePath 'node' -ArgumentList @('apps/api/dist/server.js') -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
# Upload completion is durable: the API enqueues confirmation and returns 202.
# A consumer must drain that outbox, otherwise the browser polls forever.
$confirmation = Start-Process -FilePath 'node' -ArgumentList @('scripts/local-upload-confirmation.mjs') -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
# Ops scheduler does not need the Codex sandbox, so it stays on the host.
$env:BB_OPS_PROVIDER_BALANCE = 'off'
$env:BB_LOG_SINK_FILE = ''
$env:BB_LOG_ARCHIVE_ENABLED = '0'
$env:BB_OPS_LIBRARY_SYNC = 'off'
$env:BB_OPS_PARSE_BACKFILL = 'off'
$env:BB_OPS_STORAGE_INVENTORY = 'off'
$ops = Start-Process -FilePath 'node' -ArgumentList @('apps/worker/dist/ops-scheduler.js') -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-WebRequest -Uri "$apiUrl/health" -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      # The API may still be starting.
    }
  }
  if (-not $ready) { throw "API did not become ready at $apiUrl/health" }

  try {
    Invoke-WebRequest -Uri "$apiUrl/api/v1/ready" -UseBasicParsing -TimeoutSec 2 | Out-Null
    Write-Host 'Worker heartbeat readiness: ready'
  } catch {
    Write-Warning "Worker heartbeat readiness is not ready yet; inspect $apiUrl/api/v1/ready and the worker container logs."
  }

  Write-Host "API ready at $apiUrl; web at $($env:BB_ALLOWED_ORIGIN)"
  npm run dev:web
}
finally {
  foreach ($process in @($api, $confirmation, $ops)) {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  try {
    Invoke-LocalCompose -Files $allFiles -ComposeArguments (@('stop') + $workerServices)
  } catch {
    # Keep postgres/azurite running; only the workers must not outlive this session.
  }
}
