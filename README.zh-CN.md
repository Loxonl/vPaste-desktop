# vPaste Desktop

vPaste 是一个本地优先的 Windows / macOS 桌面剪贴板管理器。它在你的设备上保存剪贴板历史，支持快速搜索和预览，并尽量保留有用的剪贴板上下文，而不把剪贴板数据发送到云端服务。

本仓库是桌面应用的干净 GPL-3.0-only 公开基线。

> 状态：早期干净开源基线。当前可以从源码构建；暂不承诺已经提供官方签名发布包。

## 功能

- 本地优先的剪贴板历史。
- 支持文本、图片、文件、链接、颜色和富文本等剪贴板项目。
- 面向搜索的剪贴板存储。
- 托盘 / 菜单控制和全局快捷键支持。
- 基于 Tauri 的 Windows / macOS 桌面外壳。
- 英文和简体中文界面文本。

## 界面截图

![vPaste 主剪贴板面板](docs/assets/readme/main-panel.png)

![标签、收藏与分类筛选](docs/assets/readme/tabs-categories.png)

![图片、链接、文件与富文本预览](docs/assets/readme/preview.png)

![设置窗口](docs/assets/readme/settings.png)

## 隐私

vPaste 设计为本地运行。剪贴板数据保存在用户设备上。在平台支持的情况下，系统标记的敏感剪贴板内容默认会被忽略。

请不要在公开 issue 中粘贴密钥、密码、令牌、私人消息或敏感剪贴板内容。安全问题报告方式见 [SECURITY.md](SECURITY.md)。

## 环境要求

- Node.js 24，或其他当前受支持且兼容本项目工具链的 Node.js 版本。
- Rust stable 工具链。
- Tauri 2 在 Windows 或 macOS 上开发所需的平台依赖。

## 开发

安装依赖：

```powershell
npm ci
```

仅运行前端开发服务器：

```powershell
npm run dev
```

运行桌面应用开发模式：

```powershell
npm run dev:app
```

构建前端：

```powershell
npm run build
```

检查 Rust / Tauri 侧：

```powershell
cargo check --manifest-path src-tauri\Cargo.toml
```

检查 Rust 格式：

```powershell
Push-Location src-tauri
cargo fmt --all --check
Pop-Location
```

## 发布

官方签名发布包暂不属于这次初始干净基线。Release、签名、更新器和安装器自动化会在经过公开安全审查后，再作为公开约定写入文档。

在公开发布包可用之前，请从源码构建用于测试和开发。

## 贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。提交 Pull Request 即表示贡献者确认自己有权提交这些改动，并同意这些贡献作为本项目的一部分按 GPL-3.0-only 授权。

## 许可证

vPaste Desktop 使用 GPL-3.0-only 许可证。见 [LICENSE](LICENSE)。
