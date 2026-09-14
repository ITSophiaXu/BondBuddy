param([int]$Port = 8765, [switch]$Background, [switch]$OpenBrowser, [switch]$Restart, [string]$RestartLogPath)
$ErrorActionPreference = 'Stop'
$taskRestartLog = if ($RestartLogPath) { $RestartLogPath } else { Join-Path $PSScriptRoot '.local/restart.log' }
function Write-RestartLog([string]$Message) {
    if ($Restart) {
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $taskRestartLog)) | Out-Null
        [System.IO.File]::AppendAllText($taskRestartLog, "$(Get-Date -Format o) $Message`r`n")
    }
}
trap {
    Write-RestartLog ('ERROR: ' + $_.Exception.Message)
    throw $_
}
Write-RestartLog "Restart requested for port $Port."
$taskPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    $taskPython = (Get-Command python -ErrorAction Stop).Source
}
$taskPython = [System.IO.Path]::GetFullPath($taskPython)
$taskUrl = "http://127.0.0.1:$Port"
if ($Background) {
    $taskExisting = $null
    try { $taskExisting = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 2 } catch {}
    if ($taskExisting -and $taskExisting.app -eq 'bond-draft-cowork') {
        if (-not $Restart) {
            if ($OpenBrowser) { Start-Process $taskUrl }
            Write-Output "BondDraft Cowork is already running: $taskUrl"
            return
        }
        # A user-requested restart must never interrupt a financial update.
        Write-RestartLog 'Checking saved projects for active tasks.'
        $taskProjects = Invoke-RestMethod -Uri "$taskUrl/api/projects" -TimeoutSec 15
        foreach ($taskProject in $taskProjects) {
            $taskState = Invoke-RestMethod -Uri "$taskUrl/api/projects/$($taskProject.id)" -TimeoutSec 30
            if ($taskState.job.status -in @('queued', 'running')) {
                throw 'An update is still running. Wait for it to finish, then restart the workbench.'
            }
        }
        if ($taskExisting.features.standalone_conversations) {
            $taskConversations = Invoke-RestMethod -Uri "$taskUrl/api/conversations" -TimeoutSec 15
            if (@($taskConversations | Where-Object { $_.job.status -in @('queued', 'running') }).Count -gt 0) {
                throw 'A Cowork reply is still running. Wait for it to finish or stop it before restarting.'
            }
        }
        $taskOwners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($taskOwners.Count -ne 1) { throw 'Cannot identify the workbench process safely.' }
        $taskProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskOwners[0])"
        $taskPortPattern = '--port\s+' + [regex]::Escape([string]$Port) + '(?:\s|$)'
        $taskActualPython = if ($taskProcessInfo.ExecutablePath) { [System.IO.Path]::GetFullPath($taskProcessInfo.ExecutablePath) } else { '' }
        if (-not $taskProcessInfo -or $taskActualPython -ne $taskPython -or
            $taskProcessInfo.CommandLine -notmatch '(?:^|\s)-m\s+backend\.server(?:\s|$)' -or
            $taskProcessInfo.CommandLine -notmatch $taskPortPattern) {
            throw 'The port belongs to an unrecognized process; it has not been stopped.'
        }
        Write-RestartLog "Stopping the verified workbench process $($taskOwners[0])."
        Stop-Process -Id $taskOwners[0] -ErrorAction Stop
        Wait-Process -Id $taskOwners[0] -Timeout 10 -ErrorAction SilentlyContinue
    }
    $taskLogDirectory = Join-Path $PSScriptRoot '.local'
    New-Item -ItemType Directory -Force -Path $taskLogDirectory | Out-Null
    $taskOutLog = Join-Path $taskLogDirectory "server-$Port.out.log"
    $taskErrorLog = Join-Path $taskLogDirectory "server-$Port.err.log"
    $taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-X','utf8','-m','backend.server','--port',"$Port") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $taskOutLog -RedirectStandardError $taskErrorLog -PassThru
    for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
        Start-Sleep -Milliseconds 250
        $taskProcess.Refresh()
        if ($taskProcess.HasExited) {
            throw "Cowork could not start. See $taskErrorLog"
        }
        try { $taskStarted = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 1 } catch { continue }
        if ($taskStarted.app -eq 'bond-draft-cowork') {
            if ($Restart -and $taskExisting.instance_id -and $taskStarted.instance_id -eq $taskExisting.instance_id) {
                throw 'The old workbench is still responding; restart has not completed.'
            }
            Write-RestartLog "Workbench started. Version: $($taskStarted.version); instance: $($taskStarted.instance_id)."
            if ($OpenBrowser) { Start-Process $taskUrl }
            Write-Output "BondDraft Cowork started: $taskUrl"
            return
        }
    }
    throw "Startup did not finish within 10 seconds. See $taskErrorLog"
}
Push-Location $PSScriptRoot
try {
    & $taskPython -X utf8 -m backend.server --port $Port
}
finally {
    Pop-Location
}
