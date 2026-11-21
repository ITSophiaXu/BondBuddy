param(
    [string]$Distribution = 'AlmaLinux-10',
    [string]$BaseImage,
    [string]$Image = 'bondbuddy-worker-barrier:test',
    [string[]]$Group,
    [ValidateRange(1, 10)][int]$Repeat = 1,
    [switch]$SkipBuild,
    [switch]$NoSystemd,
    [string]$NpmRegistry = 'https://registry.npmjs.org'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Invoke-Wsl {
    & wsl.exe -d $Distribution -u root --exec @args
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $LASTEXITCODE" }
}
$linux = (Invoke-Wsl wslpath -u $repo | Out-String).Trim()
$head = (& git -C $repo rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the worktree Git HEAD.' }
if (-not $SkipBuild) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules\typescript'))) {
        Push-Location $repo
        try {
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        } finally { Pop-Location }
    }
    Push-Location $repo
    try {
        foreach ($workspace in @('contracts', 'domain', 'rule-pack-registry', 'rule-applicability-context', 'api', 'worker')) {
            & npm.cmd run build -w "@bondbuddy/$workspace" -- --declaration
            if ($LASTEXITCODE -ne 0) { throw "Build failed: $workspace" }
        }
    } finally { Pop-Location }
    if ($BaseImage) {
        Invoke-Wsl docker image inspect $BaseImage --format '{{.Id}}'
        Invoke-Wsl docker build --network none --pull=false --build-arg "BASE_IMAGE=$BaseImage" `
            -f "$linux/deploy/tencent-elasticity/task-cgroup-test.Dockerfile" -t $Image $linux
    } else {
        Invoke-Wsl docker build --build-arg "NPM_REGISTRY=$NpmRegistry" `
            -f "$linux/tests/worker-barrier/Dockerfile" -t $Image $linux
    }
}
Invoke-Wsl docker image inspect postgres:16 --format '{{.Id}}'
$arguments = @('python3', '-B', "$linux/tests/worker-barrier/run.py", '--image', $Image, '--repeat', [string]$Repeat, '--head', $head)
foreach ($id in $Group) { $arguments += @('--group', $id) }
if ($NoSystemd) { $arguments += '--no-systemd' }
Invoke-Wsl @arguments
