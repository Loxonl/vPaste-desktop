# Windows 安装、更新与卸载流程

Windows 官方交付物为 Inno Setup 6.7.3 编译的 x64 当前用户安装包，以及真正的 Portable ZIP。安装器定义位于 `installer/windows/vpaste.iss`，统一入口为 `npm run build:windows`。

## 安装

- 固定 `AppId=com.loxonl.vpaste`，默认安装到 `%LOCALAPPDATA%\Programs\vPaste`，不请求管理员权限。
- 准备页只展示产品信息、安装目录和默认关闭的桌面快捷方式；开始菜单快捷方式始终创建。
- 跟随 Windows 的界面语言和深浅色；最低安装目标为 Windows 10 1709（Build 16299）x64，也允许 Windows 10 21H2 / LTSC 2021、22H2 和 Windows 11。具体真机验证范围见 [Windows 平台说明](../platform/windows.md#windows-version-compatibility)。
- 系统版本由 Inno 原生 `MinVersion` 统一检查，交互安装和静默更新使用同一门槛；不再在欢迎页单独拦截低于 22H2 的系统。WinGet 清单使用相同最低版本。
- 缺少 WebView2 时才下载微软 Evergreen Bootstrapper，并在运行前验证 Microsoft Authenticode 签名。
- 同版本进入修复模式；默认阻止降级，开发测试只能显式传入 `/ALLOWDOWNGRADE` 并再次确认。

## 从旧 NSIS 迁移

- 读取旧卸载注册项和安装目录，在原目录覆盖程序文件。
- 安装成功后才删除旧卸载器和旧注册项，不运行旧卸载流程，不触碰历史与配置。
- 安装前备份现有 EXE；安装失败时恢复旧 EXE。

## 应用内更新

- Stable feed 使用 Tauri updater 检查 `latest.json` 并验证 minisign。
- Windows 把验签后的 Inno EXE 先写入临时文件、从磁盘复验后再原子提交 `pending.json` 元数据；下次启动在后台离线复核缓存签名、版本和平台，再恢复“重启更新”状态，不重复下载。
- 默认启动 60 秒后检查，此后在上次成功检查 24 小时后再检查并静默下载；失败按 15 分钟 → 1 小时 → 6 小时退避，不记为成功检查。下载完成并验签落盘后，设置页、主面板（设置按钮右侧的蓝色圆形更新图标，点击后先确认）和托盘提供同一个“更新并重启”操作，系统通知同一版本最多提醒一次。
- 用户点击“重启更新”后，应用先复验缓存，再以静默参数启动安装器并退出；安装器无法启动时不退出，缓存仍有效时可直接重试；安装器完成替换后使用 `--updated-from` 启动新版本。
- 更新重启参数与当前版本匹配时，在采集监听已启动、主面板事件订阅就绪后自动打开一次主面板；普通启动、开机自启和未完成引导时不因此打开主面板。macOS 保持原有的启动显示行为，并同样等待主面板订阅就绪。
- Stable 使用 `https://vpaste.app/download/stable/latest.json`；RC 构建使用 `https://vpaste.app/download/rc/latest.json`，由 Release workflow 写入 `VPASTE_UPDATE_CHANNEL=rc` 选择。发布 Release 后，合并的 `latest.json` 经匿名下载校验后写入 `Loxonl/vPaste-website` 对应通道，详见 [update-feed-publication.md](update-feed-publication.md)。
- 私有 Draft Release 仍硬性禁用公共 feed。Debug 可通过 `VPASTE_DEBUG_UPDATE_ENDPOINT` 使用本地签名测试源。

## Portable

- ZIP 内含 `portable.flag`，所有配置、数据库与缓存写入 EXE 同目录的 `data`。
- 目录不可写时直接报错，不回退 AppData。
- 默认不注册开机启动项；用户可在设置中开启，注册独立的当前用户 `vPaste Portable` 启动项。移动目录后手动运行一次即可更新启动路径，即使已有另一个 vPaste 实例在运行；关闭开关只移除指向当前副本的启动项，未开启的其他副本不会删除它。
- 安装版和便携版仍共用单实例机制。如果两者都设为开机启动，只有先启动的实例会保持运行；要确保启动便携版，请关闭安装版的开机启动。
- 不注册卸载项，也不自动替换自身；只提示前往 Release 手动下载。

## 卸载

- 默认只删除程序、快捷方式、启动项和更新缓存，保留历史与设置。
- 交互卸载可选择删除用户数据；自定义历史目录只删除 vPaste 明确管理的项目，不递归删除用户选择的根目录。
- 静默卸载始终保留用户数据。
