[CmdletBinding()]
param(
    [string]$Compiler = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    [string]$AssetDirectory,
    [ValidateSet('running', 'stopped', 'repair', 'fresh')]
    [string]$Scenario = 'running',
    [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AssetDirectory) {
    $AssetDirectory = Join-Path $repoRoot 'src-tauri\target\release\bundle\windows\inno-dependencies'
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('vpaste-installer-update-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot 'installed'
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
    [Diagnostics.Process]::Start($info)
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
using System.Threading;
using System.Windows.Forms;

class HiddenForm : Form {
    protected override void SetVisibleCore(bool visible) {
        if (!IsHandleCreated) CreateHandle();
        base.SetVisibleCore(false);
    }
}
class Fixture {
    [STAThread]
    static void Main() {
        if (Path.GetFileName(Application.ExecutablePath).StartsWith("stall-")) {
            File.WriteAllText(Environment.GetEnvironmentVariable("VPASTE_INSTALLER_TEST_STALL"), "started");
            Thread.Sleep(120000);
            return;
        }
        using (var form = new HiddenForm()) {
            var handle = form.Handle;
            File.WriteAllText(Environment.GetEnvironmentVariable("VPASTE_INSTALLER_TEST_READY"), "ready");
            Application.Run(form);
        }
    }
}
'@)
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csc /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$fixtureBinary" $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Native fixture compilation failed.' }
    Copy-Item -LiteralPath $fixtureBinary -Destination $stallBinary
    if ($Scenario -ne 'fresh') {
        Copy-Item -LiteralPath $fixtureBinary -Destination $installedBinary
        [IO.File]::AppendAllText($installedBinary, 'old-version-overlay')
    }
    [IO.File]::WriteAllText($sentinel, 'preserve user data')

    $script = [IO.File]::ReadAllText((Join-Path $repoRoot 'installer\windows\vpaste.iss'))
    # Keep the real preparation/Restart Manager paths, but isolate product
    # identity and remove discovery, shortcuts, registration and launch effects.
    $script = $script.Replace('com.loxonl.vpaste', 'com.loxonl.vpaste.installer-test')
    $script = $script.Replace('UninstallDisplayName=vPaste', "UninstallDisplayName=vPaste`r`nUninstallable=no`r`nCreateUninstallRegKey=no")
    $script = [regex]::Replace($script, '(?s)\[InstallDelete\].*?(?=\[Code\])', '')
    $discovery = '(?s)procedure DetectExistingInstallation;.*?(?=\r?\nprocedure BrowseForInstallDirectory)'
    if ([regex]::Matches($script, $discovery).Count -ne 1) { throw 'Cannot isolate installation discovery safely.' }
    $installedVersion = if ($Scenario -eq 'fresh') { '' } elseif ($Scenario -eq 'repair') { '1.6.1' } else { '1.6.0' }
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
    }
    $setup = Join-Path $outputDirectory 'vPaste_1.6.1_windows_x64_setup.exe'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $installerProcess = Start-TestProcess $setup "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$installDirectory`" /LOG=`"$logPath`""
    if (-not $installerProcess.WaitForExit($TimeoutSeconds * 1000)) {
        throw "Installer preparation exceeded $TimeoutSeconds seconds; external shutdown probe started: $(Test-Path -LiteralPath $stallPath). Log: $logPath"
    }
    $timer.Stop()
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
    if ([IO.File]::ReadAllText($sentinel) -ne 'preserve user data') { throw 'Unrelated installation-directory data changed.' }
    Write-Output "PASS: $Scenario installation completed in $($timer.ElapsedMilliseconds) ms; EXE replaced, unrelated data retained. Log: $logPath"
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
