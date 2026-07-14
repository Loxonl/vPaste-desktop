# Windows 安装、更新与卸载流程

本项目的 Windows 官方交付物是 Tauri 2 生成的标准 NSIS x64 安装包。构建定义位于 `.github/workflows/release.yml`，不依赖私有安装器外壳。

## 安装

- 默认按当前用户安装，安装目录由 Tauri/NSIS 的 `currentUser` 模式管理。
- 安装器使用仓库中的 NSIS hooks 和中英文资源。
- 官方安装包必须同时具有有效 Authenticode 签名和时间戳。
- Windows SmartScreen 信誉需要由同一代码签名证书持续积累，不能由 Tauri Updater 签名替代。

## 覆盖升级

- NSIS 更新在当前用户范围内覆盖程序文件。
- 用户历史和设置不属于安装目录，升级不得清理这些数据。
- 发布前至少从上一个公开稳定版实际升级一次。

## 应用内更新

- 应用从 `https://github.com/Loxonl/vPaste-desktop/releases/latest/download/latest.json` 获取稳定更新信息。
- `latest.json` 只会在 GitHub Release 正式发布后成为 `/releases/latest` 的目标；草稿不会提前推送给用户。
- 应用先使用仓库中公开的 Updater 公钥验证包签名，再启动被 Authenticode 签名的 NSIS 安装器。
- `.sig` 和公钥可以公开，`TAURI_SIGNING_PRIVATE_KEY` 绝不能进入仓库或 Release。

## 卸载

- 使用 NSIS 生成的标准卸载入口移除程序文件和快捷方式。
- 默认保留用户历史与配置；需要清理数据时由用户显式操作。

## 发布前验证

- `Get-AuthenticodeSignature` 返回 `Valid`。
- `SHA256SUMS.txt` 与下载后的安装包一致。
- `latest.json` 的 `windows-x86_64` URL、版本和签名正确。
- 新用户安装、旧版覆盖升级、应用内更新、卸载均通过。
