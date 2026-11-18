# WinUI 后续差异与决策清单

核对日期：2026-11-17。产品参照是正式 React WebView；“Vue”是此前对话中的简称，
本仓库的参照实现实际为 React。D1–D8 已由用户整体授权，并按编号完成本批实现；
下表记录开发结果，详细验证边界见[验收矩阵](windows-winui-acceptance-matrix.md#2026-11-17-eight-item-parity-follow-up)。
这不代表已完成全产品实机验收，也不自动授权后续 renderer 切换、材质更换或发布。

## D1–D8 开发结果

以下为本批之前确认的差异及修复结果；真实桌面输入、运动感受和跨平台仍需人工验证。
保留原生宿主、控件和共享 Rust 核心，与恢复原版内容结构、操作和反馈并不冲突。

| 编号 / 优先级 | 模块 | WebView 参照 | 本批 WinUI 实现 | 复查重点 |
| --- | --- | --- | --- | --- |
| D1 / 高 | 普通文件、多文件、文件夹的 Space 预览 | 类型图标、主文件名、紧凑路径、多文件及失效提示 | Reader 使用共享文件图标解析，恢复相同信息结构；保留原文件分类、PDF fallback 和媒体预算 | 单文件、文件夹、多文件、源文件已移动；视频仍不扩大解码 |
| D2 / 中 | 透明图片的大预览 | 图片及图片文件使用透明棋盘底，小图不放大 | 图片实际区域使用按 256 DIP 平铺的共享 8-DIP 棋盘；小图自然尺寸、主题和高对比回退 | 透明 PNG、小图、GIF、加载失败、快速连续切换 |
| D3 / 高 | 队列粘贴失败后的恢复入口 | 错误区域直接提供重试和删除 | InfoBar 内增加两项原生 Button，操作精确失败 hash；busy、重复及迟到请求继续受控，一般错误不关联旧失败项 | 目标暂不可用后的重试/删除、连续点击、失败项已被移除 |
| D4 / 中 | 队列增删、状态更新的连续性 | 按 hash 保留行，进入/退出和拖动位移 | 按 hash 复用控件，新增短淡入、移除非交互表面淡出；保留 pointer sorting，不新增 layout 补位动画 | 排序后点击粘贴、滚动、焦点、Undo、并发捕获；关闭动画立即完成。100 项组件对照见矩阵 |
| D5 / 中 | 筛选标签中的来源应用选择 | 最多两个已选应用图标及摘要 | 恢复无裁切图标、缺图占位及摘要；补齐参照的 44 项中英文进程名称映射，保留 searchable CheckBox 多选 | 0/1/2/3 项选择、缺图、中英文显示名和原名搜索；保存的来源标识不变 |
| D6 / 中 | 富文本主卡片的排版精度 | 清洗后的 HTML/canvas | 固定 Office/网页/代码/表格样本覆盖有限 class 样式、列表层级/序号、pt、删除线、受信图片尺寸和合并单元格；Mac 保持原转换入口 | 对照真实复制样本；原生投影仍不是完整 HTML/CSS，不承诺像素等同，不新增主 WebView |
| D7 / 低 | 搜索按钮融入输入框的过渡 | 输入层短反馈、空值失焦收起 | 原位输入层短淡入、返回搜索图标反馈；非空 120ms/清空 40ms 查询防抖，组合输入期间不查询或粘贴 | 中文输入法、清空、两次 Escape、快速 Enter、关闭动画；不动画窗口宽度 |
| D8 / 可选 | 原生控件、材质及 Emoji 容器 | 紧凑控件与原菜单内容 | 共享 32-DIP 紧凑动作按钮样式；Emoji 为 28-DIP 单元格、16 字号、224-DIP 内容宽，保留 112 项和原生键盘语义 | 鼠标/键盘选择、焦点、明暗主题。Acrylic 配方和整窗透明度未改；Files Thin Acrylic 仍需另行预览决定 |

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
| 卡片右键与记录标签 | 实测「复制并粘贴」与 Ctrl+C 到不同目标、记录标签勾选/新建和单卡删除后的焦点 | 已按确认方案精简 WinUI 菜单，保留专属操作和工具栏队列。后续只修复实测差异，不再另起一轮菜单重排 |
| 设置驱动的主面板行为 | 记住/重置标签与位置、单击粘贴、快速输入、纯文本快捷键、悬停预览、窗口高度、中英文与主题 | [设置 consumer 清单](windows-winui-settings-parity.md)已逐字段记录。两侧都没有 consumer 的 legacy 字段不是 WinUI 漏实现；真实开关→重复唤起仍需验收 |
| 设置窗口拖动 | 按住移动、释放后直接点击其他应用、跨屏、关闭再打开 | WebView2 caption region 与无竞争拖动 IPC 的 actual-App 路由已检查；用户报告的物理卡顿/释放后阻塞不能据此标记已解决，应优先集中验证 |
| 向外拖放与粘贴目标 | 各类型拖到 OneNote/QQ/微信/资源管理器；多文件；取消；失败后再拖；主卡片内部不出现无效拖动反馈 | 用户已有外拖成功反馈；本轮队列排序与主卡片外拖为不同机制。回归应覆盖相邻成功路径，不能为修队列改外拖提供器 |
| 托盘与辅助窗口 | 冷/热右键响应，旧外观、完整菜单和退出；设置销毁；预览复用；引导完成不闪回 | 托盘仍为原 styled WebView，按用户要求没有原生化。预热降低首开开销但有资源代价，要与下述内存分析一起衡量 |

## 本批之后的顺序

1. **优先验收主流程**：本轮右键；QQ 一次复制只生成一条；无搜索结果后继续输入或退格；
   Enter 回到原窗口粘贴；从工具栏打开队列后多选、排序、粘贴和撤销。仅修可复现差异。
2. **复核窗口与焦点**：PDF 内容内按 Esc、OCR 未固定时点外退出、跨类型预览连续切换；
   优先复测设置窗口拖动后其它应用能否正常点击，再查混合 DPI、主窗口记忆规则和托盘。
3. **量化暖态延迟与内存**：固定同一份数据和操作，比较 WinUI 与 WebView 的发布构建，
   记录主进程 Private Bytes、Working Set、WebView 子进程、打开/关闭后的残留和标签切换耗时。
   历史“约 600 MB”尚无完整归因，只优化有证据的来源。
4. **平台与交付收尾**：Windows 10 回退、高对比度/关闭动画、多屏及桌面变化、Windows App SDK
   安装验证，与 macOS 的共享逻辑回归。核验通过后再决定是否切换默认 renderer 和发布。

Windows 本机不能证明 macOS 编译和行为通过。上游 macOS 原生 DEV 引导必须保留，
不要为 Windows 对齐删掉 Mac 入口或共用配置。设置页维持 React 按需创建、关闭销毁，
不重新列入原生化计划。正式版发布和默认 renderer 切换均需另行决定。

## 验证和测试安排

- 静默：源代码/策略回归、Rust/前端单测、编译、无头浏览器与固定数据基准。
- 确需原生窗口的 XAML/HWND 检查优先用隔离桌面。只能在真实前台验收的场景集中一次，
  不在每个小改动后弹窗或操作前台。
- 验证和构建通过后，集中重启当前工作区的 DEV 测试进程，保留原有 renderer 参数。
  不关闭正式版或其他工作区的进程；构建失败时保留可用的测试版本。
- 人工：真实鼠标/键盘与外部应用、系统动效和混合 DPI。每次只交付本批确实改动的场景，
  附预期结果；不把完整迁移清单重复当成每轮手测任务。
- 证据级别延续[验收矩阵](windows-winui-acceptance-matrix.md)；每项记录通过/失败/未测，
  不用静态截图、源码断言或合成事件替代物理验收。视觉测试保持本地，不手动 dispatch Actions。
