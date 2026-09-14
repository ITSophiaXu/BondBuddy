[CmdletBinding()]
param(
    [string]$Subscription,
    [string]$Location = 'eastasia',
    [string]$ResourceGroup = 'rg-bonddraftai',
    [string]$EnvironmentName = 'cae-bonddraftai',
    [string]$AppName = 'bond-draft-ai',
    [string]$AuthUsername = 'bondadmin',
    [string]$AuthPassword = $env:BOND_DEPLOY_PASSWORD,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $result = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed: az $($Arguments -join ' ')"
    }
    return $result
}

function Test-AzResource {
    param([string[]]$Arguments)
    & az @Arguments *> $null
    return $LASTEXITCODE -eq 0
}

if ($AppName -notmatch '^[a-z][a-z0-9-]{0,30}[a-z0-9]$') {
    throw 'AppName 必须为 2-32 位小写字母、数字或连字符，并以字母开头。'
}
if (-not $AuthUsername.Trim()) {
    throw 'AuthUsername 不能为空。'
}
if (-not $AuthPassword) {
    $securePassword = Read-Host '请输入公网共享密码（至少 16 位）' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $AuthPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
if ($AuthPassword.Length -lt 16) {
    throw '公网共享密码至少需要 16 位。'
}

Invoke-Az account show --output none | Out-Null
if ($Subscription) {
    Invoke-Az account set --subscription $Subscription | Out-Null
}
$subscriptionId = (Invoke-Az account show --query id --output tsv).Trim()

$hashInput = "$subscriptionId|$ResourceGroup|$AppName"
$hashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($hashInput))
$suffix = ([Convert]::ToHexString($hashBytes)).Substring(0, 10).ToLowerInvariant()
$acrName = "bondacr$suffix"
$storageAccount = "bondst$suffix"
$identityName = "id-$AppName"
$shareName = 'bonddraftdata'
$storageLinkName = 'bonddata'
$imageRepository = 'bonddraftai'
$imageTag = Get-Date -Format 'yyyyMMddHHmmss'
$image = "$acrName.azurecr.io/$imageRepository`:$imageTag"

Invoke-Az extension add --name containerapp --upgrade --only-show-errors --output none | Out-Null
Invoke-Az provider register --namespace Microsoft.App --wait --output none | Out-Null
Invoke-Az provider register --namespace Microsoft.OperationalInsights --wait --output none | Out-Null
Invoke-Az provider register --namespace Microsoft.ContainerRegistry --wait --output none | Out-Null
Invoke-Az provider register --namespace Microsoft.Storage --wait --output none | Out-Null
Invoke-Az provider register --namespace Microsoft.ManagedIdentity --wait --output none | Out-Null

Invoke-Az group create --name $ResourceGroup --location $Location --output none | Out-Null

if (-not (Test-AzResource @('acr', 'show', '--name', $acrName, '--resource-group', $ResourceGroup))) {
    Invoke-Az acr create --name $acrName --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled false --output none | Out-Null
}
if (-not (Test-AzResource @('containerapp', 'env', 'show', '--name', $EnvironmentName, '--resource-group', $ResourceGroup))) {
    Invoke-Az containerapp env create --name $EnvironmentName --resource-group $ResourceGroup --location $Location --output none | Out-Null
}
if (-not (Test-AzResource @('storage', 'account', 'show', '--name', $storageAccount, '--resource-group', $ResourceGroup))) {
    Invoke-Az storage account create `
        --name $storageAccount `
        --resource-group $ResourceGroup `
        --location $Location `
        --kind StorageV2 `
        --sku Standard_LRS `
        --min-tls-version TLS1_2 `
        --allow-blob-public-access false `
        --output none | Out-Null
}
if (-not (Test-AzResource @('identity', 'show', '--name', $identityName, '--resource-group', $ResourceGroup))) {
    Invoke-Az identity create --name $identityName --resource-group $ResourceGroup --location $Location --output none | Out-Null
}

Invoke-Az storage share-rm create `
    --name $shareName `
    --storage-account $storageAccount `
    --resource-group $ResourceGroup `
    --quota 100 `
    --enabled-protocols SMB `
    --output none | Out-Null

$storageKey = (Invoke-Az storage account keys list --name $storageAccount --resource-group $ResourceGroup --query '[0].value' --output tsv).Trim()
Invoke-Az containerapp env storage set `
    --name $EnvironmentName `
    --resource-group $ResourceGroup `
    --storage-name $storageLinkName `
    --azure-file-account-name $storageAccount `
    --azure-file-account-key $storageKey `
    --azure-file-share-name $shareName `
    --access-mode ReadWrite `
    --output none | Out-Null

$acrId = (Invoke-Az acr show --name $acrName --resource-group $ResourceGroup --query id --output tsv).Trim()
$identity = Invoke-Az identity show --name $identityName --resource-group $ResourceGroup --output json | ConvertFrom-Json
$roleCount = [int](Invoke-Az role assignment list `
    --assignee-object-id $identity.principalId `
    --scope $acrId `
    --role AcrPull `
    --query 'length(@)' `
    --output tsv)
if ($roleCount -eq 0) {
    Invoke-Az role assignment create `
        --assignee-object-id $identity.principalId `
        --assignee-principal-type ServicePrincipal `
        --scope $acrId `
        --role AcrPull `
        --output none | Out-Null
}

if (-not $SkipBuild) {
    Push-Location $projectRoot
    try {
        Invoke-Az acr build --registry $acrName --image "$imageRepository`:$imageTag" --file Dockerfile . | Out-Host
    }
    finally {
        Pop-Location
    }
}

$environment = Invoke-Az containerapp env show --name $EnvironmentName --resource-group $ResourceGroup --output json | ConvertFrom-Json
$fqdn = "$AppName.$($environment.properties.defaultDomain)"
$configPath = Join-Path ([System.IO.Path]::GetTempPath()) "bonddraft-$([guid]::NewGuid().ToString('N')).json"

$configuration = [ordered]@{
    location = $Location
    name = $AppName
    type = 'Microsoft.App/containerApps'
    identity = @{
        type = 'UserAssigned'
        userAssignedIdentities = @{
            $identity.id = @{}
        }
    }
    properties = @{
        managedEnvironmentId = $environment.id
        configuration = @{
            activeRevisionsMode = 'Single'
            ingress = @{
                external = $true
                allowInsecure = $false
                targetPort = 8000
                transport = 'auto'
            }
            registries = @(
                @{
                    server = "$acrName.azurecr.io"
                    identity = $identity.id
                }
            )
            secrets = @(
                @{
                    name = 'bond-auth-password'
                    value = $AuthPassword
                }
            )
        }
        template = @{
            containers = @(
                @{
                    name = 'bonddraftai'
                    image = $image
                    env = @(
                        @{ name = 'BOND_AUTH_USERNAME'; value = $AuthUsername }
                        @{ name = 'BOND_AUTH_PASSWORD'; secretRef = 'bond-auth-password' }
                        @{ name = 'BOND_ALLOWED_HOSTS'; value = $fqdn }
                        @{ name = 'BOND_TRUST_PROXY'; value = '1' }
                        @{ name = 'BOND_DATA_DIR'; value = '/data/projects' }
                        @{ name = 'BOND_CODEX_HOME'; value = '/data/codex' }
                        @{ name = 'CODEX_HOME'; value = '/data/codex' }
                        @{ name = 'BOND_CODEX_PATH'; value = '/usr/local/bin/codex' }
                        @{ name = 'BOND_CODEX_LINUX_SANDBOX'; value = 'legacy_landlock' }
                        @{ name = 'BOND_SHARED_WORKSPACE'; value = '1' }
                        @{ name = 'BOND_STANDALONE_CONVERSATIONS'; value = '0' }
                        @{ name = 'BOND_OCR'; value = 'off' }
                        @{ name = 'BOND_DEMO'; value = '0' }
                        @{ name = 'PORT'; value = '8000' }
                    )
                    resources = @{
                        cpu = 2.0
                        memory = '4Gi'
                    }
                    volumeMounts = @(
                        @{
                            volumeName = 'bond-data'
                            mountPath = '/data'
                        }
                    )
                }
            )
            scale = @{
                minReplicas = 1
                maxReplicas = 1
            }
            volumes = @(
                @{
                    name = 'bond-data'
                    storageName = $storageLinkName
                    storageType = 'AzureFile'
                }
            )
        }
    }
}

try {
    $configuration | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
    if (Test-AzResource @('containerapp', 'show', '--name', $AppName, '--resource-group', $ResourceGroup)) {
        Invoke-Az containerapp update --name $AppName --resource-group $ResourceGroup --yaml $configPath --output none | Out-Null
    }
    else {
        $deployed = $false
        for ($attempt = 1; $attempt -le 6 -and -not $deployed; $attempt++) {
            & az containerapp create `
                --name $AppName `
                --resource-group $ResourceGroup `
                --environment $EnvironmentName `
                --yaml $configPath `
                --output none
            if ($LASTEXITCODE -eq 0) {
                $deployed = $true
                break
            }
            if ($attempt -lt 6) {
                Start-Sleep -Seconds (10 * $attempt)
            }
        }
        if (-not $deployed) {
            throw 'Container App 创建失败。'
        }
    }
}
finally {
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    $AuthPassword = $null
    $storageKey = $null
}

$result = [ordered]@{
    url = "https://$fqdn"
    username = $AuthUsername
    resource_group = $ResourceGroup
    container_app = $AppName
    registry = $acrName
    storage_account = $storageAccount
    codex_login_command = "az containerapp exec --name $AppName --resource-group $ResourceGroup --command `"codex login --device-auth`""
}
$result | ConvertTo-Json
