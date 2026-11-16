# Holt eine portable Node.js-Fassung (aktuelle 24er LTS) nach app\runtime\node, ohne Admin-Rechte und ohne das System zu aendern.
param([Parameter(Mandatory = $true)][string]$AppDir)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dest = Join-Path $AppDir 'runtime\node'
if (Test-Path (Join-Path $dest 'node.exe')) { exit 0 }

# Erst in eine Variable: PowerShell 5.1 reicht ein JSON-Array sonst als ein einziges Objekt durch die Pipeline.
$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$release = $index | Where-Object { $_.version -like 'v24.*' -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
if (-not $release) { throw 'No Node.js 24 download found on nodejs.org' }
$v = $release.version
$zip = Join-Path $env:TEMP "node-$v-win-x64.zip"
Write-Host "Downloading Node.js $v (about 35 MB) ..."
Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip -UseBasicParsing

$tmp = Join-Path $AppDir 'runtime\node-tmp'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp
Move-Item (Join-Path $tmp "node-$v-win-x64") $dest
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force
Write-Host "Node.js $v is ready in $dest"
