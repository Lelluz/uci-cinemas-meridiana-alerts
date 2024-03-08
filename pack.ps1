$sourcePath = $PSScriptRoot
$zipFilePath = Join-Path $PSScriptRoot "package.zip"
$sources = @("index.mjs", "package.json", "package-lock.json", "node_modules")
$sources = $sources | ForEach-Object { Join-Path $sourcePath $_ }

Compress-Archive -Path $sources -DestinationPath $zipFilePath -Update -CompressionLevel Fastest