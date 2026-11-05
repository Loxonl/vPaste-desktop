# Release Notes Format and Template

This is the shared release-note format for Windows and macOS maintainers, for
both Stable and RC releases. Use it with the [release checklist](release-checklist.md).
The [v1.7.0 notes](https://github.com/Loxonl/vPaste-desktop/releases/tag/v1.7.0)
are a published example, not a list of changes to copy into later versions.

## Writing rules

1. Set the GitHub Release title to exactly its tag, such as `v1.7.0` or
   `v1.7.1-rc.1`. Start the body with `## English`; do not repeat the product
   and version in a `# vPaste ...` heading.
2. Put `## English` before `## 中文`, with matching user-facing changes in
   both languages. Under each language, use these categories in order and omit
   empty categories:
   - `### ✨ New features` / `### ✨ 新功能`
   - `### ⚙️ Improvements` / `### ⚙️ 优化`
   - `### 🐛 Fixes` / `### 🐛 修复`
   - `### ⚠️ Notes` / `### ⚠️ 注意事项`, only for relevant warnings or actions
3. Use unordered lists. Each item is `- **Feature name**: one short sentence`
   or `- **功能名称**：一句简短说明`. Use the actual feature or component name,
   such as **Mouse controls**, **Preview focus**, **鼠标操作**, or **预览焦点**.
   Avoid vague comparisons, metaphors, and promotional labels such as
   “More flexible mouse controls” or “更灵活的鼠标操作”. Put the colon outside
   the bold delimiters so Chinese labels render correctly on GitHub.
4. Describe the addition, adjustment, or bug directly in one sentence. Do not
   substitute generated PR titles for reviewed bilingual summaries; original
   PR references may remain in a collapsed details block.
5. Notes must apply to the current release. Do not carry forward stock
   v1.6.x history-format or old-backup reminders by default. Keep a compatibility
   warning when the actual release requires user action or changes support.
   While Windows packages remain unsigned, retain the Unknown publisher and
   SmartScreen warning in both language sections.
6. Do not add a `Packages / 安装包` section or package-type boilerplate.
   Source and compare links may occupy one shared line after the language
   sections and before the download table.
7. End the body with the managed manual-download table immediately above Assets.
   The download block contains only the table: no `Downloads / 下载` heading,
   explanatory paragraphs, checksum links, or metadata links. Checksums,
   licenses, signatures, and updater archives remain available in Assets;
   removing note text does not remove those files or their validation.
8. Preview the final body with GitHub's Markdown renderer. Check category order,
   bold labels, bilingual content, current warnings, and actual download URLs.
   When editing historical notes, preserve maintenance warnings and lifecycle
   metadata unless their removal was explicitly approved; never replace assets,
   tags, release dates, Stable/RC status, or updater feeds to restyle a page.

## Copyable body

Replace the example labels and descriptions, remove empty categories, and fill
in the actual source SHA and comparison tags. Keep the Windows warning while
the unsigned-package policy is active.

```markdown
## English

### ✨ New features

- **Feature name**: Describe the addition in one short sentence

### ⚙️ Improvements

- **Feature name**: Describe the adjustment in one short sentence

### 🐛 Fixes

- **Component name**: Describe the bug fixed in one short sentence

### ⚠️ Notes

- **Windows signature**: Windows packages are unsigned and may show “Unknown publisher” or SmartScreen warnings

## 中文

### ✨ 新功能

- **功能名称**：用一句话说明新增功能

### ⚙️ 优化

- **功能名称**：用一句话说明调整内容

### 🐛 修复

- **组件名称**：用一句话说明修复的问题

### ⚠️ 注意事项

- **Windows 签名**：Windows 安装包暂未签名，可能显示「未知发布者」或 SmartScreen 提示

[Source / 源码](https://github.com/Loxonl/vPaste-desktop/commit/<full-source-sha>) · [Full changelog / 完整变更](https://github.com/Loxonl/vPaste-desktop/compare/<previous-tag>...<new-tag>)
```

## Download automation

Do not copy a previous version's download URLs. After packages are uploaded,
the existing workflows call `scripts/update-release-downloads.mjs` to append
the real table between `<!-- vpaste-downloads:start -->` and
`<!-- vpaste-downloads:end -->`. Hidden markers are retained for safe refreshes.
For a manual refresh, preview before publishing:

```powershell
node scripts/update-release-downloads.mjs --repo Loxonl/vPaste-desktop --tag v<version>
node scripts/update-release-downloads.mjs --repo Loxonl/vPaste-desktop --tag v<version> --publish
```

The helper validates uploaded manual-install packages and `SHA256SUMS.txt`,
normalizes the language order and unsafe bold labels, and replaces only its
managed download block. It does not invent translations, classify changes,
rewrite feature names, or remove handwritten headings or warnings. Maintainers
must author and review the body using the format above, including for a private
draft whose initial workflow-generated notes are only a starting point.
