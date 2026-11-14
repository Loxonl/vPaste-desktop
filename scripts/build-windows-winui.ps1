[CmdletBinding()]
param([switch]$SkipAppBuild)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    if (-not $SkipAppBuild) {
        # The normal production frontend excludes UI Lab and embedded debug tools.
        & npx.cmd tauri build --no-bundle --features winui --config src-tauri/tauri.local.conf.json
        if ($LASTEXITCODE -ne 0) { throw 'WinUI Release build failed.' }
    }
    & node scripts/check-native-debug-assets.mjs production
    if ($LASTEXITCODE -ne 0) { throw 'Development UI leaked into the production frontend.' }
    $releaseRoot = Join-Path $repoRoot 'src-tauri/target/release'
    $executable = Join-Path $releaseRoot 'vPaste.exe'
    $infoText = & $executable --winui-build-info | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Release executable.' }
    $info = $infoText | ConvertFrom-Json
    if (-not $info.winui -or $info.debug -or $info.arch -ne 'x86_64') {
        throw 'Expected a Windows x64 Release binary built with --features winui.'
    }
    & node scripts/check-office-release-isolation.mjs --binary $executable
    if ($LASTEXITCODE -ne 0) { throw 'Release isolation check failed.' }

    [xml]$project = Get-Content -Raw 'src-tauri/native-demo/windows/winui/WinUiPanel.vcxproj'
    $reference = $project.SelectSingleNode("//*[local-name()='PackageReference' and @Include='Microsoft.WindowsAppSDK.WinUI']")
    $sdkVersion = $reference.Version
    $nugetRoot = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $env:USERPROFILE '.nuget/packages' }
    $runtimeRoot = Join-Path $nugetRoot "microsoft.windowsappsdk.runtime/$sdkVersion"
    $packages = @('Microsoft.WindowsAppRuntime.2.msix', 'Microsoft.WindowsAppRuntime.DDLM.2.msix',
        'Microsoft.WindowsAppRuntime.Main.2.msix', 'Microsoft.WindowsAppRuntime.Singleton.2.msix')
    $nativeFiles = @('vPaste.exe', 'VPasteWinUiPanel.dll', 'Microsoft.WindowsAppRuntime.Bootstrap.dll')
    foreach ($file in $nativeFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot $file))) { throw "Missing native output: $file" }
    }
    $nativeImage = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $releaseRoot 'VPasteWinUiPanel.dll')))
    $exports = @('protocol_version', 'initialize', 'show', 'hide', 'toggle', 'refresh', 'refresh_tags',
        'set_layout', 'get_layout', 'window_handle', 'reader_handle', 'focus_history', 'set_behavior',
        'hide_for_queue_paste', 'set_theme', 'set_language', 'set_click_mode', 'set_queue_view',
        'show_queue_no_activate', 'receive', 'shutdown')
    foreach ($name in $exports) {
        if (-not $nativeImage.Contains("vpaste_winui_$name" + [char]0)) { throw "Missing WinUI export: $name" }
    }
    if ($nativeImage.Contains('vpaste_winui_test_') -or
        $nativeImage -match '(?i)(MSVCP\d+D|VCRUNTIME\d+(?:_\d+)?D|ucrtbased)\.dll') {
        throw 'WinUI Release DLL contains Debug probes or requires a Debug CRT.'
    }
    foreach ($file in $packages) {
        if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot "tools/MSIX/win10-x64/$file"))) {
            throw "Missing offline runtime: $file. Restore Microsoft.WindowsAppSDK.Runtime $sdkVersion."
        }
    }

    # Each build gets a new directory. Never clear an existing portable's data.
    $name = "vPaste_$($info.version)_windows_x64_winui_$(Get-Date -Format yyyyMMdd-HHmmss)"
    $stage = Join-Path $releaseRoot "bundle/windows-winui/$name"
    $null = New-Item -ItemType Directory -Path $stage
    $runtimeStage = Join-Path $stage 'runtime'
    $null = New-Item -ItemType Directory -Path $runtimeStage
    foreach ($file in $nativeFiles) {
        Copy-Item -LiteralPath (Join-Path $releaseRoot $file) -Destination $stage
    }
    foreach ($file in $packages) {
        Copy-Item -LiteralPath (Join-Path $runtimeRoot "tools/MSIX/win10-x64/$file") -Destination $runtimeStage
    }
    foreach ($file in @('license.txt', 'NOTICE.txt')) {
        Copy-Item -LiteralPath (Join-Path $runtimeRoot $file) -Destination $runtimeStage
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stage
    Copy-Item -Path (Join-Path $PSScriptRoot 'windows-winui/*') -Destination $stage
    Set-Content -LiteralPath (Join-Path $stage 'portable.flag') -Value 'vPaste portable mode' -Encoding ascii
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hashes = Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
            $relative = $_.FullName.Substring($stage.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, [char]'/')
            $stream = [IO.File]::OpenRead($_.FullName)
            try { $checksum = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $stream.Dispose() }
            "$checksum  $relative"
        }
    } finally { $sha256.Dispose() }
    Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Value $hashes -Encoding ascii
    $archive = "$stage.zip"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
    Write-Host "WinUI Release portable: $stage"
    Write-Host "Offline archive: $archive"
    Write-Host 'Use Start-vPaste.cmd. If the runtime is missing, run Install-WinUiRuntime.ps1 once.'
}
finally { Pop-Location }
