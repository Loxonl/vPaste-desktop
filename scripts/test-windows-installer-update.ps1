[CmdletBinding()]
param(
    [string]$Compiler = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    [string]$AssetDirectory,
    [ValidateSet('running', 'stopped', 'repair', 'fresh', 'upgrade-from-standard', 'downgrade', 'downgrade-unowned', 'downgrade-modified')]
    [string]$Scenario = 'running',
    [switch]$WinUiCandidate,
    [switch]$OfficialWinUi,
    [ValidateSet('none', 'write-error', 'cancel', 'backup-error', 'skip-exe', 'skip-winui-dll', 'reparse-metadata', 'reparse-parent')]
    [string]$Fault = 'none',
    [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
if ($WinUiCandidate -and $OfficialWinUi) { throw 'Specify either -OfficialWinUi or -WinUiCandidate, not both.' }
$withWinUiPayload = $WinUiCandidate -or $OfficialWinUi
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AssetDirectory) {
    $AssetDirectory = Join-Path $repoRoot 'src-tauri\target\release\bundle\windows\inno-dependencies'
}
$AssetDirectory = (Resolve-Path -LiteralPath $AssetDirectory).Path
$downgrade = $Scenario -like 'downgrade*'
if ($withWinUiPayload -and $downgrade) { throw 'Use the standard WebView-only installer for downgrade fixtures.' }
if ($Scenario -eq 'upgrade-from-standard' -and -not $withWinUiPayload) { throw 'Upgrade-from-standard requires a WinUI installer.' }
if ($Fault -eq 'skip-exe' -and $Scenario -ne 'downgrade') { throw 'Skip-exe requires a downgrade fixture.' }
if ($Fault -eq 'skip-winui-dll' -and -not $withWinUiPayload) { throw 'Skip-winui-dll requires a WinUI installer.' }
if ($Fault -eq 'backup-error' -and (-not $withWinUiPayload -or $Scenario -eq 'fresh')) {
    throw 'Backup-error requires an existing WinUI installation.'
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('vpaste-installer-update-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot 'installed'
if ($Fault -eq 'reparse-parent') {
    $outsideParent = Join-Path $testRoot 'outside-parent'
    $linkedParent = Join-Path $testRoot 'linked-parent'
    $null = New-Item -ItemType Directory -Path $outsideParent
    $null = New-Item -ItemType Junction -Path $linkedParent -Target $outsideParent
    $installDirectory = Join-Path $linkedParent 'installed'
}
$outputDirectory = Join-Path $testRoot 'output'
New-Item -ItemType Directory -Force -Path $installDirectory, $outputDirectory | Out-Null
$fixtureSource = Join-Path $testRoot 'fixture.cs'
$fixtureBinary = Join-Path $testRoot 'fixture.exe'
$stallBinary = Join-Path $testRoot 'stall-taskkill.exe'
$readyPath = Join-Path $testRoot 'ready'
$stallPath = Join-Path $testRoot 'taskkill-started'
$logPath = Join-Path $testRoot 'setup.log'
$installedBinary = Join-Path $installDirectory 'vPaste.exe'
$sentinel = Join-Path $installDirectory 'user-data-sentinel.txt'
$winUiFiles = @('VPasteWinUiPanel.dll', 'Microsoft.WindowsAppRuntime.Bootstrap.dll',
    'winui-licenses\license.txt', 'winui-licenses\NOTICE.txt')
$receiptRelativePath = '.installer\winui-payload.sha256'
$payloadFiles = @('vPaste.exe', 'LICENSE', 'portable.flag', $receiptRelativePath) + $winUiFiles
$oldCandidate = $downgrade -or ($withWinUiPayload -and $Scenario -notin @('fresh', 'upgrade-from-standard'))
$runningApp = $null
$installerProcess = $null

function Start-TestProcess([string]$FileName, [string]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FileName
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['VPASTE_INSTALLER_TEST_READY'] = $readyPath
    $info.EnvironmentVariables['VPASTE_INSTALLER_TEST_STALL'] = $stallPath
    if ($oldCandidate -and $FileName -eq $installedBinary) {
        $info.EnvironmentVariables['VPASTE_INSTALLER_TEST_DLLS'] = $winUiFiles[0..1] -join '|'
    }
    [Diagnostics.Process]::Start($info)
}

function Get-PayloadSnapshot {
    $snapshot = [ordered]@{}
    foreach ($relativePath in $payloadFiles) {
        $path = Join-Path $installDirectory $relativePath
        $snapshot[$relativePath] = if (Test-Path -LiteralPath $path -PathType Leaf) {
            (Get-FileHash -LiteralPath $path).Hash
        } else { 'absent' }
    }
    $snapshot
}

try {
    if (-not (Test-Path -LiteralPath $Compiler)) { throw "Inno Setup compiler missing: $Compiler" }
    $languageFile = Join-Path $AssetDirectory 'ChineseSimplified.isl'
    if (-not (Test-Path -LiteralPath $languageFile)) { throw 'Run Windows packaging once to populate the Inno asset cache.' }

    # A hidden, isolated native app holds the destination EXE open. Its alternate
    # executable simulates a taskkill process that never completes promptly.
    [IO.File]::WriteAllText($fixtureSource, @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class HiddenForm : Form {
    protected override void SetVisibleCore(bool visible) {
        if (!IsHandleCreated) CreateHandle();
        base.SetVisibleCore(false);
    }
}
class Fixture {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibrary(string fileName);

    [STAThread]
    static void Main() {
        if (Path.GetFileName(Application.ExecutablePath).StartsWith("stall-")) {
            File.WriteAllText(Environment.GetEnvironmentVariable("VPASTE_INSTALLER_TEST_STALL"), "started");
            Thread.Sleep(120000);
            return;
        }
        using (var form = new HiddenForm()) {
            var handle = form.Handle;
            var dlls = Environment.GetEnvironmentVariable("VPASTE_INSTALLER_TEST_DLLS");
            if (dlls != null) {
                foreach (var dll in dlls.Split('|')) {
                    var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, dll);
                    if (LoadLibrary(path) == IntPtr.Zero) {
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), path);
                    }
                }
            }
            File.WriteAllText(Environment.GetEnvironmentVariable("VPASTE_INSTALLER_TEST_READY"), dlls == null ? "ready" : dlls);
            Application.Run(form);
        }
    }
}
'@)
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csc /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll "/out:$fixtureBinary" $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Native fixture compilation failed.' }
    Copy-Item -LiteralPath $fixtureBinary -Destination $stallBinary
    if ($Fault -eq 'reparse-metadata') {
        $metadataTarget = Join-Path $testRoot 'outside-metadata'
        $null = New-Item -ItemType Directory -Path $metadataTarget
        $null = New-Item -ItemType Junction -Path (Join-Path $installDirectory '.installer') -Target $metadataTarget
    }
    if ($Scenario -ne 'fresh') {
        Copy-Item -LiteralPath $fixtureBinary -Destination $installedBinary
        [IO.File]::AppendAllText($installedBinary, 'old-version-overlay')
        [IO.File]::WriteAllText((Join-Path $installDirectory 'LICENSE'), 'old product license')
        [IO.File]::WriteAllText((Join-Path $installDirectory 'portable.flag'), 'old portable marker')
    }
    if ($oldCandidate) {
        $null = New-Item -ItemType Directory -Path (Join-Path $installDirectory 'winui-licenses')
        $oldDll = Join-Path $testRoot 'old-panel.dll'
        $fixtureRust = Join-Path $testRoot 'fixture.rs'
        [IO.File]::WriteAllText($fixtureRust, '#[no_mangle] pub extern "C" fn fixture() -> u32 { 1 }')
        & rustc --edition 2021 --crate-type cdylib $fixtureRust -o $oldDll
        if ($LASTEXITCODE) { throw 'Synthetic DLL compilation failed.' }
        foreach ($file in $winUiFiles) {
            $path = Join-Path $installDirectory $file
            if ($file.EndsWith('.dll')) { Copy-Item -LiteralPath $oldDll -Destination $path }
            else { [IO.File]::WriteAllText($path, "Old synthetic $file") }
        }
        $receipt = Join-Path $installDirectory $receiptRelativePath
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $receipt))) {
            $null = New-Item -ItemType Directory -Path (Split-Path -Parent $receipt)
        }
        if ($Scenario -ne 'downgrade-unowned') {
            $lines = @('com.loxonl.vpaste WinUI payload 1')
            $lines += foreach ($file in $winUiFiles) {
                "$((Get-FileHash -LiteralPath (Join-Path $installDirectory $file)).Hash.ToLowerInvariant())  $file"
            }
            Set-Content -LiteralPath $receipt -Value $lines -Encoding ascii
        }
        if ($Scenario -eq 'downgrade-modified') {
            [IO.File]::AppendAllText((Join-Path $installDirectory $winUiFiles[1]), 'unowned modification')
        }
        [IO.File]::WriteAllText((Join-Path $installDirectory 'winui-licenses\unrelated.txt'), 'keep unrelated license')
    }
    [IO.File]::WriteAllText($sentinel, 'preserve user data')
    $before = Get-PayloadSnapshot
    $before | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot 'before.json') -Encoding utf8

    $script = [IO.File]::ReadAllText((Join-Path $repoRoot 'installer\windows\vpaste.iss'))
    # Keep the real preparation/Restart Manager paths, but isolate product
    # identity and remove discovery, shortcuts, registration and launch effects.
    $script = $script.Replace('#define AppId "com.loxonl.vpaste"', '#define AppId "com.loxonl.vpaste.installer-test"')
    $script = $script.Replace('UninstallDisplayName=vPaste', "UninstallDisplayName=vPaste`r`nUninstallable=no`r`nCreateUninstallRegKey=no")
    $script = [regex]::Replace($script, '(?ms)^\[Icons\].*?(?=^\[Code\])', '')
    $script = [regex]::Replace($script, '(?m)^Type: .*\{userprograms\}.*\r?\n', '')
    $webViewProbe = 'Result := EnsureWebView2;'
    if (-not $script.Contains($webViewProbe)) { throw 'Cannot isolate WebView2 preparation safely.' }
    $script = $script.Replace($webViewProbe, "Result := '';")
    if ($Fault -eq 'reparse-parent') {
        # Exercise PrepareToInstall directly. The interactive directory check
        # can be blocked earlier by Inno's RedirectionGuard on newer Windows.
        $writabilityCheck = 'if not DirectoryIsWritable(RemoveBackslashUnlessRoot(DirectoryEdit.Text)) then'
        if (-not $script.Contains($writabilityCheck)) { throw 'Cannot isolate installation-directory validation safely.' }
        $script = $script.Replace($writabilityCheck, 'if False then')
    }
    $discovery = '(?s)procedure DetectExistingInstallation;.*?(?=\r?\nprocedure BrowseForInstallDirectory)'
    if ([regex]::Matches($script, $discovery).Count -ne 1) { throw 'Cannot isolate installation discovery safely.' }
    $installedVersion = if ($Scenario -eq 'fresh') { '' } elseif ($Scenario -eq 'repair' -or $downgrade) { '1.6.1' } else { '1.6.0' }
    $script = [regex]::Replace($script, $discovery, "procedure DetectExistingInstallation;`r`nbegin`r`n  ExistingVersion := '$installedVersion';`r`n  LegacyUninstallKey := '';`r`nend;`r`n")
    $script = $script.Replace("ExpandConstant('{sys}\taskkill.exe')", "'" + $stallBinary.Replace("'", "''") + "'")
    $pageChanged = '(?s)procedure CurPageChanged\(CurPageID: Integer\);.*?(?=\r?\nprocedure DeinitializeSetup;)'
    if ([regex]::Matches($script, $pageChanged).Count -ne 1) { throw 'Cannot instrument the native preparation page safely.' }
    $pageLayoutCheck = @'
  if (CurPageID = wpPreparing) and WizardForm.PreparingMemo.Visible then
  begin
    if (WizardForm.ClientWidth = ScaleX(WindowWidth)) and
       (WizardForm.ClientHeight <= ScaleY(320)) and
       (WizardForm.PreparingLabel.Left >= ScaleX(24)) and
       (WizardForm.PreparingMemo.Height <= ScaleY(96)) and
       WizardForm.PreparingYesRadio.Visible and WizardForm.PreparingNoRadio.Visible and
       (WizardForm.PreparingMemo.Top + WizardForm.PreparingMemo.Height < WizardForm.PreparingYesRadio.Top) and
       (WizardForm.PreparingNoRadio.Top + WizardForm.PreparingNoRadio.Height <
        WizardForm.OuterNotebook.Height) and
       (WizardForm.NextButton.Top >= WizardForm.OuterNotebook.Height) and
       (WizardForm.NextButton.Top + WizardForm.NextButton.Height < WizardForm.ClientHeight) then
      Log('PASS: occupied-file prompt fits the compact installer')
    else
      Log('FAIL: occupied-file prompt exceeds the compact installer layout');

    { Exercise the error-page styling without changing native install state. }
    WizardForm.PreparingMemo.Visible := False;
    WizardForm.PreparingLabel.Caption := 'Synthetic preparation failure';
    WizardForm.PreparingErrorBitmapImage.Visible := True;
    ConfigurePreparingPage;
    if (WizardForm.PreparingLabel.Caption = 'Synthetic preparation failure') and
       WizardForm.PreparingErrorBitmapImage.Visible and
       (WizardForm.ClientHeight = ScaleY(NativeFallbackHeight)) then
      Log('PASS: preparation errors retain their message and fallback layout')
    else
      Log('FAIL: preparation error presentation was overwritten');
    WizardForm.PreparingMemo.Visible := True;
    ConfigurePreparingPage;
  end;
'@
    $pageBody = [regex]::Match($script, $pageChanged).Value
    $script = $script.Replace($pageBody, $pageBody.Replace('  SendMessage(', $pageLayoutCheck + "`r`n  SendMessage("))
    if ($Fault -in @('cancel', 'write-error')) {
        $injectedName = if ($Fault -eq 'cancel') { 'cancel-trigger' } else { 'write-error-trigger' }
        if ($Fault -eq 'write-error') {
            $null = New-Item -ItemType Directory -Path (Join-Path $installDirectory $injectedName)
        }
        $afterInstall = if ($Fault -eq 'cancel') { '; AfterInstall: CancelFixture' } else { '' }
        $script = $script.Replace('[InstallDelete]', "Source: `"{#LicenseFile}`"; DestDir: `"{app}`"; DestName: `"$injectedName`"; Flags: ignoreversion$afterInstall`r`n`r`n[InstallDelete]")
    }
    if ($Fault -eq 'cancel') {
        $script += @'

procedure CancelFixture;
begin
  WizardForm.CancelButton.Visible := True;
  WizardForm.CancelButton.Enabled := True;
  SendMessage(WizardForm.CancelButton.Handle, $00F5, 0, 0);
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  Log('TEST: native cancel callback');
  Cancel := True;
  Confirm := False;
end;
'@
    }
    if ($Fault -eq 'backup-error') {
        $backupAnchor = "  PayloadBackupRoot := ExpandConstant('{tmp}\vpaste-previous-payload');"
        if (-not $script.Contains($backupAnchor)) { throw 'Cannot inject an isolated backup failure.' }
        $script = $script.Replace($backupAnchor, $backupAnchor +
            "`r`n  ForceDirectories(PayloadBackupRoot + '\winui-licenses\NOTICE.txt');")
    }
    if ($Fault -eq 'skip-exe') {
        $exeEntry = 'DestName: "vPaste.exe"; Flags: ignoreversion'
        if (-not $script.Contains($exeEntry)) { throw 'Cannot isolate the skipped EXE entry.' }
        $script = $script.Replace($exeEntry, "$exeEntry; Check: SkipExecutableFixture")
        $script += @'

function SkipExecutableFixture: Boolean;
begin
  Result := False;
end;
'@
    }
    if ($Fault -eq 'skip-winui-dll') {
        $bootstrapEntry = 'Source: "{#WinUiBinaryDir}\Microsoft.WindowsAppRuntime.Bootstrap.dll"; DestDir: "{app}"; Flags: ignoreversion'
        if (-not $script.Contains($bootstrapEntry)) { throw 'Cannot isolate the skipped Bootstrap entry.' }
        $script = $script.Replace($bootstrapEntry, "$bootstrapEntry; Check: SkipBootstrapFixture")
        $script += @'

function SkipBootstrapFixture: Boolean;
begin
  Result := False;
end;
'@
    }
    $scriptPath = Join-Path $testRoot 'installer.iss'
    [IO.File]::WriteAllText($scriptPath, $script)
    $defines = @(
        '/DAppVersion=1.6.1', '/DVersionInfoVersion=1.6.1.0',
        "/DAppBinary=$fixtureBinary", "/DOutputDir=$outputDirectory",
        "/DLicenseFile=$repoRoot\LICENSE", "/DIconFile=$repoRoot\src-tauri\icons\icon.ico",
        "/DInstallerLogo=$repoRoot\src-tauri\icons\icon.png",
        "/DInstallerBackgroundLight=$AssetDirectory\installer-background-light.png",
        "/DInstallerBackgroundDark=$AssetDirectory\installer-background-dark.png",
        "/DInstallerAssetDir=$AssetDirectory", "/DChineseMessagesFile=$languageFile"
    )
    if ($withWinUiPayload) {
        $winUiSource = Join-Path $testRoot 'winui-source'
        $winUiLicenses = Join-Path $winUiSource 'winui-licenses'
        $null = New-Item -ItemType Directory -Path $winUiLicenses -Force
        foreach ($file in $winUiFiles) {
            [IO.File]::WriteAllText((Join-Path $winUiSource $file), "Synthetic $file")
        }
        $newReceipt = Join-Path $testRoot 'new-payload.sha256'
        $lines = @('com.loxonl.vpaste WinUI payload 1')
        $lines += foreach ($file in $winUiFiles) {
            "$((Get-FileHash -LiteralPath (Join-Path $winUiSource $file)).Hash.ToLowerInvariant())  $file"
        }
        Set-Content -LiteralPath $newReceipt -Value $lines -Encoding ascii
        if ($WinUiCandidate) {
            $defines += '/DWinUiRcBuild=1.6.1-winui-rc.1'
        }
        $defines += "/DWinUiBinaryDir=$winUiSource", "/DWinUiLicenseDir=$winUiLicenses", "/DWinUiReceipt=$newReceipt"
    }
    & $Compiler /Q @defines $scriptPath *> (Join-Path $testRoot 'compile.log')
    if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed; see $testRoot\compile.log" }

    if ($Scenario -in @('running', 'repair')) {
        $runningApp = Start-TestProcess $installedBinary ''
        $readyDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while (-not (Test-Path -LiteralPath $readyPath)) {
            if ($runningApp.HasExited -or [DateTime]::UtcNow -ge $readyDeadline) { throw 'Native fixture did not become ready.' }
            Start-Sleep -Milliseconds 50
        }
        if ($runningApp.HasExited) { throw 'Native fixture exited before installation.' }
        if ($oldCandidate -and [IO.File]::ReadAllText($readyPath) -ne ($winUiFiles[0..1] -join '|')) {
            throw 'The synthetic process did not map both existing DLLs.'
        }
    }
    $buildId = if ($WinUiCandidate) { '1.6.1-winui-rc.1' } else { '1.6.1' }
    $setup = Join-Path $outputDirectory "vPaste_${buildId}_windows_x64_setup.exe"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $silentFlag = if ($Fault -eq 'cancel') { '/SILENT' } else { '/VERYSILENT' }
    $installerProcess = Start-TestProcess $setup "$silentFlag /SUPPRESSMSGBOXES /NORESTART /DIR=`"$installDirectory`" /LOG=`"$logPath`""
    if (-not $installerProcess.WaitForExit($TimeoutSeconds * 1000)) {
        throw "Installer preparation exceeded $TimeoutSeconds seconds; external shutdown probe started: $(Test-Path -LiteralPath $stallPath). Log: $logPath"
    }
    $timer.Stop()
    $after = Get-PayloadSnapshot
    $after | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot 'after.json') -Encoding utf8
    if ([IO.File]::ReadAllText($sentinel) -ne 'preserve user data') { throw 'Unrelated installation-directory data changed.' }
    if ($oldCandidate -and [IO.File]::ReadAllText((Join-Path $installDirectory 'winui-licenses\unrelated.txt')) -ne 'keep unrelated license') {
        throw 'An unrelated file in the license directory changed.'
    }
    if ($Fault -ne 'none') {
        $preparationFailure = $Fault -in @('backup-error', 'reparse-metadata', 'reparse-parent')
        $expectedExit = if ($preparationFailure) { 7 } elseif ($Fault -in @('skip-exe', 'skip-winui-dll')) { 4 } else { 5 }
        if ($installerProcess.ExitCode -ne $expectedExit) { throw "Expected exit $expectedExit, got $($installerProcess.ExitCode). Log: $logPath" }
        $log = [IO.File]::ReadAllText($logPath)
        if (-not $preparationFailure -and -not $log.Contains('Rolling back changes.')) { throw 'Inno rollback did not run.' }
        if ($preparationFailure -and
            (-not $log.Contains('Payload backup failed before replacement:') -or $log.Contains('Starting the installation process.'))) {
            throw 'The backup failure did not stop setup before replacing files.'
        }
        if ($Fault -eq 'reparse-metadata' -and (Test-Path -LiteralPath (Join-Path $metadataTarget 'logo.png'))) {
            throw 'Setup wrote through the installer metadata junction.'
        }
        if ($Fault -eq 'reparse-parent' -and
            (-not $log.Contains("Unexpected file type or reparse point: $linkedParent") -or
             (Test-Path -LiteralPath (Join-Path $outsideParent 'installed/.installer/logo.png')))) {
            throw 'Setup did not stop before writing through the installation parent junction.'
        }
        if ($Fault -eq 'skip-exe' -and -not $log.Contains('Incomplete WebView payload: vPaste.exe')) {
            throw 'The WebView payload guard did not reject the skipped EXE.'
        }
        if ($Fault -eq 'skip-winui-dll' -and -not $log.Contains('Incomplete WinUI payload: Microsoft.WindowsAppRuntime.Bootstrap.dll')) {
            throw 'The incomplete WinUI payload guard did not reject the skipped Bootstrap DLL.'
        }
        if ($Fault -eq 'cancel' -and -not $log.Contains('TEST: native cancel callback')) { throw 'Native cancel was not exercised.' }
        if ($Fault -eq 'write-error' -and -not $log.Contains('write-error-trigger')) { throw 'The write fault was not exercised.' }
        foreach ($file in $payloadFiles) {
            if ($before[$file] -ne $after[$file]) { throw "Rollback changed ${file}: $($before[$file]) -> $($after[$file])" }
        }
        Write-Output "PASS: $Scenario $Fault preserved every payload hash and absence. Log: $logPath"
        return
    }
    if ($installerProcess.ExitCode -ne 0) { throw "Installer failed with exit $($installerProcess.ExitCode). Log: $logPath" }
    if ($runningApp -and -not $runningApp.WaitForExit(3000)) { throw 'The occupied executable was not released.' }
    if (Test-Path -LiteralPath $stallPath) { throw 'Installer invoked the external process-tree shutdown utility.' }
    if ($runningApp -and -not ([IO.File]::ReadAllText($logPath).Contains('PASS: occupied-file prompt fits the compact installer'))) {
        throw "The occupied-file prompt did not pass its runtime layout check. Log: $logPath"
    }
    if ($runningApp -and -not ([IO.File]::ReadAllText($logPath).Contains('PASS: preparation errors retain their message and fallback layout'))) {
        throw "The preparation error message was not preserved. Log: $logPath"
    }
    if ((Get-FileHash -LiteralPath $installedBinary).Hash -ne (Get-FileHash -LiteralPath $fixtureBinary).Hash) { throw 'The installed executable was not replaced.' }
    if ($after['LICENSE'] -ne (Get-FileHash -LiteralPath (Join-Path $repoRoot 'LICENSE')).Hash -or $after['portable.flag'] -ne 'absent') {
        throw 'The product license or portable marker has an unexpected state.'
    }
    $expectedReceipt = if ($withWinUiPayload) { (Get-FileHash -LiteralPath $newReceipt).Hash } else { 'absent' }
    if ($after[$receiptRelativePath] -ne $expectedReceipt) { throw 'The WinUI payload receipt has an unexpected state.' }
    if ($withWinUiPayload -and -not ([IO.File]::ReadAllText($logPath).Contains('Verified installed WinUI payload.'))) {
        throw 'Setup did not verify the WinUI payload before completing the installation.'
    }
    foreach ($file in $winUiFiles) {
        $path = Join-Path $installDirectory $file
        if ($withWinUiPayload) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or [IO.File]::ReadAllText($path) -ne "Synthetic $file") {
                throw "Expected WinUI payload at $path"
            }
        } else {
            $expected = if ($Scenario -eq 'downgrade-unowned' -or
                ($Scenario -eq 'downgrade-modified' -and $file -eq $winUiFiles[1])) { $before[$file] } else { 'absent' }
            if ($after[$file] -ne $expected) { throw "Unexpected WinUI payload at $path" }
        }
    }
    $lockedDlls = if ($runningApp -and $oldCandidate) { ' Both synthetic DLLs were loaded before Restart Manager handled the process.' } else { '' }
    Write-Output "PASS: $Scenario installation completed in $($timer.ElapsedMilliseconds) ms with the expected payload and unrelated data retained.$lockedDlls Log: $logPath"
} finally {
    # Only processes launched by this fixture are eligible for cleanup.
    if ($installerProcess -and -not $installerProcess.HasExited) {
        $ownedChildren = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $installerProcess.Id })
        foreach ($child in $ownedChildren) {
            $helpers = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $child.ProcessId })
            foreach ($helper in $helpers) { Stop-Process -Id $helper.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $installerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($runningApp -and -not $runningApp.HasExited) { Stop-Process -Id $runningApp.Id -Force -ErrorAction SilentlyContinue }
    Write-Output "Native installer test artifacts: $testRoot"
}
