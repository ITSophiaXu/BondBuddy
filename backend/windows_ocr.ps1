param([Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$taskAsTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Wait-OcrOperation($Operation, [Type]$ResultType) {
    $taskOperation = $taskAsTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $taskOperation.Wait()
    return $taskOperation.Result
}
$taskLanguage = New-Object Windows.Globalization.Language('zh-Hans-CN')
$taskOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($taskLanguage)
if (-not $taskOcrEngine) { $taskOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $taskOcrEngine) { throw 'No available local OCR language.' }
$taskManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskOutput = @()
foreach ($taskItem in $taskManifest) {
    $taskFile = Wait-OcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($taskItem.path)) ([Windows.Storage.StorageFile])
    $taskStream = Wait-OcrOperation ($taskFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $taskDecoder = Wait-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($taskStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $taskBitmap = Wait-OcrOperation ($taskDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $taskResult = Wait-OcrOperation ($taskOcrEngine.RecognizeAsync($taskBitmap)) ([Windows.Media.Ocr.OcrResult])
            $taskLines = @()
            foreach ($taskLine in $taskResult.Lines) {
                $taskWords = @()
                foreach ($taskWord in $taskLine.Words) {
                    $taskWords += @{ text=$taskWord.Text; x=$taskWord.BoundingRect.X; y=$taskWord.BoundingRect.Y;
                                    width=$taskWord.BoundingRect.Width; height=$taskWord.BoundingRect.Height }
                }
                $taskLines += @{text=$taskLine.Text; words=$taskWords}
            }
            $taskOutput += @{page=[int]$taskItem.page; lines=$taskLines; language=$taskOcrEngine.RecognizerLanguage.LanguageTag;
                            width=$taskBitmap.PixelWidth; height=$taskBitmap.PixelHeight}
        } finally { if ($taskBitmap) { $taskBitmap.Dispose() } }
    } finally { $taskStream.Dispose() }
}
ConvertTo-Json -InputObject @($taskOutput) -Depth 9 -Compress
