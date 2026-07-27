[CmdletBinding()]
param(
    [switch]$SkipAppBuild,
    [switch]$SignUpdater,
    [string]$ReleaseBaseUrl
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
    }
}

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha256.ComputeHash($stream)
        return -join ($bytes | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Find-InnoCompiler {
    $candidates = @(
        @(
            $env:INNO_SETUP_COMPILER,
            "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
            "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
            "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    )

    if ($candidates.Count -eq 0) {
        throw "Inno Setup 6.7.3 was not found. Install it or set INNO_SETUP_COMPILER."
    }

    $compiler = $candidates[0]
    $version = (Get-Item -LiteralPath $compiler).VersionInfo.ProductVersion
    if ($version -eq "0.0.0.0") {
        $uninstaller = Join-Path (Split-Path -Parent $compiler) "unins000.exe"
        if (Test-Path -LiteralPath $uninstaller) {
            $version = (Get-Item -LiteralPath $uninstaller).VersionInfo.ProductVersion.Trim()
        }
    }
    if (-not $version.StartsWith("6.7.3", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Expected Inno Setup 6.7.3, found $version at $compiler"
    }
    return $compiler
}

function Get-ChineseMessagesFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CacheDirectory
    )

    $url = "https://raw.githubusercontent.com/jrsoftware/issrc/is-6_7_3/Files/Languages/Unofficial/ChineseSimplified.isl"
    $expectedHash = "7d544b9bb1d142cfa11f2e5d3cc8abe2e55f8e066c5124e3772675aa236e1278"
    $languageFile = Join-Path $CacheDirectory "ChineseSimplified.isl"
    New-Item -ItemType Directory -Path $CacheDirectory -Force | Out-Null

    if (Test-Path -LiteralPath $languageFile) {
        $existingHash = Get-Sha256 -Path $languageFile
        if ($existingHash -eq $expectedHash) {
            return $languageFile
        }
    }

    $downloadPath = "$languageFile.download"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $downloadPath
    $downloadHash = Get-Sha256 -Path $downloadPath
    if ($downloadHash -ne $expectedHash) {
        Remove-Item -LiteralPath $downloadPath -Force
        throw "Inno Setup Chinese translation hash mismatch. Expected $expectedHash, found $downloadHash."
    }
    Move-Item -LiteralPath $downloadPath -Destination $languageFile -Force
    return $languageFile
}

$package = Get-Content -Raw package.json | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw "Unsupported application version for Windows resources: $version"
}
$versionInfoVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"

Invoke-Checked npm run check:release

if (-not $SkipAppBuild) {
    $env:VPASTE_PUBLIC_UPDATE_FEED = "0"
    Invoke-Checked npx.cmd tauri build --no-bundle --config src-tauri/tauri.local.conf.json
}

$appBinary = Join-Path $repoRoot "src-tauri\target\release\vPaste.exe"
if (-not (Test-Path -LiteralPath $appBinary)) {
    throw "vPaste release binary was not found at $appBinary"
}

$bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle\windows"
$portableStage = Join-Path $bundleRoot "portable"
$portableZip = Join-Path $bundleRoot "vPaste_${version}_windows_x64_portable.zip"
$installer = Join-Path $bundleRoot "vPaste_${version}_windows_x64_setup.exe"
$installerSignature = "$installer.sig"
$windowsManifest = Join-Path $bundleRoot "latest.windows.json"
$installerLogo = Join-Path $repoRoot "src-tauri\icons\icon.png"
$innoDependencyRoot = Join-Path $bundleRoot "inno-dependencies"
$installerBackgroundLight = Join-Path $innoDependencyRoot "installer-background-light.png"
$installerBackgroundDark = Join-Path $innoDependencyRoot "installer-background-dark.png"
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path $innoDependencyRoot -Force | Out-Null
if (Test-Path -LiteralPath $portableStage) {
    Remove-Item -LiteralPath $portableStage -Recurse -Force
}
foreach ($staleFile in @($portableZip, $installer, $installerSignature, $windowsManifest, (Join-Path $bundleRoot "vpaste-installer-logo.bmp"))) {
    if (Test-Path -LiteralPath $staleFile) {
        Remove-Item -LiteralPath $staleFile -Force
    }
}
New-Item -ItemType Directory -Path $portableStage -Force | Out-Null
& (Join-Path $PSScriptRoot "generate-inno-assets.ps1") `
    -OutputDirectory $innoDependencyRoot `
    -Version $version

Copy-Item -LiteralPath $appBinary -Destination (Join-Path $portableStage "vPaste.exe") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $portableStage "LICENSE") -Force
Set-Content -LiteralPath (Join-Path $portableStage "portable.flag") -Value "vPaste portable mode" -Encoding ascii
Compress-Archive -Path (Join-Path $portableStage "*") -DestinationPath $portableZip -CompressionLevel Optimal

$chineseMessagesFile = Get-ChineseMessagesFile `
    -CacheDirectory (Join-Path $bundleRoot "inno-dependencies")

$iscc = Find-InnoCompiler
$innoScript = Join-Path $repoRoot "installer\windows\vpaste.iss"
Invoke-Checked $iscc `
    "/DAppVersion=$version" `
    "/DVersionInfoVersion=$versionInfoVersion" `
    "/DAppBinary=$appBinary" `
    "/DOutputDir=$bundleRoot" `
    "/DLicenseFile=$(Join-Path $repoRoot 'LICENSE')" `
    "/DIconFile=$(Join-Path $repoRoot 'src-tauri\icons\icon.ico')" `
    "/DInstallerLogo=$installerLogo" `
    "/DInstallerBackgroundLight=$installerBackgroundLight" `
    "/DInstallerBackgroundDark=$installerBackgroundDark" `
    "/DInstallerAssetDir=$innoDependencyRoot" `
    "/DChineseMessagesFile=$chineseMessagesFile" `
    $innoScript

if (-not (Test-Path -LiteralPath $installer)) {
    throw "Inno Setup did not produce the expected installer at $installer"
}

if ($SignUpdater) {
    $keyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    if (-not $keyPath) {
        $keyPath = Join-Path $HOME ".tauri\vpaste-updater-ci.key"
    }
    if ($keyPath -and (Test-Path -LiteralPath $keyPath)) {
        & npx.cmd tauri signer sign --private-key-path $keyPath "--password=$($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)" $installer
    }
    elseif ($env:TAURI_SIGNING_PRIVATE_KEY) {
        & npx.cmd tauri signer sign --private-key $env:TAURI_SIGNING_PRIVATE_KEY "--password=$($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)" $installer
    }
    else {
        throw "Updater signing key was not found. Set TAURI_SIGNING_PRIVATE_KEY_PATH or TAURI_SIGNING_PRIVATE_KEY."
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri updater signer exited with code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $installerSignature)) {
        throw "Tauri updater signer did not create $installerSignature"
    }
}

if (-not $ReleaseBaseUrl) {
    $ReleaseBaseUrl = "https://github.com/Loxonl/vPaste-desktop/releases/download/v$version"
}
$wingetManifest = Join-Path $bundleRoot "winget\Loxonl.vPaste.yaml"
Invoke-Checked node scripts/generate-winget-manifest.mjs `
    $version `
    $installer `
    "$ReleaseBaseUrl/$(Split-Path -Leaf $installer)" `
    $wingetManifest
if (Get-Command winget -ErrorAction SilentlyContinue) {
    Invoke-Checked winget validate --manifest $wingetManifest --disable-interactivity
}

$checksumFiles = @($installer, $portableZip)
if (Test-Path -LiteralPath $installerSignature) {
    $checksumFiles += $installerSignature
    Invoke-Checked node scripts/generate-updater-manifest.mjs `
        --version $version `
        --base-url $ReleaseBaseUrl `
        --artifact $installer `
        --signature $installerSignature `
        --platforms "windows-x86_64" `
        --output $windowsManifest
    $checksumFiles += $windowsManifest
}
$checksumLines = foreach ($file in $checksumFiles) {
    $hash = Get-Sha256 -Path $file
    "$hash  $(Split-Path -Leaf $file)"
}
Set-Content -LiteralPath (Join-Path $bundleRoot "SHA256SUMS.txt") -Value $checksumLines -Encoding ascii

$installerSize = (Get-Item -LiteralPath $installer).Length
$portableSize = (Get-Item -LiteralPath $portableZip).Length
$maximumInstallerSize = $portableSize + 2MB
if ($installerSize -gt $maximumInstallerSize) {
    throw "Installer overhead exceeds 2 MiB (installer: $installerSize bytes, portable ZIP: $portableSize bytes)"
}

Write-Host "Windows release assets created:"
Write-Host "  Installer: $installer"
Write-Host "  Portable:  $portableZip"
Write-Host "  Checksums: $(Join-Path $bundleRoot 'SHA256SUMS.txt')"
