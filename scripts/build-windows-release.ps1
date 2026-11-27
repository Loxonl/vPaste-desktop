[CmdletBinding()]
param(
    [switch]$SkipAppBuild,
    [switch]$WinUiCandidate,
    [string]$InternalRcVersion,
    [switch]$WebViewOnly,
    [string]$OutputDirectory,
    [switch]$SignUpdater,
    [string]$ReleaseBaseUrl,
    [string]$AuthenticodeCertificateThumbprint,
    [string]$AuthenticodeCertificatePath,
    [string]$AuthenticodeCertificatePassword,
    [string]$AuthenticodeTimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($WinUiCandidate -and $WebViewOnly) {
    throw "-WebViewOnly cannot be combined with -WinUiCandidate."
}
if ($WinUiCandidate) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "The WinUI RC can only be built on Windows."
    }
    if ($SignUpdater -or $PSBoundParameters.ContainsKey("ReleaseBaseUrl") -or
        $AuthenticodeCertificateThumbprint -or $AuthenticodeCertificatePath -or $AuthenticodeCertificatePassword -or
        $PSBoundParameters.ContainsKey("AuthenticodeTimestampUrl")) {
        throw "The WinUI RC is a manual package. Remove signing and release URL options."
    }
    if (($env:VPASTE_PUBLIC_UPDATE_FEED -and $env:VPASTE_PUBLIC_UPDATE_FEED -ne "0") -or $env:VPASTE_UPDATE_CHANNEL) {
        throw "The WinUI RC cannot use a public update feed or channel."
    }
    if ($InternalRcVersion -cnotmatch '^2\.0\.0-rc\.[1-9][0-9]*$') {
        throw "Supply -InternalRcVersion in the 2.0.0-rc.N family with -WinUiCandidate."
    }
    if ($OutputDirectory) {
        throw "The internal RC always uses its own versioned output directory."
    }
} elseif ($PSBoundParameters.ContainsKey("InternalRcVersion")) {
    throw "-InternalRcVersion requires -WinUiCandidate."
}

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

# The internal RC has its own portable output and never enters the installer or signer path.
if ($WinUiCandidate) {
    $targetRoot = Join-Path $repoRoot "src-tauri\target"
    $releaseRoot = Join-Path $targetRoot "release"
    $bundleRoot = Join-Path $releaseRoot "bundle\windows-internal-rc\$InternalRcVersion"
    if (Test-Path -LiteralPath $bundleRoot) {
        throw "The internal RC output already exists. Keep it and choose another RC number or archive it: $bundleRoot"
    }

    [xml]$project = Get-Content -Raw "src-tauri/native-demo/windows/winui/WinUiPanel.vcxproj"
    $reference = $project.SelectSingleNode("//*[local-name()='PackageReference' and @Include='Microsoft.WindowsAppSDK.WinUI']")
    $nugetRoot = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $env:USERPROFILE ".nuget/packages" }
    $winUiLicenseDir = Join-Path $nugetRoot "microsoft.windowsappsdk.winui/$($reference.Version)"
    Invoke-Checked npm run check:release

    if (-not $SkipAppBuild) {
        $null = New-Item -ItemType Directory -Path $bundleRoot
        $config = Get-Content -Raw "src-tauri/tauri.winui-rc.conf.json" | ConvertFrom-Json
        $config | Add-Member -NotePropertyName "version" -NotePropertyValue $InternalRcVersion
        $configPath = Join-Path $bundleRoot "tauri.internal-rc.json"
        [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10))
        $buildEnvironment = @{
            CARGO_TARGET_DIR = $targetRoot
            CARGO_NET_OFFLINE = "true"
            npm_config_offline = "true"
            RestoreSources = $nugetRoot
            NuGetAudit = "false"
            VPASTE_PUBLIC_UPDATE_FEED = "0"
            VPASTE_WINDOWS_INTERNAL_RC_VERSION = $InternalRcVersion
        }
        $previousEnvironment = @{}
        try {
            foreach ($name in $buildEnvironment.Keys) {
                $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
                [Environment]::SetEnvironmentVariable($name, $buildEnvironment[$name])
            }
            Invoke-Checked npx.cmd tauri build --no-bundle --config $configPath --features winui-rc
        } finally {
            foreach ($name in $previousEnvironment.Keys) {
                [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name])
            }
        }
    }

    $appBinary = Join-Path $releaseRoot "vPaste.exe"
    $info = & (Join-Path $PSScriptRoot "check-windows-release-binary.ps1") -Executable $appBinary -WinUiCandidate
    if ($info.version -cne $InternalRcVersion) {
        throw "Expected internal RC $InternalRcVersion, found $($info.version). Rebuild before packaging."
    }
    Invoke-Checked node scripts/check-office-release-isolation.mjs --binary $appBinary
    Invoke-Checked node scripts/check-native-debug-assets.mjs production

    $portableStage = Join-Path $bundleRoot "portable"
    $null = New-Item -ItemType Directory -Path (Join-Path $portableStage "winui-licenses")
    foreach ($file in @("vPaste.exe", "VPasteWinUiPanel.dll", "Microsoft.WindowsAppRuntime.Bootstrap.dll")) {
        Copy-Item -LiteralPath (Join-Path $releaseRoot $file) -Destination $portableStage
    }
    foreach ($file in @("license.txt", "NOTICE.txt")) {
        Copy-Item -LiteralPath (Join-Path $winUiLicenseDir $file) -Destination (Join-Path $portableStage "winui-licenses")
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination $portableStage
    $readme = Join-Path $repoRoot "docs\open-source\releases\windows-winui-rc-trial.md"
    Copy-Item -LiteralPath $readme -Destination (Join-Path $portableStage "INTERNAL-RC.md")
    Set-Content -LiteralPath (Join-Path $portableStage "internal-rc.flag") -Value $InternalRcVersion -Encoding ascii
    $profileInfo = & (Join-Path $portableStage "vPaste.exe") --winui-build-info --main-ui=webview | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $profileInfo.internalProfileReady -ne $true) {
        throw "The internal RC portable profile did not pass validation."
    }

    $portableZip = Join-Path $bundleRoot "vPaste_${InternalRcVersion}_windows_x64_internal_portable.zip"
    Compress-Archive -Path (Join-Path $portableStage "*") -DestinationPath $portableZip -CompressionLevel Optimal
    $checksum = "$(Get-Sha256 -Path $portableZip)  $(Split-Path -Leaf $portableZip)"
    Set-Content -LiteralPath (Join-Path $bundleRoot "SHA256SUMS.txt") -Value $checksum -Encoding ascii
    Write-Host "Windows internal RC Portable ZIP: $portableZip"
    return
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

function Get-AuthenticodeCertificate {
    if ($AuthenticodeCertificateThumbprint) {
        $certificate = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $AuthenticodeCertificateThumbprint } | Select-Object -First 1
        if (-not $certificate) {
            throw "Authenticode certificate with thumbprint $AuthenticodeCertificateThumbprint was not found in Cert:\CurrentUser\My."
        }
        return $certificate
    }

    if ($AuthenticodeCertificatePath) {
        if (-not (Test-Path -LiteralPath $AuthenticodeCertificatePath)) {
            throw "Authenticode certificate file was not found at $AuthenticodeCertificatePath."
        }
        $certificatePassword = if ($null -ne $AuthenticodeCertificatePassword) { $AuthenticodeCertificatePassword } else { "" }
        $password = ConvertTo-SecureString -String $certificatePassword -AsPlainText -Force
        return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $AuthenticodeCertificatePath,
            $password,
            [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
        )
    }

    return $null
}

function Invoke-AuthenticodeSign {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )

    $signature = Set-AuthenticodeSignature `
        -LiteralPath $Path `
        -Certificate $Certificate `
        -HashAlgorithm SHA256 `
        -TimestampServer $AuthenticodeTimestampUrl
    if ($signature.Status -ne "Valid") {
        throw "Authenticode signing failed for $Path with status $($signature.Status): $($signature.StatusMessage)"
    }
}

$authenticodeCertificate = Get-AuthenticodeCertificate

$package = Get-Content -Raw package.json | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw "Unsupported application version for Windows resources: $version"
}
$versionInfoVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"

$includeWinUi = -not $WebViewOnly
$releaseRoot = Join-Path $repoRoot "src-tauri\target\release"
$defaultBundleRoot = Join-Path $releaseRoot "bundle\windows"
$bundleRoot = $defaultBundleRoot
if ($OutputDirectory) {
    $bundleRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
    if (Test-Path -LiteralPath $bundleRoot) {
        throw "Specify a new directory for -OutputDirectory. Existing output was preserved: $bundleRoot"
    }
}
$winUiLicenseDir = $null
if ($includeWinUi) {
    [xml]$project = Get-Content -Raw "src-tauri/native-demo/windows/winui/WinUiPanel.vcxproj"
    $reference = $project.SelectSingleNode("//*[local-name()='PackageReference' and @Include='Microsoft.WindowsAppSDK.WinUI']")
    if (-not $reference -or -not $reference.Version) {
        throw "Could not determine the Microsoft.WindowsAppSDK.WinUI version from WinUiPanel.vcxproj."
    }
    $nugetRoot = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $env:USERPROFILE ".nuget/packages" }
    $winUiLicenseDir = Join-Path $nugetRoot "microsoft.windowsappsdk.winui/$($reference.Version)"
}

Invoke-Checked npm run check:release

if (-not $SkipAppBuild) {
    if (-not $env:VPASTE_PUBLIC_UPDATE_FEED) {
        $env:VPASTE_PUBLIC_UPDATE_FEED = "0"
    }
    $tauriBuildArgs = @("tauri", "build", "--no-bundle")
    if ($includeWinUi) {
        $tauriBuildArgs += @("--features", "winui")
    }
    $tauriBuildArgs += @("--config", "src-tauri/tauri.local.conf.json")
    Invoke-Checked npx.cmd @tauriBuildArgs
}
Invoke-Checked node scripts/check-native-debug-assets.mjs production

$appBinary = Join-Path $releaseRoot "vPaste.exe"
$checkBinaryArgs = @{ Executable = $appBinary }
if ($includeWinUi) {
    $checkBinaryArgs["WinUi"] = $true
}
$info = & (Join-Path $PSScriptRoot "check-windows-release-binary.ps1") @checkBinaryArgs
if ($info.version -ne $version) {
    throw "Expected Release binary version $version, found $($info.version). Rebuild before packaging."
}
Invoke-Checked node scripts/check-office-release-isolation.mjs --binary $appBinary
if ($includeWinUi) {
    foreach ($licenseFileName in @("license.txt", "NOTICE.txt")) {
        $licensePath = Join-Path $winUiLicenseDir $licenseFileName
        if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
            throw "Missing WinUI SDK license file at $licensePath. Restore Microsoft.WindowsAppSDK.WinUI packages before packaging."
        }
    }
}
if ($authenticodeCertificate) {
    Invoke-AuthenticodeSign -Path $appBinary -Certificate $authenticodeCertificate
    if ($includeWinUi) {
        # 仅签名自研 WinUI 面板 DLL，保留微软对 Bootstrap DLL 的原始签名，且在生成载荷清单前完成签名。
        Invoke-AuthenticodeSign -Path (Join-Path $releaseRoot "VPasteWinUiPanel.dll") -Certificate $authenticodeCertificate
    }
}

$portableStage = Join-Path $bundleRoot "portable"
$portableZip = Join-Path $bundleRoot "vPaste_${version}_windows_x64_portable.zip"
$installer = Join-Path $bundleRoot "vPaste_${version}_windows_x64_setup.exe"
$installerSignature = "$installer.sig"
$windowsManifest = Join-Path $bundleRoot "latest.windows.json"
$installerLogo = Join-Path $repoRoot "src-tauri\icons\icon.png"
$innoDependencyRoot = Join-Path $bundleRoot "inno-dependencies"
$installerBackgroundLight = Join-Path $innoDependencyRoot "installer-background-light.png"
$installerBackgroundDark = Join-Path $innoDependencyRoot "installer-background-dark.png"
$winUiReceipt = Join-Path $innoDependencyRoot "winui-payload.sha256"
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path $innoDependencyRoot -Force | Out-Null
if (Test-Path -LiteralPath $portableStage) {
    Remove-Item -LiteralPath $portableStage -Recurse -Force
}
foreach ($staleFile in @($portableZip, $installer, $installerSignature, $windowsManifest, $winUiReceipt, (Join-Path $bundleRoot "vpaste-installer-logo.bmp"))) {
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
if ($includeWinUi) {
    $portableLicenses = Join-Path $portableStage "winui-licenses"
    New-Item -ItemType Directory -Path $portableLicenses -Force | Out-Null
    foreach ($dllName in @("VPasteWinUiPanel.dll", "Microsoft.WindowsAppRuntime.Bootstrap.dll")) {
        Copy-Item -LiteralPath (Join-Path $releaseRoot $dllName) -Destination (Join-Path $portableStage $dllName) -Force
    }
    foreach ($licenseFileName in @("license.txt", "NOTICE.txt")) {
        Copy-Item -LiteralPath (Join-Path $winUiLicenseDir $licenseFileName) -Destination (Join-Path $portableLicenses $licenseFileName) -Force
    }

    # 生成官方 WinUI 载荷收据，供降级回纯 WebView 安装器进行归属与哈希校验清理。
    $receiptEntries = @(
        @{ Relative = "VPasteWinUiPanel.dll"; Source = (Join-Path $releaseRoot "VPasteWinUiPanel.dll") },
        @{ Relative = "Microsoft.WindowsAppRuntime.Bootstrap.dll"; Source = (Join-Path $releaseRoot "Microsoft.WindowsAppRuntime.Bootstrap.dll") },
        @{ Relative = "winui-licenses\license.txt"; Source = (Join-Path $winUiLicenseDir "license.txt") },
        @{ Relative = "winui-licenses\NOTICE.txt"; Source = (Join-Path $winUiLicenseDir "NOTICE.txt") }
    )
    $receiptLines = @("com.loxonl.vpaste WinUI payload 1")
    $receiptLines += foreach ($entry in $receiptEntries) {
        "$(Get-Sha256 -Path $entry.Source)  $($entry.Relative)"
    }
    Set-Content -LiteralPath $winUiReceipt -Value $receiptLines -Encoding ascii
}
Compress-Archive -Path (Join-Path $portableStage "*") -DestinationPath $portableZip -CompressionLevel Optimal

$chineseMessagesFile = Get-ChineseMessagesFile `
    -CacheDirectory (Join-Path $defaultBundleRoot "inno-dependencies")

$iscc = Find-InnoCompiler
$innoScript = Join-Path $repoRoot "installer\windows\vpaste.iss"
$innoDefines = @(
    "/DAppVersion=$version",
    "/DVersionInfoVersion=$versionInfoVersion",
    "/DAppBinary=$appBinary",
    "/DOutputDir=$bundleRoot",
    "/DLicenseFile=$(Join-Path $repoRoot 'LICENSE')",
    "/DIconFile=$(Join-Path $repoRoot 'src-tauri\icons\icon.ico')",
    "/DInstallerLogo=$installerLogo",
    "/DInstallerBackgroundLight=$installerBackgroundLight",
    "/DInstallerBackgroundDark=$installerBackgroundDark",
    "/DInstallerAssetDir=$innoDependencyRoot",
    "/DChineseMessagesFile=$chineseMessagesFile"
)
if ($includeWinUi) {
    $innoDefines += @(
        "/DWinUiBinaryDir=$releaseRoot",
        "/DWinUiLicenseDir=$winUiLicenseDir",
        "/DWinUiReceipt=$winUiReceipt"
    )
}
Invoke-Checked $iscc @innoDefines $innoScript

if (-not (Test-Path -LiteralPath $installer)) {
    throw "Inno Setup did not produce the expected installer at $installer"
}
if ($authenticodeCertificate) {
    Invoke-AuthenticodeSign -Path $installer -Certificate $authenticodeCertificate
}

if ($SignUpdater) {
    if ($env:TAURI_SIGNING_PRIVATE_KEY) {
        # Tauri rejects signer invocations that receive both key inputs.
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $null
    }
    else {
        $keyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
        if (-not $keyPath) {
            $keyPath = Join-Path $HOME ".tauri\vpaste-updater-ci.key"
        }
        if (-not (Test-Path -LiteralPath $keyPath)) {
            throw "Updater signing key was not found. Set TAURI_SIGNING_PRIVATE_KEY_PATH or TAURI_SIGNING_PRIVATE_KEY."
        }
        $env:TAURI_SIGNING_PRIVATE_KEY = $null
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $keyPath
    }

    & npx.cmd tauri signer sign $installer
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
