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
foreach ($file in $packages) {
    $path = Join-Path $PSScriptRoot "runtime/$file"
    $package = [IO.Compression.ZipFile]::OpenRead($path)
    try {
        $reader = [IO.StreamReader]::new($package.GetEntry('AppxManifest.xml').Open())
        try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $package.Dispose() }
    $identity = $manifest.Package.Identity
    if ($identity.ProcessorArchitecture -ne 'x64' -or $identity.Publisher -ne 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US') {
        throw "Unexpected runtime identity: $file"
    }
    $installed = Get-AppxPackage -Name $identity.Name | Where-Object {
        $_.Architecture -eq 'X64' -and [version]$_.Version -ge [version]$identity.Version
    }
    if ($installed) { Write-Host "Already installed: $($identity.Name)"; continue }
    if ($PSCmdlet.ShouldProcess($identity.Name, 'Install bundled Microsoft-signed runtime for the current user')) {
        # Add-AppxPackage validates the package signature. No download or forced
        # shutdown of other applications is requested.
        Add-AppxPackage -Path $path
    }
}
Write-Host 'Runtime check finished. Start vPaste with Start-vPaste.cmd.'
