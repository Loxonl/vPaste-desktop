# Windows x64 WinUI 内部 RC

这是 Windows 内部便携测试包。当前版本为 `2.0.0-rc.1`。从未提交的 Windows 补丁构建时，以配套清单里的完整基线和补丁 SHA-256 为准。内部 RC 默认启动 WinUI，保留 WebView 主面板用于比较和回退。

## 运行和回退

1. 使用可供内部测试的 Windows x64 环境。WinUI 需要已安装的 Windows App Runtime 2.6.5 x64 或兼容的 2.6 更新。需要手动准备时，在微软下载页选择 **2.6.5 → Installer (x64)**，验明 Microsoft 签名后按测试设备的政策安装。WebView 回退和辅助窗口还需要 WebView2 Runtime。此 ZIP 不安装任何运行时。[Windows App SDK 下载](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads#stable-release) · [WebView2 Runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
2. 核对 ZIP 的 SHA-256，完整解压到新的可写测试目录，目录放在稳定版安装目录和 AppData 之外。请勿复制已有 vPaste 配置或历史。把 `internal-rc.flag` 和两个 DLL 留在 EXE 旁。RC 只使用这个目录里的 `internal-rc-data`，WebView2 配置在其 `webview2` 子目录。用合成剪贴板和历史数据测试。
3. 从托盘退出运行中的 Stable vPaste 后再启动 RC。它们共用应用标识和单实例路由。用 PowerShell 在解压目录运行下列命令。

   ```powershell
   .\vPaste.exe
   ```

4. Runtime 不可用时，WinUI 启动会报告所需版本。要比较或恢复到 WebView，先退出当前 vPaste 实例，再执行下列命令。

   ```powershell
   .\vPaste.exe --main-ui=webview
   ```

5. 要恢复 Stable，退出 RC，再用原有的 Stable 快捷方式启动。RC 的合成数据留在测试目录内。下一 RC 解压到新的专用目录后手动运行。

内部包关闭更新检查、更新缓存恢复和自动安装。它也关闭登录自启，已有 Stable 的启动项由 Stable 管理。独立诊断可在不启动 App 的情况下显示版本、配置和选定界面。下列诊断跳过 WinUI Runtime，省略 `--main-ui=webview` 可同时诊断默认 WinUI 所需的 DLL 和 Runtime。

```powershell
.\vPaste.exe --winui-build-info --main-ui=webview | Out-String
```

## Windows internal trial

Check the ZIP's SHA-256 and extract it to a new writable test folder outside
the Stable install and AppData. Keep the version marker and both DLLs beside
the executable. Use synthetic data in `internal-rc-data`. Quit Stable from
the tray first because the builds share single-instance routing.

WinUI needs Windows App Runtime 2.6.5 x64 or a compatible 2.6 update. Use
Microsoft's x64 installer for the matching version on the test machine.
Keep WebView2 Runtime available for auxiliary windows and WebView fallback.
Start `vPaste.exe` for WinUI or `vPaste.exe --main-ui=webview` for WebView.
Exit the RC before returning to Stable. Updates use manual extraction and
login startup is disabled in the internal package.

## 内部产物配对契约

Windows 维护者在已缓存依赖的隔离工作树中运行以下命令。下一轮将
`-InternalRcVersion` 改为 `2.0.0-rc.2` 等版本即可。

```powershell
npm run build:windows -- -WinUiCandidate -InternalRcVersion 2.0.0-rc.1
```

产物为 `bundle/windows-internal-rc/<version>/` 下的便携 ZIP 和 SHA-256 校验和。内部试用不使用 GitHub tag、Release 或公共更新源。

每个平台单独提供一份 JSON 产物记录。合并校验时使用相同的
`baseRevision`（完整共享 Git SHA）和 `version`，校验各记录中列出的文件。平台补丁可不同。

| 字段 | 内容 |
| --- | --- |
| `schemaVersion` | `1` |
| `baseRevision`, `patchSha256` | 40 位共享 Git SHA，未提交的平台补丁 SHA-256 |
| `version`, `platform`, `arch` | 完整 RC semver、操作系统、CPU 架构 |
| `build` | 工具链版本、构建命令、Release 功能和环境开关 |
| `updatePolicy` | `publicFeed: "0"`，`updaterEnabled: false`，手动替换 |
| `runtimePrerequisites`, `profileIsolation`, `rollback` | 每个平台的运行时、数据路径隔离方式、回到 Stable 的方法 |
| `artifacts[]` | 每项 `name`、`bytes`、`sha256`，文件名相对于产物目录 |

Mac 工程师独立提供同版本和共享基线的内部 Release 产物与记录。等 Mac 侧 Release 原生界面开关、隔离和实际产物得到确认后才能组包。当前交付只有 Windows。

## 验收边界

本地可核对包文件和早退出诊断。真实设备的 Runtime 差异、托盘退出、物理热键和 Win+V、中文 IME、外部粘贴与防误投仍需在测试设备验收。反馈可提供版本、Windows 构建号与架构、界面模式、错误码及脱敏复现步骤。请保留本地剪贴板和历史内容。
