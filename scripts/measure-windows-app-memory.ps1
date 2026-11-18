param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)] [int]$TargetProcessId,
    [ValidateRange(2, 3600)] [int]$DurationSeconds = 30,
    [ValidateRange(250, 10000)] [int]$IntervalMilliseconds = 1000,
    [string]$Label = 'idle',
    [string]$OutputPath
)

# Read-only observer: never starts/stops apps, changes focus, trims memory or
# touches clipboard/configuration. Run one UI backend at a time with equal data.
$ErrorActionPreference = 'Stop'
$rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId"
if (-not $rootProcess -or $rootProcess.Name -ne 'vPaste.exe') {
    throw 'TargetProcessId must identify the intended running vPaste.exe.'
}
if ($OutputPath -and (Test-Path -LiteralPath $OutputPath)) {
    throw 'OutputPath already exists; choose a new measurement file.'
}
$identity = [pscustomobject]@{
    processId = $TargetProcessId
    startedAt = $rootProcess.CreationDate.ToUniversalTime().ToString('o')
    binarySha256 = (Get-FileHash -LiteralPath $rootProcess.ExecutablePath -Algorithm SHA256).Hash
    commandLine = $rootProcess.CommandLine
}
$samples = [System.Collections.Generic.List[object]]::new()
$watch = [System.Diagnostics.Stopwatch]::StartNew()
while ($watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $processes = @(Get-CimInstance Win32_Process)
    $currentRoot = $processes | Where-Object { $_.ProcessId -eq $TargetProcessId }
    if (-not $currentRoot -or $currentRoot.CreationDate -ne $rootProcess.CreationDate) {
        throw 'The original process exited; measurement is incomplete.'
    }
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($TargetProcessId)
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if ($ids.Contains([int]$candidate.ParentProcessId)) {
                if ($ids.Add([int]$candidate.ProcessId)) { $added = $true }
            }
        }
    } while ($added)
    $rows = @()
    foreach ($processKey in $ids) {
        try {
            $process = Get-Process -Id $processKey
            $rows += [pscustomobject]@{
                processId = $processKey
                name = $process.ProcessName
                privateCommitBytes = $process.PrivateMemorySize64
                workingSetBytes = $process.WorkingSet64
                handles = $process.HandleCount
            }
            $process.Dispose()
        } catch {
            throw "Process $processKey changed during sampling; retry this interval."
        }
    }
    $samples.Add([pscustomobject]@{
        elapsedMs = [math]::Round($watch.Elapsed.TotalMilliseconds)
        privateCommitBytes = ($rows | Measure-Object privateCommitBytes -Sum).Sum
        workingSetBytes = ($rows | Measure-Object workingSetBytes -Sum).Sum
        handles = ($rows | Measure-Object handles -Sum).Sum
        processCount = $rows.Count
        processes = $rows
    })
    $remaining = [int](($DurationSeconds * 1000) - $watch.Elapsed.TotalMilliseconds)
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([math]::Min($IntervalMilliseconds, $remaining)) }
}
$ordered = @($samples | ForEach-Object { $_.privateCommitBytes } | Sort-Object)
$report = [pscustomobject]@{
    label = $Label
    identity = $identity
    metric = 'sum of private committed bytes across the complete process tree'
    workingSetCaveat = 'summed working sets may double-count shared pages'
    samples = $samples
    summary = [pscustomobject]@{
        sampleCount = $ordered.Count
        privateCommitMedianBytes = $ordered[[math]::Floor(($ordered.Count - 1) / 2)]
        privateCommitP95Bytes = $ordered[[math]::Ceiling($ordered.Count * 0.95) - 1]
        privateCommitMinBytes = $ordered[0]
        privateCommitMaxBytes = $ordered[-1]
    }
}
$json = $report | ConvertTo-Json -Depth 6
if ($OutputPath) { Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8 }
$json
