$ErrorActionPreference='Stop'
$taskB1Out=Join-Path (Get-Location) '.local/supplement-b1-20261027'
$taskB1Observed=Get-Content -LiteralPath (Join-Path $taskB1Out 'pg-start-observed.json') -Raw | ConvertFrom-Json
$taskB1Audit=Get-Content -LiteralPath (Join-Path $taskB1Out 'db-final.json') -Raw | ConvertFrom-Json
if (-not $taskB1Audit.success -or @($taskB1Audit.clientsAfter).Count -ne 0) { throw 'Final client audit not clean' }
$taskB1Data='C:/Users/lezhai/Downloads/Bondbuddy/ux-coverage-20261026/.local/test-successor-postgres/data'
$taskB1Proc=Get-CimInstance Win32_Process -Filter 'ProcessId=15704'
$taskB1Listeners=@(Get-NetTCPConnection -LocalPort 15542 -State Listen)
if (-not $taskB1Proc -or $taskB1Proc.Name -ne 'postgres.exe' -or
    -not $taskB1Proc.CommandLine.Replace('\','/').Contains($taskB1Data) -or
    ([datetime]$taskB1Proc.CreationDate) -ne ([datetime]$taskB1Observed.postmaster.CreationDate) -or
    $taskB1Listeners.Count -ne 1 -or $taskB1Listeners[0].OwningProcess -ne 15704) { throw 'Exact cluster identity changed; preserve service' }
$taskB1Before=$taskB1Proc | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
$taskB1Started=(Get-Date).ToUniversalTime().ToString('o')
& 'C:/Users/lezhai/Downloads/Bondbuddy/.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe' -D $taskB1Data -m fast -w stop 1> (Join-Path $taskB1Out 'pg-stop.stdout.log') 2> (Join-Path $taskB1Out 'pg-stop.stderr.log')
$taskB1Exit=$LASTEXITCODE
$taskB1Remaining=Get-CimInstance Win32_Process -Filter 'ProcessId=15704'
$taskB1Port=@(Get-NetTCPConnection -LocalPort 15542 -State Listen -ErrorAction SilentlyContinue)
$taskB1Record=[ordered]@{startedAt=$taskB1Started;completedAt=(Get-Date).ToUniversalTime().ToString('o');before=$taskB1Before;data=$taskB1Data;port=15542;exitCode=$taskB1Exit;processGone=(-not $taskB1Remaining);listenersAfter=$taskB1Port.Count;success=($taskB1Exit -eq 0 -and -not $taskB1Remaining -and $taskB1Port.Count -eq 0)}
$taskB1Record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskB1Out 'pg-stop.json') -Encoding utf8
$taskB1Record | ConvertTo-Json -Depth 5
if (-not $taskB1Record.success) { throw 'Graceful stop verification failed' }
