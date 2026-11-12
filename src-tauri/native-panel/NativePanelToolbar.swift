import AppKit
import SwiftUI

@MainActor
protocol PanelToolbarContent: AnyObject {
  var onFilter: ((Int) -> Void)? { get set }
  var onAddTag: (() -> Void)? { get set }
  var onRefresh: (() -> Void)? { get set }
  var onClose: (() -> Void)? { get set }
  var onSettings: (() -> Void)? { get set }
  var onDiagnostics: (() -> Void)? { get set }
  func beginSearch()
  func endEmptySearch()
  func setSelection(_ index: Int)
  func setTags(_ names: [String])
  func setInfoVisible(_ visible: Bool)
  func releaseContent()
}

// Stable AppKit boundary: the controller keeps owning search/IME and window
// behavior, while actual buttons, labels and filter content are SwiftUI views.
@MainActor
final class PanelToolbar: NSView {
  var onFilter: ((Int) -> Void)?
  var onAddTag: (() -> Void)?
  var onRefresh: (() -> Void)?
  var onClose: (() -> Void)?
  var onSettings: (() -> Void)?
  var onDiagnostics: (() -> Void)?
  private var content: (NSView & PanelToolbarContent)?
  private(set) var rendererName = "unconfigured"

  func configure(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    guard content == nil else { return }
    let view: NSView & PanelToolbarContent
    if #available(macOS 12.0, *) {
      view = PanelSwiftUIToolbarHost(scale: scale, chinese: chinese, search: search)
      rendererName = "SwiftUI"
    } else {
      let fallback = PanelLegacyToolbar()
      fallback.configure(scale: scale, chinese: chinese, search: search)
      view = fallback
      rendererName = "AppKit fallback"
    }
    view.onFilter = { [weak self] in self?.onFilter?($0) }
    view.onAddTag = { [weak self] in self?.onAddTag?() }
    view.onRefresh = { [weak self] in self?.onRefresh?() }
    view.onClose = { [weak self] in self?.onClose?() }
    view.onSettings = { [weak self] in self?.onSettings?() }
    view.onDiagnostics = { [weak self] in self?.onDiagnostics?() }
    view.frame = bounds
    view.autoresizingMask = [.width, .height]
    addSubview(view)
    content = view
  }
  func beginSearch() { content?.beginSearch() }
  func endEmptySearch() { content?.endEmptySearch() }
  func setSelection(_ index: Int) { content?.setSelection(index) }
  func setTags(_ names: [String]) { content?.setTags(names) }
  func setInfoVisible(_ visible: Bool) { content?.setInfoVisible(visible) }
  func releaseContent() {
    content?.releaseContent()
    content?.removeFromSuperview()
    content = nil
    onFilter = nil
    onAddTag = nil
    onRefresh = nil
    onClose = nil
    onSettings = nil
    onDiagnostics = nil
  }
}

extension PanelLegacyToolbar: PanelToolbarContent {
  // shortcut: the macOS 11 fallback toolbar shows no record-tag tabs, upgrade if macOS 11 must filter by tag
  func setTags(_ names: [String]) {}
  func releaseContent() {
    onFilter = nil
    onAddTag = nil
    onRefresh = nil
    onClose = nil
    onSettings = nil
    onDiagnostics = nil
  }
}

struct PanelFilterChoice {
  let title: String
  let emoji: String
  let symbol: String
  // Fixed tabs carry a symbol, type tabs an emoji, record-tag tabs neither.
  var isFixed: Bool { !symbol.isEmpty }
  var label: String { emoji.isEmpty ? title : "\(emoji) \(title)" }
  func width(scale: CGFloat, selected: Bool = false) -> CGFloat {
    let text = (label as NSString).size(withAttributes: [
      .font: PanelToolbarTypography.tabFont(scale: scale, selected: selected)
    ]).width
    // Fixed tabs include the 17px icon, 5px gap and asymmetric 10/23px padding.
    // Type tabs render the same single emoji-prefixed label as the WebView.
    let extra: CGFloat = (isFixed ? 55 : 20) * scale
    // .tab-item.record has a 74px minimum width in the WebView.
    let minimum: CGFloat = isFixed ? 78 : emoji.isEmpty ? 74 : 58
    return min(128 * scale, max(minimum * scale, text + extra))
  }
}

// History query label per tab: the fixed filters, then one tab per record tag
// (same payload as the WebView record-tag tab).
enum PanelFilterQuery {
  private static let types = ["", "", "Text", "Image", "Link", "Color", "File"]
  static func count(tags: [PanelTag]) -> Int { types.count + tags.count }
  static func label(index: Int, tags: [PanelTag]) -> String? {
    guard index >= 0, index < count(tags: tags) else { return nil }
    if index == 0 { return "" }
    if index == 1 { return "__favorite" }
    let payload: [String: Any] =
      index < types.count
      ? ["mode": "all", "item_type": types[index]]
      : ["mode": "record-tag", "record_tag_ids": [tags[index - types.count].id]]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
    return "__filter:" + String(decoding: data, as: UTF8.self)
  }
}

// Shared selection underline for the SwiftUI filter strip. Mirrors the
// WebView indicator's 10px inset and 3px height inside the tab bounds.
enum PanelFilterIndicatorLayout {
  static func rect(choices: [PanelFilterChoice], selected: Int, scale: CGFloat) -> CGRect? {
    guard choices.indices.contains(selected) else { return nil }
    let gap = 8 * scale
    var x: CGFloat = 0
    for index in 0..<selected {
      x += choices[index].width(scale: scale) + gap
    }
    let width = choices[selected].width(scale: scale, selected: true) - 20 * scale
    return CGRect(x: x + 10 * scale, y: 0, width: max(0, width), height: 3 * scale)
  }
  // Add button after the tabs: .tab-add-button is 36px wide with a 1px margin.
  static let addButtonWidth: CGFloat = 36
  static let addButtonMargin: CGFloat = 1
  static func extent(choices: [PanelFilterChoice], selected: Int, scale: CGFloat) -> CGFloat {
    let widths = choices.enumerated().map {
      $0.element.width(scale: scale, selected: $0.offset == selected)
    }
    return widths.reduce(0, +) + 8 * scale * CGFloat(max(0, widths.count - 1))
      + (addButtonMargin + addButtonWidth) * scale
  }
}

@available(macOS 12.0, *)
@MainActor
final class PanelToolbarState: ObservableObject {
  @Published var selected = 0
  @Published var infoVisible = false
  @Published private(set) var searchOpen = false
  let scale: CGFloat
  let chinese: Bool
  let search: NSSearchField
  @Published private(set) var choices: [PanelFilterChoice]
  private let fixedChoices: [PanelFilterChoice]
  private(set) var closed = false
  var onFilter: ((Int) -> Void)?
  var onAddTag: (() -> Void)?
  var onRefresh: (() -> Void)?
  var onClose: (() -> Void)?
  var onSettings: (() -> Void)?
  var onDiagnostics: (() -> Void)?

  init(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    self.scale = scale
    self.chinese = chinese
    self.search = search
    fixedChoices = [
      ("All", "全部", "", "square.grid.3x3.fill"), ("Favorites", "收藏", "", "star"),
      ("Text", "文本", "📝", ""), ("Image", "图片", "🖼️", ""), ("Link", "链接", "🔗", ""),
      ("Color", "颜色", "🎨", ""), ("File", "文件", "📁", ""),
    ].map { PanelFilterChoice(title: chinese ? $0.1 : $0.0, emoji: $0.2, symbol: $0.3) }
    choices = fixedChoices
    search.isHidden = true
    search.font = PanelToolbarTypography.font(size: 13 * scale, cssWeight: 450)
    search.controlSize = .small
    search.focusRingType = .exterior
  }
  func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }
  func setTags(_ names: [String]) {
    choices = fixedChoices + names.map { PanelFilterChoice(title: $0, emoji: "", symbol: "") }
  }
  func choose(_ index: Int) {
    guard !closed, choices.indices.contains(index) else { return }
    if selected != index { selected = index }
    onFilter?(index)
  }
  func beginSearch() {
    guard !closed else { return }
    searchOpen = true
    search.isHidden = false
  }
  func endEmptySearch() {
    guard search.stringValue.isEmpty else { return }
    searchOpen = false
    search.isHidden = true
  }
  func close() {
    closed = true
    onFilter = nil
    onAddTag = nil
    onRefresh = nil
    onClose = nil
    onSettings = nil
    onDiagnostics = nil
    searchOpen = false
  }
}

// Toolbar buttons use pointer actions and explicit window shortcuts. Keep both
// hosting surfaces out of AppKit's key-view loop; the embedded NSSearchField
// remains independently focusable for text input.
@available(macOS 12.0, *)
@MainActor
class PanelToolbarHostingView<Content: View>: NSHostingView<Content> {
  override var acceptsFirstResponder: Bool { false }
  override var canBecomeKeyView: Bool { false }
}

@available(macOS 12.0, *)
@MainActor
final class PanelSwiftUIToolbarHost: PanelToolbarHostingView<PanelToolbarView>, PanelToolbarContent {
  private let state: PanelToolbarState
  private var focusRequest = 0
  init(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    state = PanelToolbarState(scale: scale, chinese: chinese, search: search)
    super.init(rootView: PanelToolbarView(state: state))
    rootView.onSearch = { [weak self] in self?.toggleSearch() }
  }
  required init(rootView: PanelToolbarView) { fatalError("Use the configured initializer") }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  var onFilter: ((Int) -> Void)? { get { state.onFilter } set { state.onFilter = newValue } }
  var onAddTag: (() -> Void)? { get { state.onAddTag } set { state.onAddTag = newValue } }
  var onRefresh: (() -> Void)? { get { state.onRefresh } set { state.onRefresh = newValue } }
  var onClose: (() -> Void)? { get { state.onClose } set { state.onClose = newValue } }
  var onSettings: (() -> Void)? { get { state.onSettings } set { state.onSettings = newValue } }
  var onDiagnostics: (() -> Void)? { get { state.onDiagnostics } set { state.onDiagnostics = newValue } }
  func beginSearch() {
    state.beginSearch()
    focusRequest &+= 1
    let request = focusRequest
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.state.closed, self.state.searchOpen, self.focusRequest == request else { return }
      self.layoutSubtreeIfNeeded()
      self.window?.makeFirstResponder(self.state.search)
    }
  }
  private func toggleSearch() {
    if state.searchOpen {
      window?.makeFirstResponder(nil)
      state.endEmptySearch()
    } else {
      beginSearch()
    }
  }
  func endEmptySearch() { state.endEmptySearch() }
  func setSelection(_ index: Int) {
    if state.choices.indices.contains(index), state.selected != index { state.selected = index }
  }
  func setInfoVisible(_ visible: Bool) { state.infoVisible = visible }
  func setTags(_ names: [String]) { state.setTags(names) }
  func releaseContent() {
    focusRequest &+= 1
    rootView.onSearch = nil
    state.close()
  }
}

@available(macOS 12.0, *)
@MainActor
struct PanelToolbarView: View {
  @ObservedObject var state: PanelToolbarState
  @Environment(\.colorScheme) private var scheme
  var onSearch: (() -> Void)?
  private var dark: Bool { scheme == .dark }
  private var accent: Color { Color(PanelStyle.rgb(dark ? 0x8ab7ff : 0x2466d8)) }
  var body: some View {
    GeometryReader { geometry in
      let s = state.scale
      let button = 28 * s
      let pad = 28 * s
      let gap = 8 * s
      let developerWidth = 140 * s
      let closeX = geometry.size.width - pad - button / 2
      let settingsX = closeX - button - gap
      let developerX = settingsX - button / 2 - gap - developerWidth / 2
      let fieldWidth = min(276 * s, max(100 * s,
        geometry.size.width - 2 * pad - 140 * s - 3 * button - 4 * gap - 68 * s))
      let left = pad + button + 15 * s + (state.searchOpen ? fieldWidth + 12 * s : 0)
      let tabsWidth = max(50 * s, developerX - developerWidth / 2 - left - 10 * s)
      ZStack(alignment: .topLeading) {
        LinearGradient(
          colors: [Color(PanelStyle.rgb(dark ? 0x252b33 : 0xffffff, dark ? 0.92 : 0.90)),
            Color(PanelStyle.rgb(dark ? 0x161b22 : 0xf2f5f2, dark ? 0.86 : 0.82))],
          startPoint: .top, endPoint: .bottom)
        VStack(spacing: 0) {
          (dark ? Color.white.opacity(0.08) : Color.white.opacity(0.58)).frame(height: s)
          Spacer(minLength: 0)
          Color(PanelStyle.rgb(dark ? 0xffffff : 0x747e7a, dark ? 0.08 : 0.14)).frame(height: s)
        }
        icon("magnifyingglass", state.local("Search", "搜索"), active: state.searchOpen) { onSearch?() }
          .position(x: pad + button / 2, y: geometry.size.height / 2)
        PanelNativeSearch(search: state.search, open: state.searchOpen)
          .frame(width: fieldWidth, height: 32 * s)
          .opacity(state.searchOpen ? 1 : 0)
          .allowsHitTesting(state.searchOpen)
          .accessibilityHidden(!state.searchOpen)
          .position(x: pad + button + 7 * s + fieldWidth / 2, y: geometry.size.height / 2)
        PanelFilterViewport(state: state, width: tabsWidth, height: geometry.size.height)
          .frame(width: tabsWidth, height: geometry.size.height)
          .position(x: left + tabsWidth / 2, y: geometry.size.height / 2)
        HStack(spacing: 3 * s) {
          HStack(spacing: 0) {
            Text("DEV").tracking(0.72 * s)
            Text(" · SwiftUI")
          }
          .font(Font(PanelToolbarTypography.font(size: 9 * s, cssWeight: 800)))
          .lineLimit(1).accessibilityElement(children: .combine)
          .foregroundColor(accent).frame(width: 66 * s, alignment: .leading)
          icon("arrow.clockwise", state.local("Refresh", "刷新")) { state.onRefresh?() }
          icon("info.circle", state.local("Memory and history details", "内存与历史记录统计"),
            active: state.infoVisible) { state.onDiagnostics?() }
        }
        .padding(.leading, 9 * s).frame(width: developerWidth, height: 32 * s, alignment: .leading)
        .background(Capsule().fill(Color(PanelStyle.rgb(dark ? 0x21262d : 0xffffff, dark ? 0.64 : 0.44))))
        .overlay(Capsule().stroke(Color(PanelStyle.rgb(dark ? 0xdde2eb : 0x2a3230, 0.13)), lineWidth: s))
        .position(x: developerX, y: geometry.size.height / 2)
        icon("gearshape", state.local("Settings", "设置")) { state.onSettings?() }
          .position(x: settingsX, y: geometry.size.height / 2)
        icon("xmark", state.local("Close native panel", "关闭原生主界面")) { state.onClose?() }
          .position(x: closeX, y: geometry.size.height / 2)
      }
    }
  }
  private func icon(_ symbol: String, _ label: String, active: Bool = false,
    action: @escaping () -> Void) -> some View {
    PanelSwiftUIIcon(symbol: symbol, label: label, scale: state.scale,
      dark: dark, active: active, action: action)
  }
}

@available(macOS 12.0, *)
@MainActor
private struct PanelButtonCursor: NSViewRepresentable {
  @Environment(\.isEnabled) private var isEnabled
  func makeNSView(context: Context) -> PanelCursorRegion { PanelCursorRegion(cursor: .pointingHand) }
  func updateNSView(_ view: PanelCursorRegion, context: Context) { view.isEnabled = isEnabled }
  static func dismantleNSView(_ view: PanelCursorRegion, coordinator: ()) { view.isEnabled = false }
}

@available(macOS 12.0, *)
@MainActor
private struct PanelSwiftUIIcon: View {
  let symbol: String
  let label: String
  let scale: CGFloat
  let dark: Bool
  let active: Bool
  let action: () -> Void
  private var symbolSize: CGFloat {
    // SF Symbols have no SVG viewBox padding. Match the visible glyph size of
    // the WebView's 16px MUI search/settings icons inside the same 28pt button.
    switch symbol {
    case "magnifyingglass": return 12
    case "gearshape": return 13.5
    default: return 16
    }
  }
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: symbolSize * scale))
        .frame(width: 28 * scale, height: 28 * scale)
    }
    .buttonStyle(PanelIconStyle(scale: scale, dark: dark, active: active))
    .focusable(false)
    .help(label).accessibilityLabel(Text(label))
  }
}

@available(macOS 12.0, *)
private struct PanelIconStyle: ButtonStyle {
  let scale: CGFloat
  let dark: Bool
  let active: Bool
  @State private var hovering = false
  func makeBody(configuration: Configuration) -> some View {
    let accent = Color(PanelStyle.rgb(dark ? 0x8ab7ff : 0x2466d8))
    let color = Color(PanelStyle.rgb(dark ? 0xdde2eb : 0x2a3230, dark ? 0.68 : 0.62))
    let fill = active ? accent.opacity(0.16)
      : Color(PanelStyle.rgb(dark ? (hovering ? 0x2d333c : 0x21262d) : 0xffffff,
        dark ? (hovering ? 0.82 : 0.64) : (hovering ? 0.92 : 0.72)))
    return configuration.label.foregroundColor(active ? accent : color)
      .background(Circle().fill(fill).padding(scale))
      .overlay(Circle().stroke(Color(PanelStyle.rgb(dark ? 0xdde2eb : 0x2a3230, 0.08)), lineWidth: scale).padding(scale))
      .shadow(color: .black.opacity(dark ? 0.24 : 0.09), radius: 3 * scale, x: 0, y: scale)
      .opacity(configuration.isPressed ? 0.72 : 1)
      .background(PanelButtonCursor().accessibilityHidden(true))
      .onHover { hovering = $0 }
  }
}

@available(macOS 12.0, *)
private struct PanelNativeSearch: NSViewRepresentable {
  let search: NSSearchField
  let open: Bool
  func makeNSView(context: Context) -> NSSearchField { search }
  func updateNSView(_ view: NSSearchField, context: Context) { view.isHidden = !open }
}

// The scroll viewport retains the already-verified wheel-axis mapping. Its
// document is a SwiftUI filter row, not a set of manually drawn AppKit buttons.
@available(macOS 12.0, *)
@MainActor
private struct PanelFilterViewport: NSViewRepresentable {
  @ObservedObject var state: PanelToolbarState
  let width: CGFloat
  let height: CGFloat
  final class Coordinator {
    var host: PanelToolbarHostingView<PanelFilterStrip>?
    var selection: Int?
  }
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeNSView(context: Context) -> PanelScroll {
    let scroll = PanelScroll()
    scroll.drawsBackground = false
    scroll.setAccessibilityLabel(state.local("History filters", "历史记录筛选"))
    let host = PanelToolbarHostingView(rootView: PanelFilterStrip(state: state))
    context.coordinator.host = host
    scroll.documentView = host
    return scroll
  }
  func updateNSView(_ scroll: PanelScroll, context: Context) {
    let widths = state.choices.enumerated().map {
      $0.element.width(scale: state.scale, selected: $0.offset == state.selected)
    }
    let gap = 8 * state.scale
    let extent = PanelFilterIndicatorLayout.extent(
      choices: state.choices, selected: state.selected, scale: state.scale)
    let size = NSSize(width: max(width, extent), height: height)
    if context.coordinator.host?.frame.size != size {
      context.coordinator.host?.setFrameSize(size)
    }
    if context.coordinator.selection != state.selected, widths.indices.contains(state.selected) {
      context.coordinator.selection = state.selected
      let x = widths.prefix(state.selected).reduce(0, +) + gap * CGFloat(state.selected)
      let target = NSRect(x: x, y: 0, width: widths[state.selected], height: height)
      context.coordinator.host?.scrollToVisible(target)
    }
  }
  static func dismantleNSView(_ scroll: PanelScroll, coordinator: Coordinator) {
    scroll.documentView = nil
    coordinator.host = nil
    coordinator.selection = nil
  }
}

@available(macOS 12.0, *)
@MainActor
private struct PanelFilterStrip: View {
  @ObservedObject var state: PanelToolbarState
  @Environment(\.colorScheme) private var scheme
  private var gap: CGFloat { 8 * state.scale }
  var body: some View {
    ZStack(alignment: .bottomLeading) {
      HStack(spacing: PanelFilterIndicatorLayout.addButtonMargin * state.scale) {
      HStack(spacing: gap) {
        ForEach(state.choices.indices, id: \.self) { index in
          let choice = state.choices[index]
          let selected = state.selected == index
          Button { state.choose(index) } label: {
            HStack(spacing: 5 * state.scale) {
              if choice.isFixed {
                // MUI's 24-unit SVG uses 16 units for the grid, 20 for the star.
                // Keep the 17pt layout box while matching its visible artwork.
                let extent: CGFloat = choice.symbol == "star" ? 20 : 16
                Image(systemName: choice.symbol).font(.system(size: 17 * extent / 24 * state.scale))
                  .frame(width: 17 * state.scale, height: 17 * state.scale)
              }
              Text(choice.label)
                .font(Font(PanelToolbarTypography.tabFont(scale: state.scale, selected: selected)))
                .lineLimit(1).frame(height: PanelToolbarTypography.lineHeight * state.scale)
            }
            .padding(.leading, 10 * state.scale)
            .padding(.trailing, (choice.isFixed ? 23 : 10) * state.scale)
            .frame(width: choice.width(scale: state.scale, selected: selected), height: PanelStyle.headerHeight * state.scale)
          }
          .buttonStyle(PanelFilterStyle(scale: state.scale, selected: selected, dark: scheme == .dark))
          .focusable(false)
          .accessibilityLabel(Text(choice.title))
          .accessibilityValue(Text(selected ? state.local("Selected", "已选择") : ""))
        }
      }
      Button { state.onAddTag?() } label: {
        Image(systemName: "plus").font(.system(size: 13 * state.scale))
          .frame(width: PanelFilterIndicatorLayout.addButtonWidth * state.scale,
            height: PanelStyle.headerHeight * state.scale)
      }
      .buttonStyle(PanelFilterStyle(scale: state.scale, selected: false, dark: scheme == .dark))
      .focusable(false)
      .help(state.local("Add Tab", "添加标签"))
      .accessibilityLabel(Text(state.local("Add Tab", "添加标签")))
      }
      selectionIndicator
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
  // Mirrors ClipboardTabBar's shared layoutId indicator: one accent underline
  // glides between tabs instead of each tab drawing its own.
  @ViewBuilder private var selectionIndicator: some View {
    if let rect = indicatorRect {
      Capsule()
        .fill(Color(PanelStyle.rgb(scheme == .dark ? 0x8ab7ff : 0x2466d8)))
        .frame(width: rect.width, height: rect.height)
        .offset(x: rect.minX)
        .animation(selectionAnimation, value: state.selected)
        .accessibilityHidden(true)
    }
  }
  private var indicatorRect: CGRect? {
    PanelFilterIndicatorLayout.rect(choices: state.choices, selected: state.selected, scale: state.scale)
  }
  // Same layout spring as src/ui/motion/tokens.ts motionSprings.layout.
  private var selectionAnimation: Animation? {
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      ? nil : .interpolatingSpring(mass: 0.9, stiffness: 320, damping: 34)
  }
}

@available(macOS 12.0, *)
private struct PanelFilterStyle: ButtonStyle {
  let scale: CGFloat
  let selected: Bool
  let dark: Bool
  @State private var hovering = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundColor(Color(PanelStyle.rgb(selected ? (dark ? 0x8ab7ff : 0x2466d8) : (dark ? 0xdde2eb : 0x2a3230),
        selected ? 1 : (dark ? 0.68 : 0.62))))
      .background(Color.white.opacity(hovering ? (dark ? 0.07 : 0.30) : 0))
      .opacity(configuration.isPressed ? 0.72 : 1)
      .background(PanelButtonCursor().accessibilityHidden(true))
      .onHover { hovering = $0 }
  }
}
