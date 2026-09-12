# Verify restart boundaries with test doubles; never start or stop a real process.
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskFixtureLog = Join-Path ([System.IO.Path]::GetTempPath()) ('bond-launcher-test-' + [guid]::NewGuid().ToString() + '.log')
$global:taskPythonExpected = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$global:taskPythonExpected = [System.IO.Path]::GetFullPath($global:taskPythonExpected)
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    if ($Uri.EndsWith('/api/health')) { return @{app='bond-draft-cowork'} }
    if ($Uri.EndsWith('/api/projects')) { return @(@{id='fixture'}) }
    return @{job=@{status=$global:taskFixtureStatus}}
}
function Get-NetTCPConnection { param($LocalPort,$State,$ErrorAction) return @{OwningProcess=7654321} }
function Get-CimInstance {
    param($ClassName,$Filter)
    return @{ExecutablePath=$global:taskFixtureExecutable; CommandLine='python.exe -X utf8 -m backend.server --port 8766'}
}
function Stop-Process { param($Id,$ErrorAction) $global:taskStopped += @($Id) }
function Wait-Process { param($Id,$Timeout,$ErrorAction) }
function Start-Process {
    param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
    if ($WindowStyle -ne 'Hidden') { throw 'Background process must be hidden.' }
    $global:taskStarted++
    $taskFakeProcess = [pscustomobject]@{HasExited=$false}
    $taskFakeProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    return $taskFakeProcess
}
foreach ($taskCase in @('running','unknown','idle')) {
    $global:taskFixtureStatus = if ($taskCase -eq 'running') {'running'} else {'completed'}
    $global:taskFixtureExecutable = if ($taskCase -eq 'unknown') {'C:\unrelated\python.exe'} else {$global:taskPythonExpected}
    $global:taskStopped = @()
    $global:taskStarted = 0
    $taskFailure = $null
    try { & (Join-Path $taskRoot 'start.ps1') -Port 8766 -Background -Restart -RestartLogPath $taskFixtureLog | Out-Null }
    catch { $taskFailure = $_.Exception.Message }
    if ($taskCase -eq 'idle') {
        if ($taskFailure -or $global:taskStopped.Count -ne 1 -or $global:taskStopped[0] -ne 7654321 -or $global:taskStarted -ne 1) {
            throw "Idle restart test failed: $taskFailure"
        }
    } elseif (-not $taskFailure -or $global:taskStopped.Count -or $global:taskStarted) {
        throw "Unsafe restart in case $taskCase"
    }
}
Write-Output 'Restart safety checks: 3 passed; no real processes were controlled.'
