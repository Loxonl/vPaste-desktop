# README Assets / README 配图

This directory stores images used by the public GitHub README.

这个目录用于保存 GitHub README 里展示的公开配图。

## Recommended long-term workflow

1. Capture stable product screenshots after notable UI changes.
2. Save optimized images in this directory with descriptive names, for example:
   - `main-panel.png`
   - `tabs-categories.png`
   - `preview.png`
   - `settings.png`
3. Reference them from `README.md` with relative paths:

   ```md
   ![vPaste main clipboard panel](docs/assets/readme/main-panel.png)
   ```

## Recommended image set

- `main-panel.png` - main clipboard panel / 主剪贴板面板
- `tabs-categories.png` - tabs, favorites, category filters / 标签、收藏与分类筛选
- `preview.png` - image, link, file, and rich text preview / 图片、链接、文件、富文本预览
- `settings.png` - settings window / 设置窗口

## Automation option

For long-term maintenance, screenshots can be automated later with a small Playwright script that:

- starts the dev app or opens prepared UI states,
- loads sanitized fixture data only,
- captures fixed-size screenshots,
- writes them back to this directory.

Manual screenshots are still acceptable before the UI stabilizes. Do not commit generated screenshots until they have been reviewed for privacy.

## Guidelines

- Prefer PNG for screenshots and SVG for diagrams.
- Keep each image reasonably small before committing.
- Avoid screenshots with private clipboard content, personal paths, tokens, or account information.
- Use the same app theme, scaling, and sample data when updating screenshots so the README stays visually consistent across Windows and macOS.
