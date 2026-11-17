# WinUI 后续差异与决策清单

核对日期：2026-11-17。产品参照是正式 React WebView；“Vue”是此前对话中的简称，
本仓库的参照实现实际为 React。范围是本批 WinUI 修复及上游 macOS 引导合并后的源码。
本清单是下一批工作的决策输入，不代表已完成全产品实机验收，也不授权继续改动下述模块。

## 已确认的差异

以下差异均能从两侧当前代码确认；是否在每一种数据上都明显，仍需要对应样本验证。
保留原生宿主、控件和共享 Rust 核心，与恢复原版内容结构、操作和反馈并不冲突。

| 编号 / 优先级 | 模块 | WebView 参照 | 当前 WinUI | 建议与验收目标 |
| --- | --- | --- | --- | --- |
| D1 / 高 | 普通文件、多文件、文件夹的 Space 预览 | 文件类型图标、主文件名、紧凑路径、多文件提示、失效提示；图片/文本/PDF 按共享文件分类分流 | 原生 Reader 的 `files` 分支主要显示文件数量和换行路径，没有复刻该图文结构 | 建议恢复原版信息结构，继续使用原生 Reader；覆盖单文件、多文件、文件夹、失效路径，禁止扩大文件缩略图/视频解码范围 |
| D2 / 中 | 透明图片的大预览 | 图片及图片文件使用透明棋盘底 | 原生 Reader 的 `image` 分支直接使用 Image，没有相同棋盘底；主卡片已另行处理 | 建议只补齐原版透明底与边距；覆盖透明 PNG、小图、GIF、加载失败与连续切换，不新增媒体处理 |
| D3 / 高 | 队列粘贴失败后的恢复入口 | 错误区域直接提供“重试”和“删除失败项” | 当前错误使用 InfoBar，仅展示消息；仍可由列表项粘贴/移除，但缺少相同的就地操作入口 | 建议恢复同等可发现的两项操作，保留原生控件；不改共享队列消费、撤销或目标窗口逻辑 |
| D4 / 中 | 队列增删、状态更新的连续性 | 按 hash 保留行，使用 Motion 进入/退出和拖动位移 | 手柄排序已有实时补位；`RenderItems` 状态刷新仍清空并重建行，未等价复刻增删过渡 | 建议先测 100 项，再决定是否做按项复用与短过渡；验收焦点、滚动、撤销、并发捕获和排序后点击粘贴，不能只拍静态图 |
| D5 / 中 | 筛选标签中的来源应用选择 | 触发器含最多两个已选应用图标及摘要，展开为勾选菜单 | DropDownButton 只有文字摘要；Flyout 内增加搜索框和 CheckBox 列表 | 建议恢复图标摘要与原版信息层级；保留原生多选控件。是否保留额外搜索框由用户决定，不能以原生默认替代产品要求 |
| D6 / 中 | 富文本主卡片的排版精度 | 清洗后的 HTML/canvas，具有浏览器的排版能力 | 将内容投影为 runs/table，再由 RichTextBlock/Grid 排版；字体尺寸限制、表格宽度和图片约束并非完整 HTML/CSS | 建议以 Office、网页、代码、表格四类固定样本对照，优先修复可读性和信息丢失；保留原生卡片，不承诺任意 HTML 像素级一致，也不新增隐藏主 WebView |
| D7 / 低 | 搜索按钮融入输入框的过渡 | 同一搜索区保留图标，输入内容有短淡入/退出，空值失焦收起 | 当前同一 Grid 中切换搜索按钮和 AutoSuggestBox 的 Visibility，进入没有同等输入层过渡 | 建议恢复短反馈和相同收起语义；不能恢复之前被否决的整窗拉扯/min-width 动画。中文输入法、Escape、清空及快速 Enter 需一并验收 |
| D8 / 可选 | 原生控件、材质及 Emoji 容器 | MUI/CSS 的菜单、控件与窗口材质；Emoji 使用辅助 WebView | WinUI Flyout/ContentDialog/GridView；主岛为 SDK DesktopAcrylicBackdrop，Emoji 使用系统字体网格 | 建议保留原生控件语义和系统材质，只对齐密度、位置和动作。Files Thin Acrylic 可另做预览选项；不要直接降低整个窗口透明度。Emoji 选项来源已共用，不是缺少列表内容 |

### 源码定位

- D1–D2：[参照 Preview](../../../src/clipboard/Preview.tsx)、
  [参照样式](../../../src/clipboard/Preview.module.css)、
  [原生预览分流](../../../src-tauri/src/winui_panel/reader.rs) 的 `native_body` / `prepare`、
  [原生 Reader](../../../src-tauri/native-demo/windows/winui/WinUiReader.cpp) 的 `Show`。
- D3–D4：[参照 PasteQueue](../../../src/clipboard/PasteQueue.tsx) 的 `state.error` / keyed rows、
  [原生 QueueView](../../../src-tauri/native-demo/windows/winui/WinUiQueueView.cpp) 的
  `RenderItems` / `SetState` / `ApplyTheme`。本批已把队列排序改为 pointer capture 实时补位，
  因而旧记录中的“OLE 插入线排序”和“移除按钮始终显示”不再是当前差异。
- D5：[参照 TabEditor](../../../src/clipboard/TabEditor.tsx) 的来源应用区域、
  [原生 FilterEditor](../../../src-tauri/native-demo/windows/winui/WinUiFilterEditor.cpp)
  的 `SourceSummary` / `RenderSources`。
- D6：[参照卡片](../../../src/clipboard/ClipboardCardPreview.tsx) 的 `RichTextPreview`、
  [原生 rich 投影](../../../src-tauri/src/winui_panel/presentation.rs)、
  [原生 rich 排版](../../../src-tauri/native-demo/windows/winui/WinUiRichContent.cpp)。
- D7：[参照 Clipboard](../../../src/clipboard/Clipboard.tsx) 的 `clipboard-search-layout`、
  [原生 Panel](../../../src-tauri/native-demo/windows/winui/WinUiPanel.cpp) 的 `ShowSearch` / `SearchChanged`。
- D8：[参照 EmojiPicker](../../../src/clipboard/EmojiPicker.tsx)、
  [原生 NameEmoji](../../../src-tauri/native-demo/windows/winui/WinUiNameEmoji.cpp)、
  [材质比较记录](../development/windows-winui-bridge.md#material-comparison-files-2026-11-17)。

## 已有实现、仍需专项验收的模块

这些不是已确认缺失的功能，不能因为人工尚未覆盖就写成“未实现”，也不能因为单测通过就写成完全对齐。

| 模块 | 具体需要核对的完整场景 | 当前证据与下一步 |
| --- | --- | --- |
| 主窗口、标签、卡片动效 | 快速开关/反向开关；标签连续点击与拖动取消；搜索跨日期结果；关闭动画时立即完成 | 有源码、策略和 loaded-XAML 回归；真实桌面卡顿、残影与 DWM 阴影仍需集中实测。先保留本批修复，不另起一套动画 |
| 预览混合渲染器 | 原生文本/图片/文件与 WebView 富文本/链接/PDF/OCR/超大内容之间来回切换；固定、取消、慢内容、失焦 | 原生 Reader 与 WebView fallback 是当前实际架构，已做 ready 后交接和连续尺寸过渡。连续同类型和跨类型必须分别检查，不能以 HWND 不变替代过渡验收 |
| 编辑和 OCR | 普通/富文本编辑保存、空内容拒绝、并发版本冲突、Escape、输入法、OCR 尚在生成时的编辑 | 继续使用共享 Rust 与现有辅助 WebView；需要针对真实入口核对，不把这些窗口误报为已全部原生化 |
| 卡片右键与记录标签 | 按 Text/Image/File/Link/Color/富文本逐项比较菜单条件、子菜单、快捷键、标签分配/删除、取消后焦点 | 共享命令存在不等于显示条件和事件顺序一致；下一批建立逐类型菜单清单，不先凭印象删功能 |
| 设置驱动的主面板行为 | 记住/重置标签与位置、单击粘贴、快速输入、纯文本快捷键、悬停预览、窗口高度、中英文与主题 | [设置 consumer 清单](windows-winui-settings-parity.md)已逐字段记录。两侧都没有 consumer 的 legacy 字段不是 WinUI 漏实现；真实开关→重复唤起仍需验收 |
| 设置窗口拖动 | 按住移动、释放后直接点击其他应用、跨屏、关闭再打开 | WebView2 caption region 与无竞争拖动 IPC 的 actual-App 路由已检查；用户报告的物理卡顿/释放后阻塞不能据此标记已解决，应优先集中验证 |
| 向外拖放与粘贴目标 | 各类型拖到 OneNote/QQ/微信/资源管理器；多文件；取消；失败后再拖；主卡片内部不出现无效拖动反馈 | 用户已有外拖成功反馈；本轮队列排序与主卡片外拖为不同机制。回归应覆盖相邻成功路径，不能为修队列改外拖提供器 |
| 托盘与辅助窗口 | 冷/热右键响应，旧外观、完整菜单和退出；设置销毁；预览复用；引导完成不闪回 | 托盘仍为原 styled WebView，按用户要求没有原生化。预热降低首开开销但有资源代价，要与下述内存分析一起衡量 |

## 建议实施顺序

1. **先恢复明确的信息和操作缺口**：用户确认后处理 D1、D2、D3、D5；每项有参照样本及前后回归。
2. **再做连续性和复杂内容对照**：D4、D6、D7；记录 100 项队列、固定富文本样本和端到端查询耗时，
   维持主窗口布局和已成功外拖行为。D8 的材质换配方单独预览，不混入功能修复。
3. **完成行为与资源验收**：上述专项场景按风险集中运行；额外采集 Release 的进程树、Private Bytes、
   Working Set、WebView 子进程、图片解码/图标缓存和打开关闭后的残留。历史“约 600 MB”尚无完整归因，
   不把 Debug 单个指标当成 Release 内存结论，也不承诺未经测量的降幅。
4. **平台与交付收尾**：混合 DPI 100/150/200%、多屏/任务栏/工作区变化、Windows 10 材质回退、
   高对比度/关闭动画、macOS 编译及核心场景、安装包/Windows App SDK 运行时；之后才讨论切默认 renderer。

Windows 本机不能证明 macOS 编译和行为通过。上游 macOS 原生 DEV 引导必须保留，
不要为 Windows 对齐删掉 Mac 入口或共用配置。设置页维持 React 按需创建、关闭销毁，
不重新列入原生化计划。正式版发布和默认 renderer 切换均需另行决定。

## 验证和测试安排

- 静默：源代码/策略回归、Rust/前端单测、编译、无头浏览器与固定数据基准。
- 集中一次：确需映射原生窗口的 XAML/HWND 检查，提前说明；不在每个小改动后抢占前台。
- 人工：真实鼠标/键盘与外部应用、系统动效和混合 DPI。每次只交付本批确实改动的场景，
  附预期结果；不把完整迁移清单重复当成每轮手测任务。
- 证据级别延续[验收矩阵](windows-winui-acceptance-matrix.md)；每项记录通过/失败/未测，
  不用静态截图、源码断言或合成事件替代物理验收。视觉测试保持本地，不手动 dispatch Actions。
