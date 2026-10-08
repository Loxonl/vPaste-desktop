<div align="center">

# vPaste

**剪贴捷径，一键即达。**

面向 Windows 和 macOS 的可视化剪贴板管理器。把复制过的文本、图片、链接、颜色与文件保存在清晰的卡片里，随时搜索、预览、再次粘贴。历史记录留在你的设备上。

<p>
  <a href="#下载"><img src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4" alt="Windows 10 / 11"></a>
  <a href="#下载"><img src="https://img.shields.io/badge/macOS-11%2B-222222" alt="macOS 11+"></a>
  <a href="https://github.com/Loxonl/vPaste-desktop/releases"><img src="https://img.shields.io/github/v/release/Loxonl/vPaste-desktop?include_prereleases&amp;sort=semver&amp;label=release&amp;color=2563eb" alt="发布版本"></a>
  <a href="https://v2.tauri.app/"><img src="https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri&amp;logoColor=white" alt="基于 Tauri 2 构建"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue" alt="许可证：GPL-3.0-only"></a>
</p>

<h3><a href="https://vpaste.app/zh/">vpaste.app</a></h3>

<p><strong><a href="README.md">English</a> · 简体中文</strong></p>

[下载](#下载) · [功能](#功能) · [更新日志](CHANGELOG.md) · [参与贡献](#参与贡献)

</div>

<div align="center">



https://github.com/user-attachments/assets/0bb0b660-d7ca-4742-a2b1-731f4378a58f


</div>
<p align="center"><strong>vPaste 功能演示</strong></p>

## 功能

### 支持的内容类型

vPaste 会自动记录支持的剪贴板内容，以卡片形式显示，并附上复制时间和来源应用。

| 类型 | 展示与预览 | 支持的操作 |
| --- | --- | --- |
| 文本 | 纯文本与富文本，包括标题、列表、表格和链接 | 搜索正文；保留格式粘贴，或粘贴为纯文本 |
| 图片 | 卡片缩略图、完整大图、图片尺寸和 GIF 识别 | 粘贴或拖入支持的应用；导出为图片文件 |
| 链接 | 显示网址；开启链接预览后显示网页标题和预览图 | 按标题或网址搜索；预览网页，或在浏览器中打开 |
| 颜色 | 同时显示色块和颜色值 | 在 HEX、RGB、HSL 之间转换，复制所需格式的颜色值 |
| 文件 | 单个文件、文件夹和多文件记录；预览支持的文件格式 | 粘贴或拖出文件；打开所在位置，或复制文件路径 |

富文本还原、文件预览和拖拽效果取决于原始内容格式及接收应用。文件记录引用磁盘上的原文件，不会永久备份原文件。

### 搜索与整理

- **关键词搜索：** 按正文、网页标题、网址、文件名、路径或来源应用查找记录。
- **条件筛选：** 按内容类型、来源应用或日期缩小范围，也可从收藏和标签中查找。
- **分类整理：** 收藏常用记录、添加标签，并用自定义标签页组织内容。

### 预览与粘贴

启动 vPaste 并完成首次使用引导后，像平时一样复制即可。Windows 按 `Alt + V`，macOS 按 `Option + V` 呼出历史，选中卡片后按 `Enter` 粘贴到当前应用。macOS 的首次使用引导会说明自动粘贴所需的辅助功能权限。

- **内容预览：** 按 `Space` 查看完整文本、大图、网页和支持的文件内容，再决定是否粘贴。
- **粘贴格式：** 保留支持的富文本格式，或按 `Shift + Enter` 粘贴为纯文本。
- **粘贴队列：** 开启队列后依次复制多条内容，再用 `Ctrl + V` 或 `⌘ + V` 按顺序粘贴，适合填写多个表单字段。
- **跨应用拖拽：** 将文本、链接、图片或文件拖入支持的应用，多文件记录可以一起拖出。
- **多屏使用：** 主面板跟随当前操作的屏幕显示。

### 键盘操作

默认快捷键：

| 操作 | Windows | macOS |
| --- | --- | --- |
| 显示 / 收起主面板 | `Alt + V` | `Option + V` |
| 开启 / 关闭粘贴队列 | `Alt + Shift + V` | `Option + Shift + V` |
| 在面板中搜索 | `Ctrl + F` | `⌘ + F` |
| 选择上一张 / 下一张卡片 | `←` / `→` | `←` / `→` |
| 预览选中卡片 | `Space` | `Space` |
| 粘贴选中内容 | `Enter` | `Enter` |
| 粘贴为纯文本 | `Shift + Enter` | `Shift + Enter` |

主面板、粘贴队列和纯文本粘贴快捷键可以在设置中修改。

### 界面设置

- **外观与语言：** 跟随系统或选择浅色、深色主题，支持英文和简体中文界面。
- **启动与后台：** 在设置中调整开机启动、托盘和后台运行选项。
- **面板状态：** 按需记住搜索内容、选中的标签页和滚动位置，下次打开时继续使用。

### 本地存储与隐私

剪贴板历史保存在本机，vPaste 不会把它上传到云端服务，使用应用也不需要注册账号。

- **记录范围：** 排除指定来源应用，或暂停记录。敏感内容保护会在平台支持时跳过系统标记的敏感内容，但不会自动识别所有密码或密钥。
- **存储与清理：** 自选历史记录的存储目录，查看存储占用，并按时间清理旧记录。
- **历史迁移：** 手动导出、导入历史归档，在 Windows 与 macOS 之间迁移。目前不提供自动云同步；归档包含剪贴板内容，请妥善保管。
- **联网行为：** 链接自动预览默认开启，会请求对应网页以获取标题和图片，可在设置中关闭。在预览窗口打开网页也会访问该网站；检查更新和下载安装包时会访问发布服务。

## 下载

| 平台 | 系统要求 | 下载入口 |
| --- | --- | --- |
| Windows · x64 | Windows 10 22H2 / Windows 11 | [`.exe` 安装包 / `.zip` 便携包](https://github.com/Loxonl/vPaste-desktop/releases) |
| macOS · Apple 芯片 | macOS 11 及以上 | [Apple 芯片版 `.dmg`](https://github.com/Loxonl/vPaste-desktop/releases) |
| macOS · Intel 芯片 | macOS 11 及以上 | [Intel 芯片版 `.dmg`](https://github.com/Loxonl/vPaste-desktop/releases) |

## 常见问题

<details>
<summary><strong>为什么 macOS 自动粘贴需要权限？</strong></summary>

vPaste 需要辅助功能权限，才能向当前应用发送粘贴操作。请在“系统设置 → 隐私与安全性 → 辅助功能”中允许 vPaste，然后重试。自动粘贴失败时，可以按照应用内提示使用 `⌘ + V` 手动粘贴。

</details>

<details>
<summary><strong>复制文件后，vPaste 会永久备份原文件吗？</strong></summary>

文件记录引用磁盘上的文件。移动或删除原文件后，对应记录可能无法预览、粘贴或拖出。导出剪贴板历史也不能替代原文件备份。

</details>

<details>
<summary><strong>支持 Linux 吗？</strong></summary>

目前支持的桌面平台为 Windows 和 macOS，暂未提供官方 Linux 安装包。

</details>

## 本地开发

vPaste 使用 **Tauri 2 + Rust** 构建桌面应用，界面基于 **React 18 + TypeScript + MUI 5 + Motion**。

从源码运行前，请安装 Node.js（版本见 [`.node-version`](.node-version)）、npm 11、Rust（版本见 [`Cargo.toml`](src-tauri/Cargo.toml) 的 `rust-version`），以及 [Tauri 对应平台的开发依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/Loxonl/vPaste-desktop.git
cd vPaste-desktop
npm ci
npm run dev:debug
```

`dev:debug` 在 Windows 或 macOS 上运行桌面应用，并提供仅在开发模式下可用的引导预览和测试工具。macOS 上请先退出已运行的 vPaste。`npm run dev` 仅启动前端，不包含原生剪贴板能力。

检查命令见 [CONTRIBUTING.md](CONTRIBUTING.md)，源码结构见[架构说明](docs/open-source/architecture.md)，平台与打包细节见[文档索引](docs/README.md)。

## 参与贡献

欢迎反馈问题、提交聚焦的修复、完善文档或帮助翻译。

- **反馈问题或建议：** 提交 [Issue](https://github.com/Loxonl/vPaste-desktop/issues)，附上应用版本、操作系统和复现步骤，使用示例剪贴板内容。
- **提交改动：** 请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和[行为准则](CODE_OF_CONDUCT.md)。
- **参与翻译：** 参考[语言包指南](docs/open-source/language-packs.md)。
- **报告安全问题：** 按 [SECURITY.md](SECURITY.md) 中的方式反馈，不要在公开 Issue 中披露敏感细节。

## 许可证

vPaste 使用 **[GPL-3.0-only](LICENSE)** 许可证，贡献内容采用相同许可证。依赖许可证及致谢见[第三方声明](docs/open-source/third-party-notices.md)。
