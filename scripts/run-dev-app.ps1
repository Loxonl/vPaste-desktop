$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$SrcTauri = Join-Path $Root "src-tauri"
$DevUrlPort = 1420

$escapedRoot = [Regex]::Escape($Root)
$escapedSrcTauri = [Regex]::Escape($SrcTauri)
$oldProcesses = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -in @("vPaste.exe", "vpaste-desktop.exe") -and $_.CommandLine -match $escapedSrcTauri) -or
  ($_.Name -eq "cargo.exe" -and $_.CommandLine -match $escapedRoot)
}
foreach ($process in $oldProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 300

$listener = Get-NetTCPConnection -LocalPort $DevUrlPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") -WorkingDirectory $Root -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

Push-Location $SrcTauri
try {
  cargo build --bin vPaste
}
finally {
  Pop-Location
}

$Exe = Join-Path $SrcTauri "target\debug\vPaste.exe"
if (-not (Test-Path $Exe)) {
  throw "vPaste debug executable was not found: $Exe"
}

Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
