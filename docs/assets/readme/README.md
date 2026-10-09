# README maintenance / README 维护

The root [English README](../../../README.md) is the default entry point; the [Simplified Chinese README](../../../README.zh-CN.md) has the same structure and facts. Update both in the same change. Product behavior belongs in the READMEs; media publishing notes belong here.

根目录的英文 README 是默认入口，中文版保持相同结构与事实。功能、下载与快捷键变化时同步更新两版；视频发布和维护说明留在本文，不放进面向用户的正文。

## Structure and sources

Keep the order: localized header artwork → prominent language switch → a single main heading combining the product name and localized slogan → introduction and badges → prominent website domain → regular section navigation → localized demo → features → download table → short FAQ → development → contribution and license. Center the header content and keep the language switch directly below the artwork. Keep the visible `vpaste.app` domain on its own line, with localized destinations.

Features use plain descriptions grouped into content types (a five-row table), search and organization, preview and paste, keyboard shortcuts, interface settings, and local storage/privacy. Include first-use instructions within these groups rather than maintaining separate quick-start or privacy sections. Keep downloads to a platform table linking to Releases.

| Content | Source of truth |
| --- | --- |
| Product positioning and public wording | [English website](https://vpaste.app/en/) / [中文官网](https://vpaste.app/zh/), checked against the app |
| Available releases and packages | [GitHub Releases](https://github.com/Loxonl/vPaste-desktop/releases) |
| Shortcut defaults | [`shortcutDefaults.ts`](../../../src/config/shortcutDefaults.ts) and [`config/mod.rs`](../../../src-tauri/src/config/mod.rs) |
| Settings defaults | [`settingsTypes.ts`](../../../src/config/settingsTypes.ts) and the Rust configuration |
| Development commands | [`package.json`](../../../package.json), [`.node-version`](../../../.node-version), [`Cargo.toml`](../../../src-tauri/Cargo.toml) |
| Installer behavior and supported systems | [Windows install flow](../../open-source/releases/windows-install-update-flow.md), [macOS release flow](../../open-source/releases/macos-release-flow.md) |
| License and security reporting | [LICENSE](../../../LICENSE), [SECURITY.md](../../../SECURITY.md) |

Use the release listing rather than a hardcoded version, artifact name, or `/releases/latest` URL. The release badge includes prereleases, so it remains useful before the first stable release. Shields cannot read a private repository; verify the badge after the repository becomes public. Do not add download counts, stars, sponsor blocks, or a copy of the full changelog.

下载入口指向 Release 列表，避免绑定版本号或安装包文件名。发布徽章包含预发布版本；仓库公开后检查其显示。README 不重复维护完整更新日志，也不添加下载量、关注量或赞助模块。

## Header artwork

Use [header-en.png](header-en.png) in the English README and [header-zh-CN.png](header-zh-CN.png) in the Simplified Chinese README. Both are the approved 1800 × 600 PNG artwork supplied for the README header. Keep each language's artwork, slogan, and switch links aligned when updating the header.

## Demo videos

The approved pair is a 40-second product walkthrough: 2560 × 1440, 30 fps, H.264 video with AAC stereo audio. Use the English video only in `README.md` and the Chinese video only in `README.zh-CN.md`. Do not re-encode the approved files for a README update.

| Language | Approved source filename | Bytes | SHA-256 |
| --- | --- | --- | --- |
| English | `vpaste-40s-1440p-en.mp4` | 7,840,770 | `2acffd5e4b6a4065f18a2a508755346a313442f91d29a7675b0995b01b17820b` |
| 简体中文 | `vpaste-40s-1440p-zh.mp4` | 7,901,632 | `5bbe8bdcc15474b9d7443ad9a63c3302ed39843d872e0f8c8d1a6617508e120d` |

Current GitHub attachments: [English](https://github.com/user-attachments/assets/12f6e93f-f7bd-4254-9731-35bff6160501) · [简体中文](https://github.com/user-attachments/assets/3faad9fb-020b-4ca3-b691-a4aae34a7f2e).

The video project is maintained separately from the desktop source. Its approved `video-demo/final/` delivery contains these exact files and their checks. [demo-cover.png](demo-cover.png) is a byte-for-byte copy of the approved shared cover, `vpaste-cover-1440p.png` (SHA-256: `23084c491a3455d7fa3060c441fbe5523e75e0f64bbae718d1cf52c37e1a0348`). It is retained for sharing; GitHub controls the native player's poster and layout.

### Updating a video

1. Take the approved final file from the video project and verify its checksum. Avoid draft renders or a file chosen only because its modification time is newer.
2. Upload it with the GitHub Markdown editor's attachment control. Copy the resulting `https://github.com/user-attachments/assets/...` URL. Uploading an attachment does not require publishing an issue or committing the file through the web editor.
3. Put the correct language's bare attachment URL on its own line inside a centered `div`, with blank lines around the URL, immediately below the README header. GitHub generates the player and controls; do not depend on custom `video` widths, posters, or autoplay attributes. Use a short localized feature-demo caption; omit resolution, duration, and language metadata from the caption.
4. Check GitHub's own preview: the player must load, play with sound, and display at 2560 × 1440. Check both language links and a narrow viewport. A local Markdown preview alone does not prove GitHub playback works.
5. Update this source inventory, the two attachment references, and the cover only when a replacement pair is approved. Keep MP4 render outputs out of this source repository.

Both videos are below GitHub's 10 MB free-plan video attachment limit. See [GitHub's attachment documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files). Do not substitute a local filesystem path, a guessed attachment URL, a raw repository MP4 link, or an expiring signed download URL for the native attachment.

Attachments uploaded while the repository is private may require authentication. After the public switch, check both players while signed out; re-upload from the public repository if access remains restricted.

更新视频时，以视频工程中确认过的最终成片为准，上传为 GitHub 附件后替换对应语言 README 的地址，并在 GitHub 页面实际检查播放。MP4 不进入源码仓库，不使用临时下载地址；普通本地 Markdown 预览不能证明 GitHub 内嵌播放正常。

## Screenshots and cover

The existing `main-panel.png`, `tabs-categories.png`, `preview.png`, and `settings.png` remain available as earlier screenshots. They are not used by the rewritten READMEs. Review them against the current app before reusing them.

For replacement screenshots, use consistent theme, scaling, and synthetic sample data. Exclude real clipboard history, personal paths, credentials, and account details. Use project-owned assets with redistribution rights and optimize images before committing.

旧截图保留作为已有素材，新版 README 不再连续铺陈这些截图。后续需要使用时，应先核对是否符合当前界面，并使用一致的主题、缩放和演示数据。
