$zipFile = "package.zip"
$includedItems = @("index.mjs", "package.json", "package-lock.json", "node_modules")

if (Test-Path $zipFile) {
    Remove-Item $zipFile
}

Write-Host "Comprimi i file in corso..."

Add-Type -Assembly "System.IO.Compression.FileSystem"
$zipFileOutput = [System.IO.Compression.ZipFile]::Open($zipFile, 'Create')

$includedItems | ForEach-Object {
    $itemPath = $_
    if (Test-Path $itemPath) {
        $relativePath = (Get-Item $itemPath).FullName.Replace((Get-Item $PWD).FullName + "\", "")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipFileOutput, $itemPath, $relativePath, 'Optimal')
    }
    else {
        Write-Host "Attenzione: Il file o la cartella '$itemPath' non esiste e sarà ignorato."
    }
}

$zipFileOutput.Dispose()

Write-Host "Compressione completata."