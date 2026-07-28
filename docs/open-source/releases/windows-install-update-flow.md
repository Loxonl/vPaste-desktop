# Windows 安装、更新与卸载流程

Windows 官方交付物为 Inno Setup 6.7.3 编译的 x64 当前用户安装包，以及真正的 Portable ZIP。安装器定义位于 `installer/windows/vpaste.iss`，统一入口为 `npm run build:windows`。

## 安装

- 固定 `AppId=com.loxonl.vpaste`，默认安装到 `%LOCALAPPDATA%\Programs\vPaste`，不请求管理员权限。
- 准备页只展示产品信息、安装目录和默认关闭的桌面快捷方式；开始菜单快捷方式始终创建。
- 跟随 Windows 的界面语言和深浅色；支持 Windows 10 22H2 与 Windows 11。
- 缺少 WebView2 时才下载微软 Evergreen Bootstrapper，并在运行前验证 Microsoft Authenticode 签名。
- 同版本进入修复模式；默认阻止降级，开发测试只能显式传入 `/ALLOWDOWNGRADE` 并再次确认。

## 从旧 NSIS 迁移

- 读取旧卸载注册项和安装目录，在原目录覆盖程序文件。
- 安装成功后才删除旧卸载器和旧注册项，不运行旧卸载流程，不触碰历史与配置。
- 安装前备份现有 EXE；安装失败时恢复旧 EXE。

## 应用内更新

- Stable feed 使用 Tauri updater 检查 `latest.json` 并验证 minisign。
- Windows 把验签后的 Inno EXE写入应用数据下的版本目录，再以静默参数启动安装器。
- 默认启动 60 秒后检查，此后每 24 小时检查并自动下载；安装始终需要用户选择“立即更新”“退出时更新”或“稍后”。
- “退出时更新”只响应托盘中的真正退出；普通关窗和系统关机不会触发。
- 当前私有阶段的 Release 构建硬性禁用公共 feed。Debug 可通过 `VPASTE_DEBUG_UPDATE_ENDPOINT` 使用本地签名测试源。

## Portable

- ZIP 内含 `portable.flag`，所有配置、数据库与缓存写入 EXE 同目录的 `data`。
- 目录不可写时直接报错，不回退 AppData。
- 不注册开机启动和卸载项，不自动替换自身；只提示前往 Release 手动下载。

## 卸载

- 默认只删除程序、快捷方式、启动项和更新缓存，保留历史与设置。
- 交互卸载可选择删除用户数据；自定义历史目录只删除 vPaste 明确管理的项目，不递归删除用户选择的根目录。
- 静默卸载始终保留用户数据。
