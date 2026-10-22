param([Parameter(Mandatory=$true)][string]$InputFile, [Parameter(Mandatory=$true)][string]$OutputFile)
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$document = $null
$word = $null
try {
    $source = (Resolve-Path -LiteralPath $InputFile).Path
    $destination = [IO.Path]::GetFullPath($OutputFile)
    $word = New-Object -ComObject Word.Application
    if ($word.Documents.Count -ne 0) { throw '检测到已有文档，停止自动排版验收以保护当前 Word 会话。' }
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($source, $false, $true)
    $document.ExportAsFixedFormat($destination, 17)
    [PSCustomObject]@{ Source=$source; Pdf=$destination; Pages=$document.ComputeStatistics(2); Engine='Microsoft Word' } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($null -ne $word -and $word.Documents.Count -eq 0) { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
}
