[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [switch]$WinUiCandidate,
    [switch]$WinUi
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "vPaste release binary was not found at $Executable"
}
# Inspect the default selection without loading the WinUI runtime on build machines.
$infoText = & $Executable --winui-build-info --main-ui=webview | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Windows Release executable.' }
$info = $infoText | ConvertFrom-Json
if (-not $info.PSObject.Properties['defaultMainUi']) {
    throw 'The executable lacks Windows release mode metadata. Rebuild it before packaging.'
}
$expectsWinUi = $WinUiCandidate -or $WinUi
$expectedDefault = if ($expectsWinUi) { 'winui' } else { 'webview' }
if ($info.arch -ne 'x86_64' -or $info.debug -ne $false -or $info.localAcceptance -ne $false -or
    $info.winuiDebug -ne $false -or $info.winui -ne $expectsWinUi -or $info.mainUi -ne 'webview' -or
    $info.defaultMainUi -ne $expectedDefault -or $info.internalRc -ne $WinUiCandidate.IsPresent) {
    throw "Expected a Windows x64 Release binary with default=$expectedDefault and winui=$expectsWinUi. Rebuild for this package mode."
}
if ($WinUiCandidate) {
    if ($info.buildId -cne $info.version -or $info.version -cnotmatch '^2\.0\.0-rc\.[1-9][0-9]*$' -or
        $info.appIdentifier -cne 'com.loxonl.vpaste' -or $info.appName -cne 'vPaste Internal RC' -or
        $info.autostartSupported -ne $false -or $info.updaterConfigured -ne $false -or $info.updateFeedEnabled -ne $false) {
        throw 'Expected the internal RC label, version, manual launch and offline updates. Rebuild with -WinUiCandidate -InternalRcVersion.'
    }
}
elseif ($info.buildId -ne $info.version -or $info.updaterConfigured -ne $true) {
    throw 'Expected the standard updater configuration and build ID. Rebuild for this package mode.'
}

function Read-X64Dll {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing native output: $Path" }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) {
        throw "Invalid PE image: $Path"
    }
    $header = [BitConverter]::ToInt32($bytes, 60)
    if ($header -lt 64 -or $header -gt ($bytes.Length - 24) -or
        [BitConverter]::ToUInt32($bytes, $header) -ne 0x4550 -or
        [BitConverter]::ToUInt16($bytes, $header + 4) -ne 0x8664 -or
        ([BitConverter]::ToUInt16($bytes, $header + 22) -band 0x2000) -eq 0) {
        throw "Expected an x64 DLL: $Path"
    }
    return [Text.Encoding]::ASCII.GetString($bytes)
}

if ($expectsWinUi) {
    # Check the package inputs without loading them. Packaging does not require
    # an installed Windows App Runtime on the build machine.
    $directory = Split-Path -Parent $Executable
    $bootstrap = Read-X64Dll (Join-Path $directory 'Microsoft.WindowsAppRuntime.Bootstrap.dll')
    foreach ($name in @('MddBootstrapInitialize2', 'MddBootstrapShutdown')) {
        if (-not $bootstrap.Contains($name + [char]0)) { throw "Missing bootstrap export: $name" }
    }
    $panel = Read-X64Dll (Join-Path $directory 'VPasteWinUiPanel.dll')
    $exports = @('protocol_version', 'initialize', 'show', 'hide', 'toggle', 'refresh', 'refresh_tags',
        'set_layout', 'get_layout', 'set_preview_layout', 'size_preview', 'window_handle', 'reader_handle',
        'focus_history', 'set_behavior', 'hide_for_queue_paste', 'set_theme', 'set_language',
        'set_click_mode', 'set_queue_view', 'show_queue_no_activate', 'receive', 'shutdown')
    foreach ($name in $exports) {
        if (-not $panel.Contains("vpaste_winui_$name" + [char]0)) { throw "Missing WinUI export: $name" }
    }
    if ($panel.Contains('vpaste_winui_test_') -or
        $panel -match '(?i)(MSVCP\d+D|VCRUNTIME\d+(?:_\d+)?D|ucrtbased)\.dll') {
        throw 'WinUI Release DLL contains Debug probes or requires a Debug CRT.'
    }
}

$info
