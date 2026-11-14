[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('missing', 'corrupt', 'identity', 'valid', 'installed', 'what-if')]
    [string]$Scenario
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = Join-Path ([IO.Path]::GetTempPath()) ('vpaste-winui-runtime-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path (Join-Path $root 'runtime')
$installer = Join-Path $root 'Install-WinUiRuntime.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../scripts/windows-winui/Install-WinUiRuntime.ps1') -Destination $installer
$global:VPasteRuntimeInstallCalls = [System.Collections.Generic.List[string]]::new()
function Get-AppxPackage {
    param([string]$Name)
    if ($Scenario -eq 'installed') {
        [pscustomobject]@{ Architecture = 'X64'; Version = '9999.0.0.0' }
    }
}
function Add-AppxPackage {
    param([string]$Path)
    $global:VPasteRuntimeInstallCalls.Add($Path)
}

try {
    $files = @('Microsoft.WindowsAppRuntime.2.msix', 'Microsoft.WindowsAppRuntime.DDLM.2.msix',
        'Microsoft.WindowsAppRuntime.Main.2.msix', 'Microsoft.WindowsAppRuntime.Singleton.2.msix')
    $names = @('Microsoft.WindowsAppRuntime.2', 'Microsoft.WinAppRuntime.DDLM.2.6.5.0-x6',
        'MicrosoftCorporationII.WinAppRuntime.Main.2', 'MicrosoftCorporationII.WinAppRuntime.Singleton')
    $checksums = @()
    for ($index = 0; $index -lt $files.Count; $index++) {
        $file = Join-Path $root ('runtime/' + $files[$index])
        $name = if ($Scenario -eq 'identity' -and $index -eq 3) { 'Microsoft.UnrelatedPackage' } else { $names[$index] }
        $version = if ($index -eq 3) { '8002.6.5.0' } else { '2.6.5.0' }
        $archive = [IO.Compression.ZipFile]::Open($file, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $writer = [IO.StreamWriter]::new($archive.CreateEntry('AppxManifest.xml').Open())
            try {
                $writer.Write(('<Package><Identity Name="{0}" Version="{1}" ProcessorArchitecture="x64" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"/><Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0"/></Dependencies></Package>' -f $name, $version))
            } finally { $writer.Dispose() }
        } finally { $archive.Dispose() }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $checksum = [BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-', '').ToLowerInvariant()
        } finally { $algorithm.Dispose() }
        $checksums += $checksum + '  runtime/' + $files[$index]
    }
    [IO.File]::WriteAllLines((Join-Path $root 'SHA256SUMS.txt'), $checksums)
    $lastPackage = Join-Path $root ('runtime/' + $files[-1])
    if ($Scenario -eq 'missing') { Remove-Item -LiteralPath $lastPackage }
    if ($Scenario -eq 'corrupt') { [IO.File]::AppendAllText($lastPackage, 'unexpected bytes') }

    $failure = $null
    try {
        if ($Scenario -eq 'what-if') { & $installer -WhatIf } else { & $installer }
    } catch { $failure = $_ }

    if ($Scenario -in @('missing', 'corrupt', 'identity')) {
        if (-not $failure) { throw "Expected the $Scenario package set to be rejected" }
        if ($failure.ToString() -notmatch [regex]::Escape($files[-1])) { throw "Unexpected fixture failure: $failure" }
        if ($global:VPasteRuntimeInstallCalls.Count -ne 0) { throw "Installed $($global:VPasteRuntimeInstallCalls.Count) package(s) before rejecting $Scenario input" }
    } else {
        if ($failure) { throw $failure }
        $expectedCalls = if ($Scenario -eq 'valid') { 4 } else { 0 }
        if ($global:VPasteRuntimeInstallCalls.Count -ne $expectedCalls) { throw "Expected $expectedCalls installation calls, got $($global:VPasteRuntimeInstallCalls.Count)" }
        if ($Scenario -eq 'valid') {
            for ($index = 0; $index -lt $files.Count; $index++) {
                if ([IO.Path]::GetFileName($global:VPasteRuntimeInstallCalls[$index]) -ne $files[$index]) { throw 'Runtime installation order changed' }
            }
        }
    }
    [pscustomobject]@{ scenario = $Scenario; mockedInstallCalls = $global:VPasteRuntimeInstallCalls.Count; passed = $true } | ConvertTo-Json -Compress
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ([IO.Path]::GetDirectoryName($resolvedRoot) -ne $expectedParent -or
        [IO.Path]::GetFileName($resolvedRoot) -notmatch '^vpaste-winui-runtime-test-[a-f0-9]{32}$') {
        throw 'Refusing to clean an unexpected fixture directory'
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
