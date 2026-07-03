# Windows 安装、更新与卸载流程

> 维护者向。官方打包、签名、更新器与安装器外壳工具在维护者环境中运行，不包含在本公开仓库中。贡献者无需执行本流程；贡献者的构建/检查命令见 README 与 CONTRIBUTING。

本文档记录 vPaste Windows 官网直装链路的当前约定。当前阶段只维护 Stable 通道，不覆盖企业 MSI、MSIX、Intune 或全用户安装。

## 交付物

- 主安装包：`src-tauri/target/release/bundle/nsis/vPaste_<version>_x64-setup.exe`
- Updater 签名：`src-tauri/target/release/bundle/nsis/vPaste_<version>_x64-setup.exe.sig`
- 更新元数据：`src-tauri/target/release/bundle/updater/latest.json`
- Stable 更新源：`https://downloads.vpaste.app/windows/latest.json`

## 构建命令（维护者环境）

官方安装包由维护者环境中的发布脚本产出（该脚本不在本仓库中），负责执行 Tauri build、补丁生成的 NSIS 脚本、重新封包 NSIS 安装器、生成 updater 签名，并写出 `latest.json`。

## 安装流程

- 默认安装范围为当前用户，目标目录为 `%LOCALAPPDATA%\Programs\vPaste`。
- 首装流程保留欢迎页、安装目录页、安装进度页和完成页。
- 安装目录页默认展示，默认路径为 `%LOCALAPPDATA%\Programs\vPaste`，用户可以主动选择其他位置。
- 开始菜单项默认创建，开始菜单选择页默认跳过。
- 开始菜单内提供 `Uninstall vPaste` 直接快捷方式，指向安装目录下的 `uninstall.exe`。
- 桌面快捷方式放在完成页作为可选项。
- 完成页保留启动 vPaste 的入口。

## 覆盖升级

- 检测到旧版 NSIS 安装时，默认直接覆盖安装。
- 不展示“先卸载旧版本”的维护选择页。
- 升级过程不删除历史、配置、标签、缓存或自定义历史目录。
- WiX 迁移路径仍保留旧安装器卸载逻辑，避免历史包迁移失败。

## 应用内更新

- 设置页保留“检查更新”和“下载并安装”入口。
- 启动后最多每天静默检查一次更新。
- 发现新版本时只在主窗口轻提示，引导用户进入设置页查看版本说明。
- 用户可以忽略当前版本；被忽略版本不再重复提示。
- 安装更新前提示用户 vPaste 会退出并启动安装器，历史和配置会保留。

## 卸载流程

- 默认只卸载程序文件、开始菜单项和桌面快捷方式。
- 默认不删除 AppData、历史存储目录和用户配置。
- 卸载器中的“删除应用数据”属于显式清理选项，默认不勾选。
- 应用内更新模式不会触发数据清理逻辑。

## 发布前检查

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- 确认 `setup.exe`、`.sig`、`latest.json` 三者版本一致。
- 确认 `latest.json` 中的签名与 `.sig` 文件内容一致。
- 正式对外发布前必须补齐代码签名证书；Updater 签名不等同于 Windows SmartScreen 信任。
