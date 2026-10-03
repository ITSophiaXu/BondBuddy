param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$root=[IO.Path]::GetFullPath($FixtureRoot)
$word=$null;$doc=$null
try {
    $word=New-Object -ComObject Word.Application
    $word.Visible=$false;$word.DisplayAlerts=0;$word.AutomationSecurity=3
    foreach($name in @('native-comments','existing-comments','tracked-revision')){
        $documentPath=Join-Path $root ('word-roundtrip\'+$name+'.docx')
        $output=Join-Path $root ('word-roundtrip\'+$name+'-markup.pdf')
        $doc=$word.Documents.OpenNoRepairDialog($documentPath,$false,$true,$false,'','',$false,'','',0,65001,$false,$false,0,$true,'')
        $doc.PrintRevisions=$true
        $doc.ShowRevisions=$true
        $doc.ActiveWindow.View.ShowRevisionsAndComments=$true
        $doc.ExportAsFixedFormat($output,17,$false,0,0,1,1,7)
        $doc.Close(0)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc);$doc=$null
        [pscustomobject]@{name=$name;markup_exported=(Test-Path -LiteralPath $output)}|ConvertTo-Json -Compress
    }
}finally{
    if($null -ne $doc){$doc.Close(0);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc)}
    if($null -ne $word){$word.Quit(0);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)}
    [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
