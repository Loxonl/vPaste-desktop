[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Version -lt [version]'10.0.17763.0') {
    throw 'This Windows App SDK runtime requires Windows 10 1809 or newer.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packages = @('Microsoft.WindowsAppRuntime.2.msix', 'Microsoft.WindowsAppRuntime.DDLM.2.msix',
    'Microsoft.WindowsAppRuntime.Main.2.msix', 'Microsoft.WindowsAppRuntime.Singleton.2.msix')
$names = @('Microsoft.WindowsAppRuntime.2', '', 'MicrosoftCorporationII.WinAppRuntime.Main.2',
    'MicrosoftCorporationII.WinAppRuntime.Singleton')
$checksums = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS.txt')) {
    if ($line -match '^([a-fA-F0-9]{64})  (runtime/[^/]+\.msix)$') {
        if ($checksums.ContainsKey($Matches[2])) { throw "Duplicate runtime checksum: $($Matches[2])" }
        $checksums[$Matches[2]] = $Matches[1]
    }
}

# Validate the complete bundle before the first installation. A missing or
# corrupt final package must not leave earlier packages partially installed.
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $validatedPackages = @(for ($index = 0; $index -lt $packages.Count; $index++) {
        $file = $packages[$index]
        $path = Join-Path $PSScriptRoot "runtime/$file"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing runtime package: $file" }
        $expectedHash = $checksums["runtime/$file"]
        if (-not $expectedHash) { throw "Missing runtime SHA256 checksum: $file" }
        $stream = [IO.File]::OpenRead($path)
        try { $actualHash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose() }
        if ($actualHash -ne $expectedHash) { throw "Runtime SHA256 mismatch: $file" }
        $package = [IO.Compression.ZipFile]::OpenRead($path)
        try {
            $entry = $package.GetEntry('AppxManifest.xml')
            if (-not $entry) { throw "Missing runtime manifest: $file" }
            $reader = [IO.StreamReader]::new($entry.Open())
            try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $package.Dispose() }
        $identity = $manifest.Package.Identity
        $expectedName = if ($index -eq 1) { "Microsoft.WinAppRuntime.DDLM.$($identity.Version)-x6" } else { $names[$index] }
        if ($identity.Name -ne $expectedName -or $identity.ProcessorArchitecture -ne 'x64' -or
            $identity.Publisher -ne 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US') {
            throw "Unexpected runtime identity: $file"
        }
        foreach ($family in $manifest.Package.Dependencies.TargetDeviceFamily) {
            if ([version]$family.MinVersion -gt [Environment]::OSVersion.Version) {
                throw "Runtime package requires Windows $($family.MinVersion) or newer: $file"
            }
        }
        [pscustomobject]@{ Path = $path; Name = $identity.Name; Version = [version]$identity.Version }
    })
} finally { $sha256.Dispose() }

foreach ($runtime in $validatedPackages) {
    $installed = Get-AppxPackage -Name $runtime.Name | Where-Object {
        $_.Architecture -eq 'X64' -and [version]$_.Version -ge $runtime.Version
    }
    if ($installed) { Write-Host "Already installed: $($runtime.Name)"; continue }
    if ($PSCmdlet.ShouldProcess($runtime.Name, 'Install bundled Microsoft-signed runtime for the current user')) {
        # Add-AppxPackage validates the package signature. No download or forced
        # shutdown of other applications is requested.
        Add-AppxPackage -Path $runtime.Path
    }
}
Write-Host 'Runtime check finished. Start vPaste with Start-vPaste.cmd.'
