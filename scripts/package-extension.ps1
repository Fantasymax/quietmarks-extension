param(
  [string]$Version = "",
  [string]$ChromePath = "",
  [switch]$Crx
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifestPath = Join-Path $projectRoot "manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $manifest.version
}

$dist = Join-Path $projectRoot "dist"
$stage = Join-Path $dist "quietmarks-extension"
$zipPath = Join-Path $dist "quietmarks-extension-v$Version.zip"
$crxPath = Join-Path $dist "quietmarks-extension-v$Version.crx"

if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null

$packageItems = @(
  "manifest.json",
  "README.md",
  "ARCHITECTURE.md",
  "src"
)

foreach ($item in $packageItems) {
  $source = Join-Path $projectRoot $item
  $target = Join-Path $stage $item
  if (Test-Path -LiteralPath $source -PathType Container) {
    Copy-Item -LiteralPath $source -Destination $target -Recurse
  } else {
    Copy-Item -LiteralPath $source -Destination $target
  }
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

$stageChildren = Join-Path $stage "*"
Compress-Archive -Path $stageChildren -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "ZIP: $zipPath"

if ($Crx) {
  if ([string]::IsNullOrWhiteSpace($ChromePath)) {
    $candidates = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    $ChromePath = ($candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
  }

  if ([string]::IsNullOrWhiteSpace($ChromePath) -or -not (Test-Path -LiteralPath $ChromePath)) {
    throw "Chrome/Edge executable not found. Re-run with -ChromePath 'C:\Path\to\chrome.exe' -Crx."
  }

  if (Test-Path -LiteralPath $crxPath) {
    Remove-Item -LiteralPath $crxPath -Force
  }

  & $ChromePath --pack-extension="$stage"
  $generatedCrx = "$stage.crx"
  if (Test-Path -LiteralPath $generatedCrx) {
    Move-Item -LiteralPath $generatedCrx -Destination $crxPath -Force
    Write-Host "CRX: $crxPath"
  } else {
    throw "Chrome pack-extension finished but did not create $generatedCrx."
  }
}
