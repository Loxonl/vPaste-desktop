#ifndef AppVersion
  #error AppVersion must be supplied by the build script
#endif
#ifndef VersionInfoVersion
  #error VersionInfoVersion must be supplied by the build script
#endif
#ifndef AppBinary
  #error AppBinary must be supplied by the build script
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the build script
#endif
#ifndef LicenseFile
  #error LicenseFile must be supplied by the build script
#endif
#ifndef IconFile
  #error IconFile must be supplied by the build script
#endif
#ifndef InstallerLogo
  #error InstallerLogo must be supplied by the build script
#endif
#ifndef ChineseMessagesFile
  #error ChineseMessagesFile must be supplied by the build script
#endif
#ifndef InstallerBackgroundLight
  #error InstallerBackgroundLight must be supplied by the build script
#endif
#ifndef InstallerBackgroundDark
  #error InstallerBackgroundDark must be supplied by the build script
#endif
#ifndef InstallerAssetDir
  #error InstallerAssetDir must be supplied by the build script
#endif

#define AppId "com.loxonl.vpaste"
#define AppName "vPaste"
#define AppPublisher "Loxonl"
#define AppUrl "https://vpaste.app"
#define RepositoryUrl "https://github.com/Loxonl/vPaste-desktop"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#RepositoryUrl}/issues
AppUpdatesURL={#RepositoryUrl}/releases
DefaultDirName={localappdata}\Programs\vPaste
DefaultGroupName=vPaste
DisableWelcomePage=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=vPaste_{#AppVersion}_windows_x64_setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\vPaste.exe
UninstallDisplayName=vPaste
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern dynamic
WizardBackColor=#ffffff
WizardBackColorDynamicDark=#171b23
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
CloseApplications=yes
RestartApplications=no
AllowNoIcons=no
UsePreviousAppDir=yes
UsePreviousGroup=no
SetupLogging=yes
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=vPaste Setup
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion={#VersionInfoVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "{#ChineseMessagesFile}"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#AppBinary}"; DestDir: "{app}"; DestName: "vPaste.exe"; Flags: ignoreversion restartreplace
Source: "{#LicenseFile}"; DestDir: "{app}"; DestName: "LICENSE"; Flags: ignoreversion
Source: "{#InstallerLogo}"; Flags: dontcopy
Source: "{#InstallerAssetDir}\*.png"; Flags: dontcopy
Source: "{#InstallerLogo}"; DestDir: "{app}\.installer"; DestName: "logo.png"; Flags: ignoreversion; Attribs: hidden
Source: "{#InstallerBackgroundLight}"; DestDir: "{app}\.installer"; DestName: "installer-background-light.png"; Flags: ignoreversion; Attribs: hidden
Source: "{#InstallerBackgroundDark}"; DestDir: "{app}\.installer"; DestName: "installer-background-dark.png"; Flags: ignoreversion; Attribs: hidden
Source: "{#InstallerAssetDir}\action-uninstall-zh.png"; DestDir: "{app}\.installer"; DestName: "action-uninstall-zh.png"; Flags: ignoreversion; Attribs: hidden
Source: "{#InstallerAssetDir}\action-uninstall-en.png"; DestDir: "{app}\.installer"; DestName: "action-uninstall-en.png"; Flags: ignoreversion; Attribs: hidden
Source: "{#InstallerAssetDir}\close-light.png"; DestDir: "{app}\.installer"; DestName: "close-light.png"; Flags: ignoreversion; Attribs: hidden
Source: "{#InstallerAssetDir}\close-dark.png"; DestDir: "{app}\.installer"; DestName: "close-dark.png"; Flags: ignoreversion; Attribs: hidden

[InstallDelete]
Type: files; Name: "{app}\portable.flag"
Type: files; Name: "{userprograms}\vPaste\vPaste.lnk"
Type: dirifempty; Name: "{userprograms}\vPaste"

[Icons]
Name: "{userprograms}\vPaste"; Filename: "{app}\vPaste.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\vPaste"; Filename: "{app}\vPaste.exe"; WorkingDir: "{app}"; Check: ShouldCreateDesktopShortcut

[Run]
Filename: "{app}\vPaste.exe"; Description: "{cm:LaunchProgram,vPaste}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\vPaste.exe"; Parameters: "--updated-from={#AppVersion}"; WorkingDir: "{app}"; Flags: nowait; Check: ShouldRestartAfterUpdate

[Code]
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2DownloadUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';
  LegacyUninstallRoot = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';
  NewUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\com.loxonl.vpaste_is1';
  GCLStyle = -26;
  CSDropShadow = $00020000;
  DwmWindowCornerPreference = 33;
  DwmRoundCorners = 2;
  WindowWidth = 480;
  CollapsedHeight = 300;
  ExpandedHeight = 400;
  InstallingHeight = 280;
  FinishedHeight = 250;
  NativeFallbackHeight = 420;
  UninstallHeight = 260;
  BackgroundDesignWidth = 1000;
  BackgroundDesignHeight = 1040;
  SetupBackgroundVerticalOffset = 72;
  WMSetRedraw = $000B;
  WMUpdateUIState = $0128;
  HideFocusUIState = $00010001;
  BodySurfaceLight = $00FFF6F1;
  BodySurfaceDark = $0030221B;
  InputSurfaceLight = $00FFFFFF;
  InputSurfaceDark = $003C3127;
  BorderLight = $00E9D7CB;
  BorderDark = $005D4836;

function GetClassLong(Window: HWND; Index: Integer): Longint;
  external 'GetClassLongW@user32.dll stdcall';
function SetClassLong(Window: HWND; Index: Integer; NewLong: Longint): Longint;
  external 'SetClassLongW@user32.dll stdcall';
function CreateRoundRectRgn(
  LeftRect, TopRect, RightRect, BottomRect, EllipseWidth, EllipseHeight: Integer): Integer;
  external 'CreateRoundRectRgn@gdi32.dll stdcall';
function SetWindowRgn(Window: HWND; Region: Integer; Redraw: Boolean): Integer;
  external 'SetWindowRgn@user32.dll stdcall';
function DwmSetWindowAttribute(
  Window: HWND; Attribute: Integer; var Value: Integer; ValueSize: Integer): Integer;
  external 'DwmSetWindowAttribute@dwmapi.dll stdcall';

var
  WindowBorder: TPanel;
  InteractionFocusSink: TNewEdit;
  WelcomeBackground: TBitmapImage;
  InstallingBackground: TBitmapImage;
  FinishedBackground: TBitmapImage;
  LogoImage: TBitmapImage;
  InstallLogoImage: TBitmapImage;
  FinishLogoImage: TBitmapImage;
  QuickInstallButton: TBitmapImage;
  FinishButton: TBitmapImage;
  CustomButton: TBitmapImage;
  QuickInstallAccessButton: TNewButton;
  FinishAccessButton: TNewButton;
  CustomAccessButton: TNewButton;
  BrowseAccessButton: TNewButton;
  WelcomeCloseButton: TBitmapImage;
  InstallingCloseButton: TBitmapImage;
  FinishedCloseButton: TBitmapImage;
  AdvancedPanel: TPanel;
  DirectoryLabel: TNewStaticText;
  DirectoryEditFrame: TPanel;
  DirectoryEdit: TNewEdit;
  BrowseButton: TBitmapImage;
  DesktopCheck: TNewCheckBox;
  InstallTitleLabel: TNewStaticText;
  ExistingVersion: String;
  LegacyUninstallKey: String;
  PreviousExecutableBackup: String;
  InstallCompleted: Boolean;
  ExistingAppPrepared: Boolean;
  CreateDesktopShortcut: Boolean;
  RemoveUserData: Boolean;
  UninstallAppDataDir: String;
  UninstallHistoryDir: String;
  UninstallCustomHistory: Boolean;
  UninstallPromptForm: TSetupForm;
  UninstallPromptFocusSink: TNewEdit;
  UninstallPromptConfirmed: Boolean;

function IsChinese: Boolean;
begin
  Result := ActiveLanguage = 'chinesesimplified';
end;

function Localized(const ChineseText, EnglishText: String): String;
begin
  if IsChinese then
    Result := ChineseText
  else
    Result := EnglishText;
end;

function CommandLineSwitchExists(const Name: String): Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/' + Name) = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

function ShouldRestartAfterUpdate: Boolean;
begin
  Result := CommandLineSwitchExists('RESTARTAPP');
end;

function ShouldCreateDesktopShortcut: Boolean;
begin
  if WizardSilent then
    Result := WizardIsTaskSelected('desktopicon')
  else
    Result := CreateDesktopShortcut;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := PageID = wpSelectTasks;
end;

function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM32, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) or
    RegQueryStringValue(HKLM64, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

function PowerShellQuoted(const Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '''', '''''', True);
  Result := '''' + Result + '''';
end;

function VerifyMicrosoftSignature(const FileName: String): Boolean;
var
  ExitCode: Integer;
  Script: String;
begin
  Script := '$signature=Get-AuthenticodeSignature -LiteralPath ' + PowerShellQuoted(FileName) +
    '; if ($signature.Status -eq ''Valid'' -and $signature.SignerCertificate.Subject -match ''Microsoft Corporation'') { exit 0 }; exit 1';
  Result := Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function EnsureWebView2: String;
var
  Bootstrapper: String;
  ExitCode: Integer;
begin
  Result := '';
  if WebView2Installed then
    Exit;

  WizardForm.StatusLabel.Caption := Localized('正在准备 Microsoft WebView2', 'Preparing Microsoft WebView2');
  try
    DownloadTemporaryFile(
      WebView2DownloadUrl,
      'MicrosoftEdgeWebview2Setup.exe',
      '',
      nil);
    Bootstrapper := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
  except
    Result := Localized(
      '无法下载 Microsoft WebView2，请检查网络后重试。官方地址：' + WebView2DownloadUrl,
      'Microsoft WebView2 could not be downloaded. Check your connection and retry. Official URL: ' + WebView2DownloadUrl);
    Exit;
  end;

  if not VerifyMicrosoftSignature(Bootstrapper) then
  begin
    Result := Localized(
      'Microsoft WebView2 安装程序签名验证失败，安装已停止',
      'The Microsoft WebView2 installer signature is invalid. Setup has stopped');
    Exit;
  end;

  if not Exec(Bootstrapper, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) then
  begin
    Result := Localized(
      'Microsoft WebView2 安装失败，请重试或从微软官网下载',
      'Microsoft WebView2 installation failed. Retry or download it from Microsoft');
    Exit;
  end;

  if not WebView2Installed then
    Result := Localized(
      'Microsoft WebView2 安装后仍未检测到运行时，请重新启动安装程序',
      'Microsoft WebView2 is still unavailable. Restart this installer and try again');
end;

function NumericVersionPart(var Version: String): Integer;
var
  Separator: Integer;
  Part: String;
begin
  while (Length(Version) > 0) and ((Version[1] = 'v') or (Version[1] = 'V')) do
    Delete(Version, 1, 1);
  Separator := Pos('.', Version);
  if Separator = 0 then
    Separator := Length(Version) + 1;
  Part := Copy(Version, 1, Separator - 1);
  Delete(Version, 1, Separator);
  Result := StrToIntDef(Part, 0);
end;

procedure ParseVersion(Value: String; var CoreVersion, PreRelease: String);
var
  Separator: Integer;
begin
  Value := Trim(Value);
  while (Length(Value) > 0) and ((Value[1] = 'v') or (Value[1] = 'V')) do
    Delete(Value, 1, 1);
  Separator := Pos('+', Value);
  if Separator > 0 then
    Delete(Value, Separator, Length(Value));
  Separator := Pos('-', Value);
  if Separator > 0 then
  begin
    CoreVersion := Copy(Value, 1, Separator - 1);
    PreRelease := Copy(Value, Separator + 1, Length(Value));
  end
  else
  begin
    CoreVersion := Value;
    PreRelease := '';
  end;
end;

function NextPreReleaseIdentifier(var PreRelease: String): String;
var
  Separator: Integer;
begin
  Separator := Pos('.', PreRelease);
  if Separator = 0 then
  begin
    Result := PreRelease;
    PreRelease := '';
  end
  else
  begin
    Result := Copy(PreRelease, 1, Separator - 1);
    Delete(PreRelease, 1, Separator);
  end;
end;

function IsNumericIdentifier(const Value: String): Boolean;
var
  Index: Integer;
begin
  Result := Value <> '';
  for Index := 1 to Length(Value) do
    if (Value[Index] < '0') or (Value[Index] > '9') then
    begin
      Result := False;
      Exit;
    end;
end;

function ComparePreRelease(LeftPreRelease, RightPreRelease: String): Integer;
var
  LeftIdentifier, RightIdentifier: String;
  LeftNumeric, RightNumeric: Boolean;
  LeftNumber, RightNumber, Comparison: Integer;
begin
  Result := 0;
  if (LeftPreRelease = '') and (RightPreRelease = '') then
    Exit;
  if LeftPreRelease = '' then
  begin
    Result := 1;
    Exit;
  end;
  if RightPreRelease = '' then
  begin
    Result := -1;
    Exit;
  end;

  while (LeftPreRelease <> '') or (RightPreRelease <> '') do
  begin
    if LeftPreRelease = '' then
    begin
      Result := -1;
      Exit;
    end;
    if RightPreRelease = '' then
    begin
      Result := 1;
      Exit;
    end;

    LeftIdentifier := NextPreReleaseIdentifier(LeftPreRelease);
    RightIdentifier := NextPreReleaseIdentifier(RightPreRelease);
    LeftNumeric := IsNumericIdentifier(LeftIdentifier);
    RightNumeric := IsNumericIdentifier(RightIdentifier);
    if LeftNumeric and RightNumeric then
    begin
      LeftNumber := StrToIntDef(LeftIdentifier, 0);
      RightNumber := StrToIntDef(RightIdentifier, 0);
      if LeftNumber < RightNumber then
      begin
        Result := -1;
        Exit;
      end;
      if LeftNumber > RightNumber then
      begin
        Result := 1;
        Exit;
      end;
    end
    else if LeftNumeric then
    begin
      Result := -1;
      Exit;
    end
    else if RightNumeric then
    begin
      Result := 1;
      Exit;
    end
    else
    begin
      Comparison := CompareText(LeftIdentifier, RightIdentifier);
      if Comparison < 0 then
      begin
        Result := -1;
        Exit;
      end;
      if Comparison > 0 then
      begin
        Result := 1;
        Exit;
      end;
    end;
  end;
end;

function CompareVersions(LeftVersion, RightVersion: String): Integer;
var
  Index: Integer;
  LeftPart, RightPart: Integer;
  LeftCore, RightCore, LeftPreRelease, RightPreRelease: String;
begin
  ParseVersion(LeftVersion, LeftCore, LeftPreRelease);
  ParseVersion(RightVersion, RightCore, RightPreRelease);
  Result := 0;
  for Index := 1 to 3 do
  begin
    LeftPart := NumericVersionPart(LeftCore);
    RightPart := NumericVersionPart(RightCore);
    if LeftPart < RightPart then
    begin
      Result := -1;
      Exit;
    end;
    if LeftPart > RightPart then
    begin
      Result := 1;
      Exit;
    end;
  end;
  Result := ComparePreRelease(LeftPreRelease, RightPreRelease);
end;

function DirectoryIsWritable(const Directory: String): Boolean;
var
  ProbePath: String;
  DirectoryCreated: Boolean;
begin
  Log('Checking whether the installation directory is writable: ' + Directory);
  Result := False;
  DirectoryCreated := not DirExists(Directory);
  if DirectoryCreated and (not ForceDirectories(Directory)) then
  begin
    Log('Could not create the installation directory');
    Exit;
  end;

  ProbePath := AddBackslash(Directory) + '.vpaste-write-test-' +
    GetDateTimeString('yyyymmddhhnnsszzz', #0, #0);
  if not SaveStringToFile(ProbePath, 'vpaste', False) then
  begin
    Log('Could not write the installation directory probe file');
    if DirectoryCreated then
      RemoveDir(Directory);
    Exit;
  end;

  DeleteFile(ProbePath);
  if DirectoryCreated then
    RemoveDir(Directory);
  Result := True;
  Log('The installation directory is writable');
end;

procedure DetectExistingInstallation;
var
  Subkeys: TArrayOfString;
  Index: Integer;
  DisplayName, InstallLocation, CandidateVersion: String;
begin
  ExistingVersion := '';
  LegacyUninstallKey := '';
  if RegQueryStringValue(HKCU, NewUninstallKey, 'InstallLocation', InstallLocation) and
     FileExists(AddBackslash(InstallLocation) + 'vPaste.exe') then
  begin
    if not RegQueryStringValue(HKCU, NewUninstallKey, 'DisplayVersion', CandidateVersion) then
      if not GetVersionNumbersString(
        AddBackslash(InstallLocation) + 'vPaste.exe', CandidateVersion) then
        CandidateVersion := '{#AppVersion}';
    ExistingVersion := CandidateVersion;
    WizardForm.DirEdit.Text := RemoveBackslashUnlessRoot(InstallLocation);
    Exit;
  end;

  if not RegGetSubkeyNames(HKCU, LegacyUninstallRoot, Subkeys) then
    Exit;
  for Index := 0 to GetArrayLength(Subkeys) - 1 do
  begin
    if CompareText(
      LegacyUninstallRoot + '\' + Subkeys[Index],
      NewUninstallKey) = 0 then
      Continue;
    if RegQueryStringValue(HKCU, LegacyUninstallRoot + '\' + Subkeys[Index], 'DisplayName', DisplayName) and
       (CompareText(DisplayName, 'vPaste') = 0) and
       RegQueryStringValue(HKCU, LegacyUninstallRoot + '\' + Subkeys[Index], 'InstallLocation', InstallLocation) and
       FileExists(AddBackslash(InstallLocation) + 'vPaste.exe') then
    begin
      LegacyUninstallKey := LegacyUninstallRoot + '\' + Subkeys[Index];
      if RegQueryStringValue(HKCU, LegacyUninstallKey, 'DisplayVersion', CandidateVersion) then
        ExistingVersion := CandidateVersion;
      WizardForm.DirEdit.Text := RemoveBackslashUnlessRoot(InstallLocation);
      Exit;
    end;
  end;
end;

procedure BrowseForInstallDirectory(Sender: TObject);
var
  SelectedDirectory: String;
begin
  SelectedDirectory := DirectoryEdit.Text;
  if BrowseForFolder(Localized('选择安装目录', 'Choose installation folder'), SelectedDirectory, False) then
  begin
    SelectedDirectory := RemoveBackslashUnlessRoot(SelectedDirectory);
    if CompareText(ExtractFileName(SelectedDirectory), 'vPaste') <> 0 then
      SelectedDirectory := AddBackslash(SelectedDirectory) + 'vPaste';
    DirectoryEdit.Text := SelectedDirectory;
  end;
  WizardForm.ActiveControl := DirectoryEdit;
end;

procedure CloseWizard(Sender: TObject);
begin
  if WizardForm.CurPageID = wpFinished then
    SendMessage(WizardForm.NextButton.Handle, $00F5, 0, 0)
  else
    WizardForm.Close;
end;

procedure ApplyRoundedRegion(Control: TWinControl; const Radius: Integer);
var
  Region: Integer;
begin
  Region := CreateRoundRectRgn(
    0, 0, Control.Width + 1, Control.Height + 1, ScaleX(Radius * 2), ScaleY(Radius * 2));
  SetWindowRgn(Control.Handle, Region, True);
end;

procedure ApplyFormChrome(Form: TSetupForm);
var
  CornerPreference: Integer;
begin
  SetClassLong(
    Form.Handle,
    GCLStyle,
    GetClassLong(Form.Handle, GCLStyle) or CSDropShadow);
  CornerPreference := DwmRoundCorners;
  DwmSetWindowAttribute(
    Form.Handle,
    DwmWindowCornerPreference,
    CornerPreference,
    SizeOf(CornerPreference));
end;

function BodySurfaceColor: TColor;
begin
  if IsDarkInstallMode then
    Result := BodySurfaceDark
  else
    Result := BodySurfaceLight;
end;

function InputSurfaceColor: TColor;
begin
  if IsDarkInstallMode then
    Result := InputSurfaceDark
  else
    Result := InputSurfaceLight;
end;

function AssetPath(const Name: String): String;
begin
  Result := ExpandConstant('{tmp}\') + Name;
end;

procedure CreateSetupCloseButton(
  var Image: TBitmapImage;
  Parent: TWinControl);
begin
  Image := TBitmapImage.Create(WizardForm);
  Image.Parent := Parent;
  Image.SetBounds(ScaleX(433), ScaleY(7), ScaleX(34), ScaleY(34));
  Image.Cursor := crHand;
  Image.BackColor := clNone;
  Image.Center := True;
  Image.Stretch := True;
  if IsDarkInstallMode then
    Image.PngImage.LoadFromFile(AssetPath('close-dark.png'))
  else
    Image.PngImage.LoadFromFile(AssetPath('close-light.png'));
  Image.OnClick := @CloseWizard;
  Image.BringToFront;
end;

procedure LoadButtonImageFromFile(
  Button: TBitmapImage;
  const FileName, AccessibleCaption: String);
begin
  Button.Hint := AccessibleCaption;
  Button.BackColor := clNone;
  Button.Center := True;
  Button.Stretch := True;
  Button.PngImage.LoadFromFile(FileName);
end;

procedure LoadButtonImage(
  Button: TBitmapImage;
  const Name, AccessibleCaption: String);
begin
  LoadButtonImageFromFile(Button, AssetPath(Name), AccessibleCaption);
end;

procedure SizeBackgroundToCover(
  Image: TBitmapImage;
  const TargetWidth, TargetHeight, VerticalAnchorHeight: Integer);
var
  DrawWidth, DrawHeight: Integer;
begin
  DrawWidth := TargetWidth;
  DrawHeight := (DrawWidth * BackgroundDesignHeight) div BackgroundDesignWidth;
  if DrawHeight < TargetHeight then
  begin
    DrawHeight := TargetHeight;
    DrawWidth := (DrawHeight * BackgroundDesignWidth) div BackgroundDesignHeight;
  end;
  Image.SetBounds(
    (TargetWidth - DrawWidth) div 2,
    (VerticalAnchorHeight - DrawHeight) div 2,
    DrawWidth,
    DrawHeight);
end;

procedure SetInstallerHeight(const Height: Integer);
begin
  WizardForm.ClientHeight := ScaleY(Height);
  WindowBorder.SetBounds(0, 0, WizardForm.ClientWidth, WizardForm.ClientHeight);
  WizardForm.OuterNotebook.SetBounds(
    ScaleX(1), ScaleY(1), WizardForm.ClientWidth - ScaleX(2), WizardForm.ClientHeight - ScaleY(2));
  WizardForm.InnerNotebook.SetBounds(
    0, 0, WizardForm.ClientWidth - ScaleX(2), WizardForm.ClientHeight - ScaleY(2));
  if WelcomeBackground <> nil then
    SizeBackgroundToCover(
      WelcomeBackground,
      WizardForm.InnerNotebook.Width,
      WizardForm.InnerNotebook.Height,
      ScaleY(CollapsedHeight) - ScaleY(2));
  if InstallingBackground <> nil then
    SizeBackgroundToCover(
      InstallingBackground,
      WizardForm.InnerNotebook.Width,
      WizardForm.InnerNotebook.Height,
      ScaleY(CollapsedHeight) - ScaleY(2));
  if FinishedBackground <> nil then
    SizeBackgroundToCover(
      FinishedBackground,
      WizardForm.InnerNotebook.Width,
      WizardForm.InnerNotebook.Height,
      ScaleY(CollapsedHeight) - ScaleY(2));
  if WelcomeBackground <> nil then
    WelcomeBackground.Top := WelcomeBackground.Top + ScaleY(SetupBackgroundVerticalOffset);
  if InstallingBackground <> nil then
    InstallingBackground.Top := InstallingBackground.Top + ScaleY(SetupBackgroundVerticalOffset);
  if FinishedBackground <> nil then
    FinishedBackground.Top := FinishedBackground.Top + ScaleY(SetupBackgroundVerticalOffset);
end;

procedure RepaintAdvancedArea;
begin
  WelcomeBackground.Repaint;
  WizardForm.WelcomePage.Repaint;
  if AdvancedPanel.Visible then
  begin
    AdvancedPanel.Repaint;
    DirectoryLabel.Repaint;
    DirectoryEditFrame.Repaint;
    DirectoryEdit.Repaint;
    BrowseButton.Repaint;
    DesktopCheck.Repaint;
  end;
end;

procedure ToggleAdvanced(Sender: TObject);
var
  ExpandAdvanced: Boolean;
begin
  ExpandAdvanced := not AdvancedPanel.Visible;
  SendMessage(WizardForm.Handle, WMSetRedraw, 0, 0);
  SendMessage(WizardForm.WelcomePage.Handle, WMSetRedraw, 0, 0);
  if ExpandAdvanced then
  begin
    SetInstallerHeight(ExpandedHeight);
    AdvancedPanel.Visible := True;
    LoadButtonImage(
      CustomButton,
      Localized('custom-expanded-zh.png', 'custom-expanded-en.png'),
      Localized('收起选项', 'Hide options'));
    CustomAccessButton.Caption := Localized('收起选项', 'Hide options');
  end
  else
  begin
    AdvancedPanel.Visible := False;
    LoadButtonImage(
      CustomButton,
      Localized('custom-collapsed-zh.png', 'custom-collapsed-en.png'),
      Localized('自定义安装', 'Custom install'));
    CustomAccessButton.Caption := Localized('自定义安装', 'Custom install');
    SetInstallerHeight(CollapsedHeight);
  end;
  WizardForm.ActiveControl := InteractionFocusSink;
  SendMessage(
    WizardForm.Handle, WMUpdateUIState, HideFocusUIState, 0);
  WelcomeCloseButton.BringToFront;
  SendMessage(WizardForm.WelcomePage.Handle, WMSetRedraw, 1, 0);
  SendMessage(WizardForm.Handle, WMSetRedraw, 1, 0);
  RepaintAdvancedArea;
end;

procedure HandleWizardKeyDown(
  Sender: TObject; var Key: Word; Shift: TShiftState);
begin
  if (WizardForm.CurPageID = wpFinished) and
     ((Key = 13) or (Key = 32)) then
  begin
    SendMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
    Key := 0;
    Exit;
  end;
end;

procedure LoadBackground(Image: TBitmapImage; Parent: TWinControl);
var
  BackgroundFile: String;
begin
  if IsDarkInstallMode then
    BackgroundFile := '{#InstallerBackgroundDark}'
  else
    BackgroundFile := '{#InstallerBackgroundLight}';
  Image.Parent := Parent;
  SizeBackgroundToCover(
    Image,
    WizardForm.InnerNotebook.Width,
    WizardForm.InnerNotebook.Height,
    ScaleY(CollapsedHeight) - ScaleY(2));
  Image.Top := Image.Top + ScaleY(SetupBackgroundVerticalOffset);
  Image.Stretch := True;
  Image.PngImage.LoadFromFile(
    ExpandConstant('{tmp}\') + ExtractFileName(BackgroundFile));
  Image.SendToBack;
end;

procedure LoadLogo(Image: TBitmapImage; const Size, Top: Integer; Parent: TWinControl);
begin
  Image.Parent := Parent;
  Image.SetBounds((WizardForm.ClientWidth - ScaleX(Size)) div 2, ScaleY(Top), ScaleX(Size), ScaleY(Size));
  Image.BackColor := clNone;
  Image.Center := True;
  Image.Stretch := True;
  Image.PngImage.LoadFromFile(ExpandConstant('{tmp}\') + ExtractFileName('{#InstallerLogo}'));
end;

procedure ConfigureNativeProgressControls(const ShowProgress: Boolean);
begin
  WizardForm.StatusLabel.Visible := False;
  WizardForm.StatusLabel.SetBounds(-ScaleX(1000), -ScaleY(1000), 1, 1);
  WizardForm.FilenameLabel.Visible := False;
  WizardForm.FilenameLabel.SetBounds(-ScaleX(1000), -ScaleY(1000), 1, 1);
  WizardForm.ProgressGauge.Visible := ShowProgress;
  if ShowProgress then
    WizardForm.ProgressGauge.SetBounds(
      ScaleX(60), ScaleY(212), ScaleX(360), ScaleY(14))
  else
    WizardForm.ProgressGauge.SetBounds(-ScaleX(1000), -ScaleY(1000), 1, 1);
end;

procedure ContinueInstallation(Sender: TObject);
begin
  SendMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
end;

procedure ConfigureQuickInstallButton;
var
  AssetName, AccessibleCaption: String;
begin
  QuickInstallButton.SetBounds(
    ScaleX(60), ScaleY(165), ScaleX(360), ScaleY(62));
  if ExistingVersion = '' then
  begin
    AssetName := Localized('action-quick-zh.png', 'action-quick-en.png');
    AccessibleCaption := Localized('快速安装', 'Quick install');
  end
  else if CompareVersions(ExistingVersion, '{#AppVersion}') = 0 then
  begin
    AssetName := Localized('action-repair-zh.png', 'action-repair-en.png');
    AccessibleCaption := Localized('修复安装', 'Repair');
  end
  else
  begin
    AssetName := Localized('action-update-zh.png', 'action-update-en.png');
    AccessibleCaption := Localized('更新到 {#AppVersion}', 'Update to {#AppVersion}');
  end;
  LoadButtonImage(QuickInstallButton, AssetName, AccessibleCaption);
  QuickInstallAccessButton.Caption := AccessibleCaption;
end;

procedure ConfigureFinishedPage;
begin
  SetInstallerHeight(FinishedHeight);
  FinishButton.SetBounds(ScaleX(60), ScaleY(145), ScaleX(360), ScaleY(62));
  LoadButtonImage(
    FinishButton,
    Localized('action-finish-zh.png', 'action-finish-en.png'),
    Localized('运行 vPaste', 'Run vPaste'));
  FinishAccessButton.Caption := Localized('运行 vPaste', 'Run vPaste');
  WizardForm.FinishedHeadingLabel.Visible := False;
  WizardForm.FinishedLabel.Visible := False;
  WizardForm.RunList.Visible := False;
end;

procedure ExtractInstallerAssets;
begin
  ExtractTemporaryFile(ExtractFileName('{#InstallerLogo}'));
  ExtractTemporaryFile('installer-background-light.png');
  ExtractTemporaryFile('installer-background-dark.png');
  ExtractTemporaryFile('close-light.png');
  ExtractTemporaryFile('close-dark.png');
  ExtractTemporaryFile('action-quick-zh.png');
  ExtractTemporaryFile('action-quick-en.png');
  ExtractTemporaryFile('action-repair-zh.png');
  ExtractTemporaryFile('action-repair-en.png');
  ExtractTemporaryFile('action-update-zh.png');
  ExtractTemporaryFile('action-update-en.png');
  ExtractTemporaryFile('action-finish-zh.png');
  ExtractTemporaryFile('action-finish-en.png');
  ExtractTemporaryFile('custom-collapsed-zh.png');
  ExtractTemporaryFile('custom-collapsed-en.png');
  ExtractTemporaryFile('custom-expanded-zh.png');
  ExtractTemporaryFile('custom-expanded-en.png');
  ExtractTemporaryFile('browse-zh.png');
  ExtractTemporaryFile('browse-en.png');
  ExtractTemporaryFile('browse-zh-dark.png');
  ExtractTemporaryFile('browse-en-dark.png');
end;

procedure InitializeWizard;
begin
  ExtractInstallerAssets;
  DetectExistingInstallation;

  WizardForm.BorderStyle := bsNone;
  WizardForm.ClientWidth := ScaleX(WindowWidth);
  ApplyFormChrome(WizardForm);
  WindowBorder := TPanel.Create(WizardForm);
  WindowBorder.Parent := WizardForm;
  WindowBorder.BevelOuter := bvNone;
  if IsDarkInstallMode then
    WindowBorder.Color := BorderDark
  else
    WindowBorder.Color := BorderLight;
  WindowBorder.Enabled := False;
  WindowBorder.SendToBack;
  SetInstallerHeight(CollapsedHeight);
  WizardForm.Caption := '';
  WizardForm.MainPanel.Visible := False;
  WizardForm.Bevel1.Visible := False;
  WizardForm.BeveledLabel.Visible := False;
  WizardForm.BackButton.Visible := False;
  WizardForm.CancelButton.Visible := True;
  WizardForm.CancelButton.Left := -WizardForm.CancelButton.Width - ScaleX(16);
  WizardForm.CancelButton.TabStop := False;
  WizardForm.NextButton.Visible := WizardSilent;
  WizardForm.WelcomeLabel1.Visible := False;
  WizardForm.WelcomeLabel2.Visible := False;
  WizardForm.WizardBitmapImage.Visible := False;
  WizardForm.WizardBitmapImage2.Visible := False;
  WizardForm.KeyPreview := True;
  WizardForm.OnKeyDown := @HandleWizardKeyDown;

  InteractionFocusSink := TNewEdit.Create(WizardForm);
  InteractionFocusSink.Parent := WizardForm;
  InteractionFocusSink.SetBounds(0, 0, ScaleX(1), ScaleY(1));
  InteractionFocusSink.TabOrder := 0;
  InteractionFocusSink.TabStop := True;

  WelcomeBackground := TBitmapImage.Create(WizardForm);
  WizardForm.WelcomePage.Color := BodySurfaceColor;
  LoadBackground(WelcomeBackground, WizardForm.WelcomePage);
  InstallingBackground := TBitmapImage.Create(WizardForm);
  WizardForm.InstallingPage.Color := BodySurfaceColor;
  LoadBackground(InstallingBackground, WizardForm.InstallingPage);
  FinishedBackground := TBitmapImage.Create(WizardForm);
  WizardForm.FinishedPage.Color := BodySurfaceColor;
  LoadBackground(FinishedBackground, WizardForm.FinishedPage);

  CreateSetupCloseButton(WelcomeCloseButton, WizardForm.WelcomePage);
  CreateSetupCloseButton(InstallingCloseButton, WizardForm.InstallingPage);
  CreateSetupCloseButton(FinishedCloseButton, WizardForm.FinishedPage);

  LogoImage := TBitmapImage.Create(WizardForm);
  LoadLogo(LogoImage, 88, 48, WizardForm.WelcomePage);

  QuickInstallButton := TBitmapImage.Create(WizardForm);
  QuickInstallButton.Parent := WizardForm.WelcomePage;
  QuickInstallButton.OnClick := @ContinueInstallation;
  QuickInstallButton.Cursor := crHand;
  QuickInstallAccessButton := TNewButton.Create(WizardForm);
  QuickInstallAccessButton.Parent := WizardForm.WelcomePage;
  QuickInstallAccessButton.SetBounds(
    -ScaleX(1000), -ScaleY(1000), ScaleX(1), ScaleY(1));
  QuickInstallAccessButton.OnClick := @ContinueInstallation;
  QuickInstallAccessButton.TabOrder := 1;
  QuickInstallAccessButton.TabStop := True;
  ConfigureQuickInstallButton;

  CustomButton := TBitmapImage.Create(WizardForm);
  CustomButton.Parent := WizardForm.WelcomePage;
  CustomButton.SetBounds(ScaleX(60), ScaleY(250), ScaleX(360), ScaleY(40));
  CustomButton.Cursor := crHand;
  CustomButton.OnClick := @ToggleAdvanced;
  CustomAccessButton := TNewButton.Create(WizardForm);
  CustomAccessButton.Parent := WizardForm.WelcomePage;
  CustomAccessButton.SetBounds(
    -ScaleX(1000), -ScaleY(1000), ScaleX(1), ScaleY(1));
  CustomAccessButton.Caption := Localized('自定义安装', 'Custom install');
  CustomAccessButton.OnClick := @ToggleAdvanced;
  CustomAccessButton.TabOrder := 2;
  CustomAccessButton.TabStop := True;
  LoadButtonImage(
    CustomButton,
    Localized('custom-collapsed-zh.png', 'custom-collapsed-en.png'),
    Localized('自定义安装', 'Custom install'));

  AdvancedPanel := TPanel.Create(WizardForm);
  AdvancedPanel.Parent := WizardForm.WelcomePage;
  AdvancedPanel.SetBounds(ScaleX(60), ScaleY(298), ScaleX(360), ScaleY(94));
  AdvancedPanel.BevelOuter := bvNone;
  AdvancedPanel.Color := BodySurfaceColor;
  AdvancedPanel.Visible := False;

  DirectoryLabel := TNewStaticText.Create(WizardForm);
  DirectoryLabel.Parent := AdvancedPanel;
  DirectoryLabel.SetBounds(0, 0, ScaleX(360), ScaleY(20));
  DirectoryLabel.Caption := Localized('安装目录', 'Installation folder');
  DirectoryLabel.Color := AdvancedPanel.Color;

  DirectoryEditFrame := TPanel.Create(WizardForm);
  DirectoryEditFrame.Parent := AdvancedPanel;
  DirectoryEditFrame.SetBounds(0, ScaleY(24), ScaleX(270), ScaleY(34));
  DirectoryEditFrame.BevelOuter := bvNone;
  DirectoryEditFrame.Color := InputSurfaceColor;
  ApplyRoundedRegion(DirectoryEditFrame, 7);

  DirectoryEdit := TNewEdit.Create(WizardForm);
  DirectoryEdit.Parent := DirectoryEditFrame;
  DirectoryEdit.AutoSize := True;
  DirectoryEdit.BorderStyle := bsNone;
  DirectoryEdit.Color := DirectoryEditFrame.Color;
  DirectoryEdit.Left := ScaleX(10);
  DirectoryEdit.Width := DirectoryEditFrame.ClientWidth - ScaleX(20);
  DirectoryEdit.Top := (DirectoryEditFrame.ClientHeight - DirectoryEdit.Height) div 2;
  DirectoryEdit.Text := WizardDirValue;

  BrowseButton := TBitmapImage.Create(WizardForm);
  BrowseButton.Parent := AdvancedPanel;
  BrowseButton.SetBounds(ScaleX(280), ScaleY(24), ScaleX(80), ScaleY(34));
  BrowseButton.Cursor := crHand;
  BrowseButton.OnClick := @BrowseForInstallDirectory;
  BrowseAccessButton := TNewButton.Create(WizardForm);
  BrowseAccessButton.Parent := AdvancedPanel;
  BrowseAccessButton.SetBounds(
    -ScaleX(1000), -ScaleY(1000), ScaleX(1), ScaleY(1));
  BrowseAccessButton.Caption := Localized('浏览', 'Browse');
  BrowseAccessButton.OnClick := @BrowseForInstallDirectory;
  BrowseAccessButton.TabOrder := 1;
  BrowseAccessButton.TabStop := True;
  if IsDarkInstallMode then
    LoadButtonImage(
      BrowseButton,
      Localized('browse-zh-dark.png', 'browse-en-dark.png'),
      Localized('浏览', 'Browse'))
  else
    LoadButtonImage(
      BrowseButton,
      Localized('browse-zh.png', 'browse-en.png'),
      Localized('浏览', 'Browse'));

  DesktopCheck := TNewCheckBox.Create(WizardForm);
  DesktopCheck.Parent := AdvancedPanel;
  DesktopCheck.SetBounds(0, ScaleY(66), ScaleX(360), ScaleY(26));
  DesktopCheck.Caption := Localized('创建桌面快捷方式', 'Create a desktop shortcut');
  DesktopCheck.Checked := False;

  InstallLogoImage := TBitmapImage.Create(WizardForm);
  LoadLogo(InstallLogoImage, 84, 48, WizardForm.InstallingPage);

  InstallTitleLabel := TNewStaticText.Create(WizardForm);
  InstallTitleLabel.Parent := WizardForm.InstallingPage;
  InstallTitleLabel.SetBounds(ScaleX(40), ScaleY(155), ScaleX(400), ScaleY(28));
  InstallTitleLabel.Alignment := taCenter;
  InstallTitleLabel.AutoSize := False;
  InstallTitleLabel.Caption := Localized('正在安装 vPaste', 'Installing vPaste');
  InstallTitleLabel.Font.Size := 14;
  InstallTitleLabel.Font.Style := [fsBold];
  InstallTitleLabel.Font.Color := WizardForm.WelcomeLabel1.Font.Color;
  InstallTitleLabel.Color := BodySurfaceColor;

  ConfigureNativeProgressControls(False);

  FinishLogoImage := TBitmapImage.Create(WizardForm);
  LoadLogo(FinishLogoImage, 80, 35, WizardForm.FinishedPage);

  FinishButton := TBitmapImage.Create(WizardForm);
  FinishButton.Parent := WizardForm.FinishedPage;
  FinishButton.OnClick := @ContinueInstallation;
  FinishButton.Cursor := crHand;
  FinishButton.Visible := False;
  FinishAccessButton := TNewButton.Create(WizardForm);
  FinishAccessButton.Parent := WizardForm.FinishedPage;
  FinishAccessButton.SetBounds(
    -ScaleX(1000), -ScaleY(1000), ScaleX(1), ScaleY(1));
  FinishAccessButton.OnClick := @ContinueInstallation;
  FinishAccessButton.TabOrder := 1;
  FinishAccessButton.TabStop := True;
  ConfigureFinishedPage;
end;

function RequestExistingAppExit: Boolean;
  forward;

procedure ShowInstallPreparation;
begin
  WizardForm.InnerNotebook.ActivePage := WizardForm.InstallingPage;
  WelcomeCloseButton.Visible := False;
  InstallingCloseButton.Visible := True;
  ConfigureNativeProgressControls(True);
  InstallingCloseButton.BringToFront;
  WizardForm.InstallingPage.Repaint;
  WizardForm.Update;
end;

procedure RestoreWelcomePage;
begin
  WizardForm.InnerNotebook.ActivePage := WizardForm.WelcomePage;
  InstallingCloseButton.Visible := False;
  WelcomeCloseButton.Visible := True;
  ConfigureNativeProgressControls(False);
  if AdvancedPanel.Visible then
    SetInstallerHeight(ExpandedHeight)
  else
    SetInstallerHeight(CollapsedHeight);
  WelcomeCloseButton.BringToFront;
  WizardForm.Update;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExistingExecutable: String;
  WindowsVersion: TWindowsVersion;
  IsDowngrade: Boolean;
begin
  Result := True;
  if CurPageID <> wpWelcome then
    Exit;

  Log('Validating quick installation settings');

  GetWindowsVersionEx(WindowsVersion);
  if (WindowsVersion.Major < 10) or
     ((WindowsVersion.Major = 10) and (WindowsVersion.Build < 19045)) then
  begin
    MsgBox(Localized(
      'vPaste 支持 Windows 10 22H2 和 Windows 11',
      'vPaste supports Windows 10 22H2 and Windows 11'), mbError, MB_OK);
    Result := False;
    Exit;
  end;

  IsDowngrade := (ExistingVersion <> '') and
    (CompareVersions(ExistingVersion, '{#AppVersion}') > 0);
  if IsDowngrade then
  begin
    if (not CommandLineSwitchExists('ALLOWDOWNGRADE')) or WizardSilent then
    begin
      MsgBox(Localized(
        '检测到更高版本，安装器已阻止降级',
        'A newer version is installed. Downgrade has been blocked'), mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if MsgBox(Localized(
      '降级可能导致配置不兼容，确定继续吗？',
      'Downgrading may make settings incompatible. Continue?'),
      mbConfirmation, MB_YESNO) <> IDYES then
    begin
      Result := False;
      Exit;
    end;
  end;

  if Trim(DirectoryEdit.Text) = '' then
  begin
    MsgBox(Localized('请选择安装目录', 'Choose an installation folder'), mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if not DirectoryIsWritable(RemoveBackslashUnlessRoot(DirectoryEdit.Text)) then
  begin
    MsgBox(Localized(
      '当前用户无法写入这个安装目录，请选择其他位置',
      'The current user cannot write to this installation folder. Choose another location'),
      mbError, MB_OK);
    Result := False;
    Exit;
  end;

  WizardForm.DirEdit.Text := RemoveBackslashUnlessRoot(DirectoryEdit.Text);
  CreateDesktopShortcut := DesktopCheck.Checked;

  ExistingExecutable :=
    AddBackslash(RemoveBackslashUnlessRoot(WizardForm.DirEdit.Text)) +
    'vPaste.exe';
  if FileExists(ExistingExecutable) and (not ExistingAppPrepared) then
  begin
    ShowInstallPreparation;
    if not RequestExistingAppExit then
    begin
      RestoreWelcomePage;
      MsgBox(Localized(
        '无法关闭正在运行的 vPaste，请从托盘退出后重试',
        'The running vPaste could not be closed. Quit it from the tray and retry'),
        mbError, MB_OK);
      Result := False;
      Exit;
    end;
    ExistingAppPrepared := True;
  end;
  Log('Quick installation settings are valid');
end;

function RequestExistingAppExit: Boolean;
var
  TaskKillExitCode: Integer;
  CurrentUser: String;
  TaskFilter: String;
begin
  CurrentUser := GetEnv('USERNAME');
  if GetEnv('USERDOMAIN') <> '' then
    CurrentUser := GetEnv('USERDOMAIN') + '\' + CurrentUser;
  TaskFilter := '/F /T /FI "USERNAME eq ' + CurrentUser + '" /IM "vPaste.exe"';
  Result := Exec(
    ExpandConstant('{sys}\taskkill.exe'),
    TaskFilter,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    TaskKillExitCode) and
    ((TaskKillExitCode = 0) or (TaskKillExitCode = 128));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExistingExecutable: String;
begin
  Result := EnsureWebView2;
  if Result <> '' then
    Exit;

  ExistingExecutable := ExpandConstant('{app}\vPaste.exe');
  if FileExists(ExistingExecutable) then
  begin
    if (not ExistingAppPrepared) and (not RequestExistingAppExit) then
    begin
      Result := Localized(
        '无法关闭正在运行的 vPaste，请从托盘退出后重试',
        'The running vPaste could not be closed. Quit it from the tray and retry');
      Exit;
    end;
    ExistingAppPrepared := True;
    PreviousExecutableBackup := ExpandConstant('{tmp}\vPaste-previous.exe');
    if not CopyFile(ExistingExecutable, PreviousExecutableBackup, False) then
    begin
      PreviousExecutableBackup := '';
      Result := Localized(
        '无法备份当前版本，安装已停止。请关闭 vPaste 后重试',
        'The current version could not be backed up. Close vPaste and retry');
      Exit;
    end;
  end;
end;

procedure RemoveLegacyInstallationRegistration;
begin
  if LegacyUninstallKey <> '' then
    RegDeleteKeyIncludingSubkeys(HKCU, LegacyUninstallKey);
  DeleteFile(ExpandConstant('{app}\uninstall.exe'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    InstallCompleted := True;
    RemoveLegacyInstallationRegistration;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  WizardForm.MainPanel.Visible := False;
  WizardForm.Bevel1.Visible := False;
  WizardForm.BackButton.Visible := False;
  WizardForm.CancelButton.Visible := True;
  WizardForm.CancelButton.Left := -WizardForm.CancelButton.Width - ScaleX(16);
  WizardForm.CancelButton.TabStop := False;
  WizardForm.NextButton.Visible := WizardSilent;
  WelcomeCloseButton.Visible := CurPageID = wpWelcome;
  InstallingCloseButton.Visible := CurPageID = wpInstalling;
  FinishedCloseButton.Visible := CurPageID = wpFinished;
  QuickInstallButton.Visible := CurPageID = wpWelcome;
  FinishButton.Visible := CurPageID = wpFinished;
  ConfigureNativeProgressControls(CurPageID = wpInstalling);

  if CurPageID = wpWelcome then
  begin
    if AdvancedPanel.Visible then
      SetInstallerHeight(ExpandedHeight)
    else
      SetInstallerHeight(CollapsedHeight);
    ConfigureQuickInstallButton;
    WizardForm.ActiveControl := InteractionFocusSink;
  end
  else if CurPageID = wpInstalling then
    SetInstallerHeight(InstallingHeight)
  else if CurPageID = wpFinished then
  begin
    ConfigureFinishedPage;
    WizardForm.ActiveControl := InteractionFocusSink;
  end
  else if CurPageID = wpPreparing then
  begin
    SetInstallerHeight(NativeFallbackHeight);
    WizardForm.OuterNotebook.Height :=
      WizardForm.ClientHeight - ScaleY(64);
    WizardForm.InnerNotebook.Height := WizardForm.OuterNotebook.Height;
    WizardForm.NextButton.Visible := True;
    WizardForm.NextButton.SetBounds(
      ScaleX(250),
      WizardForm.ClientHeight - ScaleY(52),
      ScaleX(170),
      ScaleY(38));
    WizardForm.NextButton.TabStop := True;
    WizardForm.NextButton.BringToFront;
    WizardForm.CancelButton.SetBounds(
      ScaleX(60),
      WizardForm.ClientHeight - ScaleY(52),
      ScaleX(120),
      ScaleY(38));
    WizardForm.CancelButton.TabStop := True;
    WizardForm.CancelButton.BringToFront;
  end
  else
  begin
    SetInstallerHeight(CollapsedHeight);
    WizardForm.NextButton.Visible := True;
    WizardForm.NextButton.Style := bsPushButton;
    WizardForm.NextButton.CommandLinkHint := '';
    WizardForm.NextButton.SetBounds(ScaleX(90), ScaleY(235), ScaleX(280), ScaleY(42));
    WizardForm.NextButton.Font.Size := 10;
    WizardForm.NextButton.Font.Style := [];
  end;
  if CurPageID = wpWelcome then
    WelcomeCloseButton.BringToFront
  else if CurPageID = wpInstalling then
    InstallingCloseButton.BringToFront
  else if CurPageID = wpFinished then
    FinishedCloseButton.BringToFront;
  SendMessage(
    WizardForm.Handle, WMUpdateUIState, HideFocusUIState, 0);
end;

procedure DeinitializeSetup;
begin
  if (not InstallCompleted) and (PreviousExecutableBackup <> '') and
     FileExists(PreviousExecutableBackup) then
    CopyFile(PreviousExecutableBackup, ExpandConstant('{app}\vPaste.exe'), False);
end;

function LoadUninstallDataManifest: Boolean;
var
  ManifestPath: String;
  ExitCode: Integer;
begin
  Result := False;
  ManifestPath := ExpandConstant('{tmp}\vpaste-uninstall-data.ini');
  if not Exec(
    ExpandConstant('{app}\vPaste.exe'),
    '--export-uninstall-data="' + ManifestPath + '"',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or
    (ExitCode <> 0) or (not FileExists(ManifestPath)) then
    Exit;

  UninstallAppDataDir := GetIniString('Data', 'AppDataDir', '', ManifestPath);
  UninstallHistoryDir := GetIniString('Data', 'HistoryStorageDir', '', ManifestPath);
  UninstallCustomHistory := GetIniString('Data', 'CustomHistoryStorage', '0', ManifestPath) = '1';
  Result := UninstallAppDataDir <> '';
end;

procedure CloseUninstallPrompt(Sender: TObject);
begin
  UninstallPromptConfirmed := False;
  UninstallPromptForm.Close;
end;

procedure ConfirmUninstallPrompt(Sender: TObject);
begin
  UninstallPromptConfirmed := True;
  UninstallPromptForm.Close;
end;

procedure HandleUninstallPromptKeyDown(
  Sender: TObject; var Key: Word; Shift: TShiftState);
begin
  if (UninstallPromptForm.ActiveControl = UninstallPromptFocusSink) and
     ((Key = 13) or (Key = 32)) then
  begin
    ConfirmUninstallPrompt(Sender);
    Key := 0;
  end;
end;

procedure HandleUninstallPromptShow(Sender: TObject);
begin
  UninstallPromptForm.ClientWidth := ScaleX(WindowWidth);
  UninstallPromptForm.ClientHeight := ScaleY(UninstallHeight);
  UninstallPromptForm.ActiveControl := UninstallPromptFocusSink;
  SendMessage(
    UninstallPromptForm.Handle,
    WMUpdateUIState,
    HideFocusUIState,
    0);
end;

function PromptForDataRemoval: Boolean;
var
  CheckWidth: Integer;
  Form: TSetupForm;
  Background, Logo, CloseImage: TBitmapImage;
  DeleteDataCheck: TNewCheckBox;
  DeleteDataMeasureLabel: TNewStaticText;
  RemoveButton: TBitmapImage;
  RemoveAccessButton, CancelButton: TNewButton;
  AssetRoot, BackgroundName, UninstallButtonName: String;
begin
  Result := False;
  Form := CreateCustomForm(
    ScaleX(WindowWidth), ScaleY(UninstallHeight), True, True);
  try
    UninstallPromptForm := Form;
    UninstallPromptConfirmed := False;
    Form.Caption := Localized('卸载 vPaste', 'Uninstall vPaste');
    Form.BorderStyle := bsNone;
    Form.ClientWidth := ScaleX(WindowWidth);
    Form.ClientHeight := ScaleY(UninstallHeight);
    Form.Position := poScreenCenter;
    Form.Color := BodySurfaceColor;
    ApplyFormChrome(Form);
    Form.Constraints.MinWidth := Form.Width;
    Form.Constraints.MaxWidth := Form.Width;
    Form.Constraints.MinHeight := Form.Height;
    Form.Constraints.MaxHeight := Form.Height;

    AssetRoot := AddBackslash(ExpandConstant('{app}\.installer'));
    if IsDarkInstallMode then
      BackgroundName := 'installer-background-dark.png'
    else
      BackgroundName := 'installer-background-light.png';

    Background := TBitmapImage.Create(Form);
    Background.Parent := Form;
    SizeBackgroundToCover(
      Background, Form.ClientWidth, Form.ClientHeight, Form.ClientHeight);
    Background.Top :=
      Background.Top + ScaleY(SetupBackgroundVerticalOffset);
    Background.Center := True;
    Background.Stretch := True;
    Background.PngImage.LoadFromFile(AssetRoot + BackgroundName);
    Background.SendToBack;

    CloseImage := TBitmapImage.Create(Form);
    CloseImage.Parent := Form;
    CloseImage.SetBounds(ScaleX(433), ScaleY(7), ScaleX(34), ScaleY(34));
    CloseImage.BackColor := clNone;
    CloseImage.Center := True;
    CloseImage.Stretch := True;
    CloseImage.Cursor := crHand;
    if IsDarkInstallMode then
      CloseImage.PngImage.LoadFromFile(AssetRoot + 'close-dark.png')
    else
      CloseImage.PngImage.LoadFromFile(AssetRoot + 'close-light.png');
    CloseImage.OnClick := @CloseUninstallPrompt;

    Logo := TBitmapImage.Create(Form);
    Logo.Parent := Form;
    Logo.SetBounds(ScaleX(202), ScaleY(32), ScaleX(76), ScaleY(76));
    Logo.BackColor := clNone;
    Logo.Center := True;
    Logo.Stretch := True;
    Logo.PngImage.LoadFromFile(AssetRoot + 'logo.png');

    RemoveButton := TBitmapImage.Create(Form);
    RemoveButton.Parent := Form;
    RemoveButton.SetBounds(ScaleX(60), ScaleY(126), ScaleX(360), ScaleY(62));
    RemoveButton.Cursor := crHand;
    RemoveButton.OnClick := @ConfirmUninstallPrompt;
    UninstallButtonName := Localized(
      'action-uninstall-zh.png',
      'action-uninstall-en.png');
    LoadButtonImageFromFile(
      RemoveButton,
      AssetRoot + UninstallButtonName,
      Localized('卸载', 'Uninstall'));
    RemoveAccessButton := TNewButton.Create(Form);
    RemoveAccessButton.Parent := Form;
    RemoveAccessButton.SetBounds(
      -ScaleX(1000), -ScaleY(1000), ScaleX(1), ScaleY(1));
    RemoveAccessButton.Caption := Localized('卸载', 'Uninstall');
    RemoveAccessButton.OnClick := @ConfirmUninstallPrompt;
    RemoveAccessButton.TabOrder := 1;
    RemoveAccessButton.TabStop := True;

    DeleteDataCheck := TNewCheckBox.Create(Form);
    DeleteDataCheck.Parent := Form;
    DeleteDataCheck.Caption := Localized(
      '同时删除历史和设置',
      'Also delete history and settings');

    DeleteDataMeasureLabel := TNewStaticText.Create(Form);
    DeleteDataMeasureLabel.Parent := Form;
    DeleteDataMeasureLabel.Caption := DeleteDataCheck.Caption;
    DeleteDataMeasureLabel.AutoSize := True;
    DeleteDataMeasureLabel.Visible := False;
    CheckWidth :=
      ScaleX(26) + DeleteDataMeasureLabel.Width;

    DeleteDataCheck.SetBounds(
      (Form.ClientWidth - CheckWidth) div 2,
      ScaleY(214),
      CheckWidth,
      ScaleY(20));
    DeleteDataCheck.Color := BodySurfaceColor;
    DeleteDataCheck.Checked := False;
    DeleteDataCheck.TabOrder := 2;

    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.SetBounds(-ScaleX(120), -ScaleY(40), ScaleX(100), ScaleY(30));
    CancelButton.Caption := Localized('取消', 'Cancel');
    CancelButton.Cancel := True;
    CancelButton.TabStop := False;
    CancelButton.ModalResult := mrCancel;

    UninstallPromptFocusSink := TNewEdit.Create(Form);
    UninstallPromptFocusSink.Parent := Form;
    UninstallPromptFocusSink.SetBounds(
      0, 0, ScaleX(1), ScaleY(1));
    UninstallPromptFocusSink.TabOrder := 0;
    UninstallPromptFocusSink.TabStop := True;
    Form.KeyPreview := True;
    Form.OnKeyDown := @HandleUninstallPromptKeyDown;
    Form.OnShow := @HandleUninstallPromptShow;
    Form.ActiveControl := UninstallPromptFocusSink;
    SendMessage(Form.Handle, WMUpdateUIState, HideFocusUIState, 0);
    CloseImage.BringToFront;
    Form.ShowModal;
    if not UninstallPromptConfirmed then
      Exit;

    RemoveUserData := DeleteDataCheck.Checked;
    if RemoveUserData and UninstallCustomHistory then
      if MsgBox(Localized(
        '将只删除以下目录中的 vPaste 受管文件，不会删除目录本身：' + #13#10 + UninstallHistoryDir + #13#10#13#10 + '确定继续吗？',
        'Only vPaste-managed files in this folder will be removed; the folder itself will be kept:' + #13#10 + UninstallHistoryDir + #13#10#13#10 + 'Continue?'),
        mbConfirmation, MB_YESNO) <> IDYES then
        Exit;

    Result := True;
  finally
    UninstallPromptFocusSink := nil;
    UninstallPromptForm := nil;
    Form.Free;
  end;
end;

function InitializeUninstall: Boolean;
begin
  RemoveUserData := False;
  LoadUninstallDataManifest;
  if UninstallSilent then
    Result := True
  else
    Result := PromptForDataRemoval;
end;

procedure CancelUninstallProgress(Sender: TObject);
begin
  SendMessage(UninstallProgressForm.CancelButton.Handle, $00F5, 0, 0);
end;

procedure InitializeUninstallProgressForm;
var
  AssetRoot, BackgroundName: String;
  Background, Logo, CloseImage: TBitmapImage;
  FocusSink: TNewEdit;
begin
  UninstallProgressForm.BorderStyle := bsNone;
  UninstallProgressForm.ClientWidth := ScaleX(WindowWidth);
  UninstallProgressForm.ClientHeight := ScaleY(UninstallHeight);
  UninstallProgressForm.Color := BodySurfaceColor;
  ApplyFormChrome(UninstallProgressForm);
  UninstallProgressForm.Constraints.MinWidth := UninstallProgressForm.Width;
  UninstallProgressForm.Constraints.MaxWidth := UninstallProgressForm.Width;
  UninstallProgressForm.Constraints.MinHeight := UninstallProgressForm.Height;
  UninstallProgressForm.Constraints.MaxHeight := UninstallProgressForm.Height;

  UninstallProgressForm.OuterNotebook.SetBounds(
    ScaleX(1),
    ScaleY(1),
    UninstallProgressForm.ClientWidth - ScaleX(2),
    UninstallProgressForm.ClientHeight - ScaleY(2));
  UninstallProgressForm.InnerNotebook.SetBounds(
    0,
    0,
    UninstallProgressForm.OuterNotebook.ClientWidth,
    UninstallProgressForm.OuterNotebook.ClientHeight);
  UninstallProgressForm.InstallingPage.Color := BodySurfaceColor;
  UninstallProgressForm.MainPanel.Visible := False;
  UninstallProgressForm.Bevel1.Visible := False;
  UninstallProgressForm.Bevel.Visible := False;
  UninstallProgressForm.BeveledLabel.Visible := False;
  UninstallProgressForm.PageNameLabel.Visible := False;
  UninstallProgressForm.PageDescriptionLabel.Visible := False;
  UninstallProgressForm.WizardSmallBitmapImage.Visible := False;

  AssetRoot := AddBackslash(ExpandConstant('{app}\.installer'));
  if IsDarkInstallMode then
    BackgroundName := 'installer-background-dark.png'
  else
    BackgroundName := 'installer-background-light.png';

  Background := TBitmapImage.Create(UninstallProgressForm);
  Background.Parent := UninstallProgressForm.InstallingPage;
  SizeBackgroundToCover(
    Background,
    UninstallProgressForm.InnerNotebook.ClientWidth,
    UninstallProgressForm.InnerNotebook.ClientHeight,
    UninstallProgressForm.InnerNotebook.ClientHeight);
  Background.Top :=
    Background.Top + ScaleY(SetupBackgroundVerticalOffset);
  Background.Center := True;
  Background.Stretch := True;
  Background.PngImage.LoadFromFile(AssetRoot + BackgroundName);
  Background.SendToBack;

  CloseImage := TBitmapImage.Create(UninstallProgressForm);
  CloseImage.Parent := UninstallProgressForm.InstallingPage;
  CloseImage.SetBounds(ScaleX(433), ScaleY(7), ScaleX(34), ScaleY(34));
  CloseImage.BackColor := clNone;
  CloseImage.Center := True;
  CloseImage.Stretch := True;
  CloseImage.Cursor := crHand;
  if IsDarkInstallMode then
    CloseImage.PngImage.LoadFromFile(AssetRoot + 'close-dark.png')
  else
    CloseImage.PngImage.LoadFromFile(AssetRoot + 'close-light.png');
  CloseImage.OnClick := @CancelUninstallProgress;

  Logo := TBitmapImage.Create(UninstallProgressForm);
  Logo.Parent := UninstallProgressForm.InstallingPage;
  Logo.SetBounds(ScaleX(202), ScaleY(32), ScaleX(76), ScaleY(76));
  Logo.BackColor := clNone;
  Logo.Center := True;
  Logo.Stretch := True;
  Logo.PngImage.LoadFromFile(AssetRoot + 'logo.png');

  UninstallProgressForm.StatusLabel.SetBounds(
    ScaleX(40), ScaleY(142), ScaleX(400), ScaleY(28));
  UninstallProgressForm.StatusLabel.Alignment := taCenter;
  UninstallProgressForm.StatusLabel.AutoSize := False;
  UninstallProgressForm.StatusLabel.Caption := Localized(
    '正在卸载 vPaste',
    'Uninstalling vPaste');
  UninstallProgressForm.StatusLabel.Font.Size := 14;
  UninstallProgressForm.StatusLabel.Font.Style := [fsBold];
  UninstallProgressForm.StatusLabel.Color := BodySurfaceColor;

  UninstallProgressForm.ProgressBar.SetBounds(
    ScaleX(60), ScaleY(202), ScaleX(360), ScaleY(14));
  UninstallProgressForm.CancelButton.SetBounds(
    -ScaleX(120), -ScaleY(40), ScaleX(100), ScaleY(30));
  UninstallProgressForm.CancelButton.TabStop := False;
  FocusSink := TNewEdit.Create(UninstallProgressForm);
  FocusSink.Parent := UninstallProgressForm;
  FocusSink.SetBounds(0, 0, ScaleX(1), ScaleY(1));
  FocusSink.TabOrder := 0;
  FocusSink.TabStop := True;
  UninstallProgressForm.ActiveControl := FocusSink;
  SendMessage(
    UninstallProgressForm.Handle,
    WMUpdateUIState,
    HideFocusUIState,
    0);
  CloseImage.BringToFront;
end;

procedure RemoveAutostartEntries;
begin
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'vPaste');
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'vpaste');
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'vpaste-desktop');
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'vPaste.exe');
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'vpaste-desktop.exe');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;

  RemoveAutostartEntries;
  if UninstallAppDataDir <> '' then
    DelTree(AddBackslash(UninstallAppDataDir) + 'updates', True, True, True);

  if not RemoveUserData then
    Exit;

  if UninstallCustomHistory then
  begin
    DeleteFile(AddBackslash(UninstallHistoryDir) + 'vpaste.db');
    DeleteFile(AddBackslash(UninstallHistoryDir) + 'custom_tabs.json');
    DelTree(AddBackslash(UninstallHistoryDir) + 'data', True, True, True);
    DelTree(AddBackslash(UninstallHistoryDir) + 'rich_formats', True, True, True);
    DelTree(UninstallAppDataDir, True, True, True);
  end
  else if UninstallAppDataDir <> '' then
    DelTree(UninstallAppDataDir, True, True, True);
end;
