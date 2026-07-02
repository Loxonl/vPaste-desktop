$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$DevUrlPort = 1420
$escapedRoot = [Regex]::Escape($Root)

$listeners = Get-NetTCPConnection -LocalPort $DevUrlPort -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq "node.exe" -and $process.CommandLine -match $escapedRoot -and $process.CommandLine -match "vite") {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Milliseconds 250
npm run dev
