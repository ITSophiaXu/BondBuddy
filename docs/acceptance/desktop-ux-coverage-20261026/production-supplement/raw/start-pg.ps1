$ErrorActionPreference='Stop'
$taskSegmentsOut=Join-Path (Get-Location) '.local/production-supplement-20261027'
$taskSegmentsData='C:/Users/lezhai/Downloads/Bondbuddy/ux-coverage-20261026/.local/test-successor-postgres/data'
$taskSegmentsBin='C:/Users/lezhai/Downloads/Bondbuddy/.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin'
if (@(Get-NetTCPConnection -LocalPort 15542 -State Listen -ErrorAction SilentlyContinue).Count) { throw 'Existing listener; preserve it' }
& (Join-Path $taskSegmentsBin 'pg_ctl.exe') -D $taskSegmentsData status 1> (Join-Path $taskSegmentsOut 'previous-status.stdout.log') 2> (Join-Path $taskSegmentsOut 'previous-status.stderr.log')
if ($LASTEXITCODE -ne 3) { throw 'Cluster is not confirmed stopped; preserve it' }
$taskSegmentsStart=(Get-Date).ToUniversalTime().ToString('o')
$taskSegmentsLog=Join-Path $taskSegmentsOut 'postgres.log'
$taskSegmentsArgs=@('-D',$taskSegmentsData,'-l',$taskSegmentsLog,'-o','"-h 127.0.0.1 -p 15542"','-w','start')
$taskSegmentsCtl=Start-Process -FilePath (Join-Path $taskSegmentsBin 'pg_ctl.exe') -ArgumentList $taskSegmentsArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskSegmentsOut 'start.stdout.log') -RedirectStandardError (Join-Path $taskSegmentsOut 'start.stderr.log')
$taskSegmentsCtlEnded=$taskSegmentsCtl.WaitForExit(15000)
$taskSegmentsListener=Get-NetTCPConnection -LocalPort 15542 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$taskSegmentsProcess=if($taskSegmentsListener){Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSegmentsListener.OwningProcess)"}
$taskSegmentsSuccess=$taskSegmentsProcess -and $taskSegmentsProcess.Name -eq 'postgres.exe' -and $taskSegmentsProcess.CommandLine.Replace('\','/').Contains($taskSegmentsData)
[ordered]@{startedAt=$taskSegmentsStart;observedAt=(Get-Date).ToUniversalTime().ToString('o');controllerPid=$taskSegmentsCtl.Id;controllerEnded=$taskSegmentsCtlEnded;controllerExit=if($taskSegmentsCtlEnded){$taskSegmentsCtl.ExitCode}else{$null};postmaster=$taskSegmentsProcess|Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine;dataDirectory=$taskSegmentsData;port=15542;success=[bool]$taskSegmentsSuccess} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskSegmentsOut 'pg-start.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $taskSegmentsOut 'pg-start.json')
if (-not $taskSegmentsSuccess) { throw 'Server identity not confirmed; inspect without restarting' }
