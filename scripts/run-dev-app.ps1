param(
  [switch]$DeveloperMode,
  [ValidateSet("webview", "winui")]
  [string]$MainUi = "webview"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$SrcTauri = Join-Path $Root "src-tauri"
$DevUrlPort = 1420
$WinUiMode = $DeveloperMode -and $MainUi -eq "winui"

$escapedRoot = [Regex]::Escape($Root)
$oldProcesses = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -in @("vPaste.exe", "vpaste-desktop.exe") -and
    $_.ExecutablePath -match "\\src-tauri\\target\\debug\\(vPaste|vpaste-desktop)\.exe$") -or
  ($_.Name -eq "cargo.exe" -and $_.CommandLine -match $escapedRoot)
}
foreach ($process in $oldProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 300

$otherRunningApps = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @("vPaste.exe", "vpaste-desktop.exe")
}
if ($otherRunningApps) {
  throw "Quit the running vPaste app before starting the local debug build."
}

$listener = $null
if (-not $WinUiMode) {
  $listener = Get-NetTCPConnection -LocalPort $DevUrlPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}
if ($listener) {
  $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  $isCurrentVite = $listenerProcess -and
    $listenerProcess.Name -eq "node.exe" -and
    $listenerProcess.CommandLine -match $escapedRoot -and
    $listenerProcess.CommandLine -match "vite"
  $isOtherVite = $listenerProcess -and
    $listenerProcess.Name -eq "node.exe" -and
    $listenerProcess.CommandLine -match "vite"

  if ($isCurrentVite) {
    # Reuse the Vite server that already belongs to this checkout.
  } elseif ($isOtherVite) {
    Stop-Process -Id $listenerProcess.ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    $listener = $null
  } else {
    throw "Port $DevUrlPort is already used by another process. Stop PID $($listener.OwningProcess) and retry."
  }
}

if (-not $WinUiMode -and -not $listener) {
  Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") -WorkingDirectory $Root -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

if ($WinUiMode) {
  # Auxiliary readers use embedded assets; the native panel never needs Vite.
  Push-Location $Root
  try {
    npm.cmd run build -- --mode native-debug
    if ($LASTEXITCODE -ne 0) {
      throw "Frontend build failed; the previous WinUI executable was not started."
    }
    node scripts/check-native-debug-assets.mjs native-debug
    if ($LASTEXITCODE -ne 0) {
      throw "Native Debug tool assets are missing; the previous executable was not started."
    }
  }
  finally {
    Pop-Location
  }
}

Push-Location $SrcTauri
try {
  if ($WinUiMode) {
    cargo build --bin vPaste --features winui-debug
  } else {
    cargo build --bin vPaste
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Rust/native build failed; the previous executable was not started."
  }
}
finally {
  Pop-Location
}

$Exe = Join-Path $SrcTauri "target\debug\vPaste.exe"
if (-not (Test-Path $Exe)) {
  throw "vPaste debug executable was not found: $Exe"
}

if ($DeveloperMode) {
  if ($WinUiMode) {
    Start-Process -FilePath $Exe -ArgumentList @("--dev-mode", "--main-ui=winui") -WorkingDirectory (Split-Path -Parent $Exe)
  } else {
    Start-Process -FilePath $Exe -ArgumentList @("--dev-mode", "--main-ui=webview") -WorkingDirectory (Split-Path -Parent $Exe)
  }
} else {
  Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
}
