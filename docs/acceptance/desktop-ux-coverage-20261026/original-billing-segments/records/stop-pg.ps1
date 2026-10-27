$ErrorActionPreference='Stop'
$taskSegmentsOut=Join-Path (Get-Location) '.local/billing-segments-20261027'
$taskSegmentsObserved=Get-Content -LiteralPath (Join-Path $taskSegmentsOut 'pg-start.json') -Raw | ConvertFrom-Json
$taskSegmentsAudit=Get-Content -LiteralPath (Join-Path $taskSegmentsOut 'db-final.json') -Raw | ConvertFrom-Json
if (-not $taskSegmentsAudit.success -or @($taskSegmentsAudit.clientsAfter).Count -ne 0) { throw 'Final client audit not clean' }
$taskSegmentsData='C:/Users/lezhai/Downloads/Bondbuddy/ux-coverage-20261026/.local/test-successor-postgres/data'
$taskSegmentsProc=Get-CimInstance Win32_Process -Filter 'ProcessId=31152'
$taskSegmentsListeners=@(Get-NetTCPConnection -LocalPort 15542 -State Listen)
if (-not $taskSegmentsProc -or $taskSegmentsProc.Name -ne 'postgres.exe' -or
    -not $taskSegmentsProc.CommandLine.Replace('\','/').Contains($taskSegmentsData) -or
    ([datetime]$taskSegmentsProc.CreationDate) -ne ([datetime]$taskSegmentsObserved.postmaster.CreationDate) -or
    $taskSegmentsListeners.Count -ne 1 -or $taskSegmentsListeners[0].OwningProcess -ne 31152) { throw 'Exact cluster identity changed; preserve service' }
$taskSegmentsBefore=$taskSegmentsProc | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
$taskSegmentsStarted=(Get-Date).ToUniversalTime().ToString('o')
& 'C:/Users/lezhai/Downloads/Bondbuddy/.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe' -D $taskSegmentsData -m fast -w stop 1> (Join-Path $taskSegmentsOut 'pg-stop.stdout.log') 2> (Join-Path $taskSegmentsOut 'pg-stop.stderr.log')
$taskSegmentsExit=$LASTEXITCODE
$taskSegmentsRemaining=Get-CimInstance Win32_Process -Filter 'ProcessId=31152'
$taskSegmentsPort=@(Get-NetTCPConnection -LocalPort 15542 -State Listen -ErrorAction SilentlyContinue)
$taskSegmentsRecord=[ordered]@{startedAt=$taskSegmentsStarted;completedAt=(Get-Date).ToUniversalTime().ToString('o');before=$taskSegmentsBefore;data=$taskSegmentsData;port=15542;exitCode=$taskSegmentsExit;processGone=(-not $taskSegmentsRemaining);listenersAfter=$taskSegmentsPort.Count;success=($taskSegmentsExit -eq 0 -and -not $taskSegmentsRemaining -and $taskSegmentsPort.Count -eq 0)}
$taskSegmentsRecord | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskSegmentsOut 'pg-stop.json') -Encoding utf8
$taskSegmentsRecord | ConvertTo-Json -Depth 5
if (-not $taskSegmentsRecord.success) { throw 'Graceful stop verification failed' }

