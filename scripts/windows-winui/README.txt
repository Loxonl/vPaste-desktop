vPaste - opt-in WinUI Release portable (Windows x64)

1. Extract the entire folder. Keep the EXE, both DLLs, runtime folder and
   SHA256SUMS.txt together.
2. If Windows App Runtime 2.6.5 or a compatible 2.6 update is not installed,
   right-click Install-WinUiRuntime.ps1 and choose Run with PowerShell.
   This installs the bundled Microsoft-signed
   packages for the current user; it does not download anything or need the Store.
   All four packages are checked for missing files, SHA256, package identity and
   Windows requirements before installation starts. Add-AppxPackage checks their
   signatures. Enterprise policy can still block installation. Do not bypass it.
3. Close any other vPaste instance, then run Start-vPaste.cmd.

Requirements: Windows 10 1809 or newer; WebView2 remains required for settings
and rich previews, as it is in the shipping app. Ordinary native-panel use does
not create the main WebView. A fresh offline machine also needs the WebView2
Evergreen Runtime preinstalled for those auxiliary pages.

This is a Release build with an explicit native UI selection, not a public
release or an automatic updater artifact. It uses portable data next to this
folder and does not migrate the installed app's history. Running vPaste.exe
without --main-ui=winui keeps the existing WebView default.
If you enable "Start on login" in a WinUI session, its startup entry keeps the
WinUI argument. This does not change the default for manually running the EXE.

Settings and the first-run guide are created on demand and destroyed on close.
Rich preview WebViews are reused while open, then released when closed.
SHA256SUMS.txt records the included files and is required by the runtime script.
Hash checks detect incomplete/corrupt copies; they do not replace signature
verification. Preflight does not roll back a later Windows installation error.
Runtime license and notices are in runtime/. vPaste's license is in LICENSE.
