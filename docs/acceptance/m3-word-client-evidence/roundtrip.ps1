param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($FixtureRoot)
$manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
if (-not $manifest.synthetic) { throw 'Only explicitly synthetic fixture manifests may be opened.' }
$output = Join-Path $root 'word-roundtrip'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$beforeProcesses = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$missing = [Type]::Missing
$word = $null
$doc = $null
$rows = @()
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $version = $word.Version
    $build = $word.Build
    $instanceHwnd = $word.Hwnd
    foreach ($fixture in $manifest.fixtures) {
        $source = [IO.Path]::GetFullPath((Join-Path $root $fixture.name))
        if (-not $source.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture path outside test directory.' }
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fixture.sha256) { throw 'Synthetic fixture hash mismatch.' }
        $saved = Join-Path $output $fixture.name
        $pdf = [IO.Path]::ChangeExtension($saved, '.pdf')
        $row = [ordered]@{name=$fixture.name;opened=$false;saved=$false;reopened=$false;error=$null}
        try {
            $doc = $word.Documents.OpenNoRepairDialog($source,$false,$false,$false,'','',$false,'','',0,65001,$false,$false,0,$true,'')
            $row.opened=$true
            $row.before=[ordered]@{comments=$doc.Comments.Count;revisions=$doc.Revisions.Count;tables=$doc.Tables.Count;pages=$doc.ComputeStatistics(2)}
            $doc.SaveAs2($saved,12,$false,'',$false)
            $row.saved=$true
            $doc.Close(0)
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc); $doc=$null
            $doc = $word.Documents.OpenNoRepairDialog($saved,$false,$true,$false,'','',$false,'','',0,65001,$false,$false,0,$true,'')
            $row.reopened=$true
            $row.after=[ordered]@{comments=$doc.Comments.Count;revisions=$doc.Revisions.Count;tables=$doc.Tables.Count;pages=$doc.ComputeStatistics(2)}
            $doc.ExportAsFixedFormat($pdf,17,$false)
            $row.pdf_exported=Test-Path -LiteralPath $pdf
        } catch { $row.error=$_.Exception.Message }
        finally { if($null -ne $doc){$doc.Close(0);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc);$doc=$null} }
        $rows += [pscustomobject]$row
        [pscustomobject]$row | ConvertTo-Json -Depth 5 -Compress
    }
} finally {
    if($null -ne $doc){$doc.Close(0);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc)}
    if($null -ne $word){$word.Quit(0);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)}
    [GC]::Collect();[GC]::WaitForPendingFinalizers()
    $result = [ordered]@{synthetic=$true;word_version=$version;word_build=$build;instance_hwnd=$instanceHwnd;existing_word_pids=$beforeProcesses;cases=$rows;at_utc=[DateTime]::UtcNow.ToString('o')}
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'word-com-results.json') -Encoding utf8
}
