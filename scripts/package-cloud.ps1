$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release = [IO.Path]::GetFullPath((Join-Path $root 'release'))
$stage = [IO.Path]::GetFullPath((Join-Path $release 'cloud-deploy'))
if ([IO.Path]::GetDirectoryName($stage) -ne $release -or [IO.Path]::GetFileName($stage) -ne 'cloud-deploy') { throw '部署包临时目录超出预期范围' }
if (Test-Path -LiteralPath $stage) {
    if ((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '部署包临时目录不能是链接' }
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$files = @('package.json','package-lock.json','.dockerignore','frontend/package.json','backend/package.json','backend/cloud/Dockerfile','backend/cloud/compose.yaml','backend/cloud/.env.example','backend/cloud/server.mjs','backend/cloud/scheduler.mjs','backend/cloud/DEPLOY.md','backend/fixtures/evaluation.mjs')
$files += Get-ChildItem -LiteralPath (Join-Path $root 'backend/core') -File | ForEach-Object { 'backend/core/' + $_.Name }
foreach ($relative in $files) {
    $target = Join-Path $stage $relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root $relative) -Destination $target
}
Copy-Item -LiteralPath (Join-Path $root 'backend/cloud/DEPLOY.md') -Destination (Join-Path $stage 'README.md')
$zipPath = Join-Path $release '知隙云端服务-0.1.0.zip'
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
Write-Output ('云端部署包已生成：' + $zipPath)
