import AppKit
import SwiftUI

@MainActor
protocol PanelToolbarContent: AnyObject {
  var onFilter: ((Int) -> Void)? { get set }
  var onAddTab: (() -> Void)? { get set }
  var onTabContextMenu: ((String, NSPoint) -> Void)? { get set }
  var onTabReorder: ((String, String, Bool) -> Void)? { get set }
  var onTabDragging: ((Bool) -> Void)? { get set }
  var onRefresh: (() -> Void)? { get set }
  var onClose: (() -> Void)? { get set }
  var onPasteQueue: (() -> Void)? { get set }
  var onSettings: (() -> Void)? { get set }
  var onDiagnostics: (() -> Void)? { get set }
  var onDeveloper: ((String) -> Void)? { get set }
  func beginSearch()
  func endEmptySearch()
  func setSelection(_ index: Int)
  func setTabs(_ tabs: [PanelTab])
  func setInfoVisible(_ visible: Bool)
  func setQueueActive(_ active: Bool)
  func setNavigationLocked(_ locked: Bool)
  func cancelInteraction()
  func releaseContent()
}

// Stable AppKit boundary: the controller keeps owning search/IME and window
// behavior, while SwiftUI hosts actions and AppKit owns the complete filter control.
@MainActor
final class PanelToolbar: NSView {
  var onFilter: ((Int) -> Void)?
  var onAddTab: (() -> Void)?
  var onTabContextMenu: ((String, NSPoint) -> Void)?
  var onTabReorder: ((String, String, Bool) -> Void)?
  var onTabDragging: ((Bool) -> Void)?
  var onRefresh: (() -> Void)?
  var onClose: (() -> Void)?
  var onPasteQueue: (() -> Void)?
  var onSettings: (() -> Void)?
  var onDiagnostics: (() -> Void)?
  var onDeveloper: ((String) -> Void)?
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
    view.onAddTab = { [weak self] in self?.onAddTab?() }
    view.onTabContextMenu = { [weak self] in self?.onTabContextMenu?($0, $1) }
    view.onTabReorder = { [weak self] in self?.onTabReorder?($0, $1, $2) }
    view.onTabDragging = { [weak self] in self?.onTabDragging?($0) }
    view.onRefresh = { [weak self] in self?.onRefresh?() }
    view.onClose = { [weak self] in self?.onClose?() }
    view.onPasteQueue = { [weak self] in self?.onPasteQueue?() }
    view.onSettings = { [weak self] in self?.onSettings?() }
    view.onDiagnostics = { [weak self] in self?.onDiagnostics?() }
    view.onDeveloper = { [weak self] in self?.onDeveloper?($0) }
    view.frame = bounds
    view.autoresizingMask = [.width, .height]
    addSubview(view)
    content = view
  }
  func beginSearch() { content?.beginSearch() }
  func endEmptySearch() { content?.endEmptySearch() }
  func setSelection(_ index: Int) { content?.setSelection(index) }
  func setTabs(_ tabs: [PanelTab]) { content?.setTabs(tabs) }
  func setInfoVisible(_ visible: Bool) { content?.setInfoVisible(visible) }
  func setQueueActive(_ active: Bool) { content?.setQueueActive(active) }
  func setNavigationLocked(_ locked: Bool) { content?.setNavigationLocked(locked) }
  func cancelInteraction() { content?.cancelInteraction() }
  func releaseContent() {
    content?.releaseContent()
    content?.removeFromSuperview()
    content = nil
    onFilter = nil
    onAddTab = nil
    onTabContextMenu = nil
    onTabReorder = nil
    onTabDragging = nil
    onRefresh = nil
    onClose = nil
    onPasteQueue = nil
    onSettings = nil
    onDiagnostics = nil
    onDeveloper = nil
  }
}

extension PanelLegacyToolbar: PanelToolbarContent {}

struct PanelFilterChoice: Equatable {
  let title: String
  let emoji: String
  let symbol: String
  // Fixed tabs carry a symbol. Dynamic tabs show their stored name, which
  // already includes any emoji prefix; `record` marks a record tag.
  var record = false
  var id = ""
  var isFixed: Bool { !symbol.isEmpty }
  var label: String { emoji.isEmpty ? title : "\(emoji) \(title)" }
  // Only the macOS 11 button strip retains WebView-compatible sizing.
  func width(scale: CGFloat, selected: Bool = false) -> CGFloat {
    let text = (label as NSString).size(withAttributes: [
      .font: PanelToolbarTypography.tabFont(scale: scale, selected: selected)
    ]).width
    // Fixed tabs include the 17px icon, 5px gap and asymmetric 10/23px padding.
    // Dynamic tabs render the same single label as the WebView.
    let extra: CGFloat = (isFixed ? 55 : 20) * scale
    // .tab-item.record has a 74px minimum width in the WebView.
    let minimum: CGFloat = isFixed ? 78 : record ? 74 : 58
    return min(128 * scale, max(minimum * scale, text + extra))
  }
}

// History query label per tab: All, Favorites, then the user's dynamic tabs.
enum PanelFilterQuery {
  static let fixed = 2
  static func count(tabs: [PanelTab]) -> Int { fixed + tabs.count }
  static func index(id: String, tabs: [PanelTab]) -> Int? {
    tabs.firstIndex { $0.id == id }.map { fixed + $0 }
  }
  static func label(index: Int, tabs: [PanelTab]) -> String? {
    guard index >= 0, index < count(tabs: tabs) else { return nil }
    return index == 0 ? "" : index == 1 ? "__favorite" : tabs[index - fixed].label
  }
}

@available(macOS 12.0, *)
@MainActor
final class PanelToolbarState: ObservableObject {
  @Published var selected = 0
  @Published private(set) var draggingTabID = ""
  var cancelTabDrag: (() -> Void)?
  var releaseTabDrag: (() -> Void)?
  @Published var infoVisible = false
  @Published var queueActive = false
  @Published private(set) var navigationLocked = false
  @Published private(set) var searchOpen = false
  let scale: CGFloat
  let chinese: Bool
  let search: NSSearchField
  let developer: PanelDeveloperTools
  @Published private(set) var choices: [PanelFilterChoice]
  private let fixedChoices: [PanelFilterChoice]
  private(set) var closed = false
  var onFilter: ((Int) -> Void)?
  var onAddTab: (() -> Void)?
  var onTabContextMenu: ((String, NSPoint) -> Void)?
  var onTabReorder: ((String, String, Bool) -> Void)?
  var onTabDragging: ((Bool) -> Void)?
  var onRefresh: (() -> Void)?
  var onClose: (() -> Void)?
  var onPasteQueue: (() -> Void)?
  var onSettings: (() -> Void)?
  var onDiagnostics: (() -> Void)?
  var onDeveloper: ((String) -> Void)?

  init(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    self.scale = scale
    self.chinese = chinese
    self.search = search
    developer = PanelDeveloperTools(scale: scale, chinese: chinese)
    fixedChoices = [
      ("All", "全部", "", "square.grid.3x3.fill"), ("Favorites", "收藏", "", "star"),
    ].map { PanelFilterChoice(title: chinese ? $0.1 : $0.0, emoji: $0.2, symbol: $0.3) }
    choices = fixedChoices
    developer.onAction = { [weak self] action in
      guard let self, !self.closed else { return }
      switch action {
      case "refresh": self.onRefresh?()
      case "diagnostics": self.onDiagnostics?()
      default: self.onDeveloper?(action)
      }
    }
    search.isHidden = true
    search.font = PanelToolbarTypography.font(size: 13 * scale, cssWeight: 450)
    search.controlSize = .small
    search.focusRingType = .exterior
  }
  func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }
  var interactive: Bool { !closed && !navigationLocked && draggingTabID.isEmpty }
  func dragging(_ id: String?) {
    guard !closed else { return }
    let next = id ?? ""
    guard draggingTabID != next else { return }
    draggingTabID = next
    onTabDragging?(id != nil)
  }
  func cancelInteraction() { cancelTabDrag?(); dragging(nil) }
  func setNavigationLocked(_ locked: Bool) {
    guard navigationLocked != locked else { return }
    navigationLocked = locked
    search.isEnabled = !locked
    if locked { cancelInteraction() }
  }
  func select(_ index: Int) {
    guard !closed, choices.indices.contains(index) else { return }
    if selected != index { selected = index }
  }
  func addTab() { if interactive { onAddTab?() } }
  func setTabs(_ tabs: [PanelTab]) {
    cancelInteraction()
    let id = choices.indices.contains(selected) ? choices[selected].id : ""
    choices = fixedChoices + tabs.map {
      PanelFilterChoice(title: $0.name, emoji: "", symbol: "", record: $0.record, id: $0.id)
    }
    if !id.isEmpty { selected = choices.firstIndex { $0.id == id } ?? 0 }
    else if !choices.indices.contains(selected) { selected = 0 }
  }
  func contextMenu(id: String, at point: NSPoint) {
    guard interactive, !id.isEmpty, choices.contains(where: { $0.id == id }) else { return }
    onTabContextMenu?(id, point)
  }
  func choose(_ index: Int) {
    guard interactive, choices.indices.contains(index) else { return }
    select(index)
    onFilter?(index)
  }
  func beginSearch() {
    guard !closed, !navigationLocked else { return }
    searchOpen = true
    search.isHidden = false
  }
  func endEmptySearch() {
    guard search.stringValue.isEmpty else { return }
    searchOpen = false
    search.isHidden = true
  }
  func close() {
    guard !closed else { return }
    closed = true
    releaseTabDrag?()
    releaseTabDrag = nil
    cancelTabDrag = nil
    developer.releaseContent()
    draggingTabID = ""
    onFilter = nil
    onAddTab = nil
    onTabContextMenu = nil
    onTabReorder = nil
    onTabDragging = nil
    onRefresh = nil
    onClose = nil
    onPasteQueue = nil
    onSettings = nil
    onDiagnostics = nil
    onDeveloper = nil
    searchOpen = false
  }
}

// Toolbar buttons use pointer actions and explicit window shortcuts. Keep both
// hosting and filter surfaces out of AppKit's key-view loop; the embedded NSSearchField
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
    super.init(rootView: PanelToolbarView(state: state, tools: state.developer))
    rootView.onSearch = { [weak self] in self?.toggleSearch() }
  }
  required init(rootView: PanelToolbarView) { fatalError("Use the configured initializer") }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  var onFilter: ((Int) -> Void)? { get { state.onFilter } set { state.onFilter = newValue } }
  var onAddTab: (() -> Void)? { get { state.onAddTab } set { state.onAddTab = newValue } }
  var onTabContextMenu: ((String, NSPoint) -> Void)? {
    get { state.onTabContextMenu } set { state.onTabContextMenu = newValue }
  }
  var onTabReorder: ((String, String, Bool) -> Void)? {
    get { state.onTabReorder } set { state.onTabReorder = newValue }
  }
  var onTabDragging: ((Bool) -> Void)? { get { state.onTabDragging } set { state.onTabDragging = newValue } }
  var onRefresh: (() -> Void)? { get { state.onRefresh } set { state.onRefresh = newValue } }
  var onClose: (() -> Void)? { get { state.onClose } set { state.onClose = newValue } }
  var onPasteQueue: (() -> Void)? { get { state.onPasteQueue } set { state.onPasteQueue = newValue } }
  var onSettings: (() -> Void)? { get { state.onSettings } set { state.onSettings = newValue } }
  var onDiagnostics: (() -> Void)? { get { state.onDiagnostics } set { state.onDiagnostics = newValue } }
  var onDeveloper: ((String) -> Void)? { get { state.onDeveloper } set { state.onDeveloper = newValue } }
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
    state.select(index)
  }
  func setInfoVisible(_ visible: Bool) { state.infoVisible = visible }
  func setQueueActive(_ active: Bool) { state.queueActive = active }
  func setNavigationLocked(_ locked: Bool) { state.setNavigationLocked(locked) }
  func cancelInteraction() { state.cancelInteraction() }
  func setTabs(_ tabs: [PanelTab]) { state.setTabs(tabs) }
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
  @ObservedObject var tools: PanelDeveloperTools
  @State private var filterContentWidth: CGFloat?
  @Environment(\.colorScheme) private var scheme
  var onSearch: (() -> Void)?
  private var dark: Bool { scheme == .dark }
  var body: some View { toolbar }
  private var toolbar: some View {
    GeometryReader { geometry in
      let s = state.scale
      let button = 28 * s
      let pad = 28 * s
      let gap = 8 * s
      let developerWidth = tools.width(toolbarWidth: geometry.size.width, searching: state.searchOpen)
      let closeX = geometry.size.width - pad - button / 2
      let settingsX = closeX - button - gap
      let queueX = settingsX - button - gap
      let developerX = queueX - button / 2 - gap - developerWidth / 2
      let fieldWidth = min(276 * s, max(100 * s,
        geometry.size.width - 2 * pad - developerWidth - 4 * button - 5 * gap - 68 * s))
      let left = pad + button + 15 * s + (state.searchOpen ? fieldWidth + 12 * s : 0)
      let tabsWidth = max(50 * s, developerX - developerWidth / 2 - left - 10 * s)
      let liquidGlass = PanelToolbarMaterial.liquidGlass
      let viewportWidth = min(filterContentWidth ?? .greatestFiniteMagnitude, max(6 * s, tabsWidth - 44 * s))
      ZStack(alignment: .topLeading) {
        if !liquidGlass {
          LinearGradient(
            colors: [Color(PanelStyle.rgb(dark ? 0x252b33 : 0xffffff, dark ? 0.92 : 0.90)),
              Color(PanelStyle.rgb(dark ? 0x161b22 : 0xf2f5f2, dark ? 0.86 : 0.82))],
            startPoint: .top, endPoint: .bottom)
          VStack(spacing: 0) {
            (dark ? Color.white.opacity(0.08) : Color.white.opacity(0.58)).frame(height: s)
            Spacer(minLength: 0)
            Color(PanelStyle.rgb(dark ? 0xffffff : 0x747e7a, dark ? 0.08 : 0.14)).frame(height: s)
          }
        }
        icon("magnifyingglass", state.local("Search", "搜索"), active: state.searchOpen) { onSearch?() }
          .disabled(state.navigationLocked)
          .position(x: pad + button / 2, y: geometry.size.height / 2)
        PanelNativeSearch(search: state.search, open: state.searchOpen)
          .frame(width: fieldWidth, height: 32 * s)
          .opacity(state.searchOpen ? 1 : 0)
          .allowsHitTesting(state.searchOpen && !state.navigationLocked)
          .accessibilityHidden(!state.searchOpen)
          .position(x: pad + button + 7 * s + fieldWidth / 2, y: geometry.size.height / 2)
        PanelFilterViewport(state: state, width: viewportWidth, height: geometry.size.height,
          contentWidth: $filterContentWidth)
          .disabled(state.navigationLocked)
          .allowsHitTesting(!state.navigationLocked)
          .frame(width: viewportWidth, height: geometry.size.height)
          .position(x: left + viewportWidth / 2, y: geometry.size.height / 2)
        icon("plus", state.local("Add tab", "添加标签"), systemGlass: true) { state.addTab() }
          .disabled(!state.interactive)
          .position(x: left + viewportWidth + 22 * s, y: geometry.size.height / 2)
        PanelDeveloperToolsView(tools: tools, infoVisible: state.infoVisible)
          .frame(width: developerWidth, height: 32 * s)
          .position(x: developerX, y: geometry.size.height / 2)
        icon("list.bullet", state.queueActive
          ? state.local("Close paste queue", "关闭粘贴队列")
          : state.local("Open paste queue", "开启粘贴队列"), active: state.queueActive) { state.onPasteQueue?() }
          .position(x: queueX, y: geometry.size.height / 2)
        icon("gearshape", state.local("Settings", "设置")) { state.onSettings?() }
          .position(x: settingsX, y: geometry.size.height / 2)
        icon("xmark", state.local("Close native panel", "关闭原生主界面")) { state.onClose?() }
          .position(x: closeX, y: geometry.size.height / 2)
      }
    }
  }
  private func icon(_ symbol: String, _ label: String, active: Bool = false,
    systemGlass: Bool = false,
    action: @escaping () -> Void) -> some View {
    PanelSwiftUIIcon(symbol: symbol, label: label, scale: state.scale,
      dark: dark, active: active, systemGlass: systemGlass, action: action)
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
  let systemGlass: Bool
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
  private var button: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: symbolSize * scale))
        .frame(width: 28 * scale, height: 28 * scale)
    }
  }
  var body: some View {
    Group {
      #if VPASTE_LIQUID_GLASS_SDK
        if systemGlass, #available(macOS 26.0, *) {
          button
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .background(PanelButtonCursor().accessibilityHidden(true))
        } else {
          button.buttonStyle(PanelIconStyle(scale: scale, dark: dark, active: active))
        }
      #else
        button.buttonStyle(PanelIconStyle(scale: scale, dark: dark, active: active))
      #endif
    }
    .focusable(false)
    .help(label)
    .accessibilityLabel(Text(label))
  }
}

@available(macOS 12.0, *)
private struct PanelIconStyle: ButtonStyle {
  let scale: CGFloat
  let dark: Bool
  let active: Bool
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    let accent = Color(PanelStyle.rgb(dark ? 0x8ab7ff : 0x2466d8))
    let color = Color(PanelStyle.rgb(dark ? 0xdde2eb : 0x2a3230, dark ? 0.68 : 0.62))
    let fill = active ? accent.opacity(0.16)
      : Color(PanelStyle.rgb(dark ? (hovering ? 0x2d333c : 0x21262d) : 0xffffff,
        dark ? (hovering ? 0.82 : 0.64) : (hovering ? 0.92 : 0.72)))
    return configuration.label.foregroundColor(active ? accent : color)
      .background(Circle().fill(PanelToolbarMaterial.liquidGlass
        ? (active ? accent.opacity(0.16) : Color.clear) : fill).padding(scale))
      .modifier(PanelToolbarGlass(interactive: isEnabled, enabled: PanelToolbarMaterial.liquidGlass))
      .overlay(Circle().stroke(Color(PanelStyle.rgb(dark ? 0xdde2eb : 0x2a3230, 0.08)),
        lineWidth: scale).padding(scale).opacity(PanelToolbarMaterial.liquidGlass ? 0 : 1))
      .shadow(color: .black.opacity(PanelToolbarMaterial.liquidGlass ? 0 : dark ? 0.24 : 0.09),
        radius: 3 * scale, x: 0, y: scale)
      .opacity(configuration.isPressed ? 0.72 : 1)
      .background(PanelButtonCursor().accessibilityHidden(true))
      .onHover { hovering = isEnabled && $0 }
  }
}

@available(macOS 12.0, *)
private struct PanelNativeSearch: NSViewRepresentable {
  let search: NSSearchField
  let open: Bool
  func makeNSView(context: Context) -> NSSearchField { search }
  func updateNSView(_ view: NSSearchField, context: Context) { view.isHidden = !open }
}

// Each tab is a complete native button. The row only synchronizes selection
// and adapts existing context-menu, drag and scroll callbacks.
@available(macOS 12.0, *)
@MainActor
final class PanelFilterButton: PanelPointerButton {
  var onContextMenu: ((NSPoint) -> Void)?
  override var acceptsFirstResponder: Bool { false }
  override var canBecomeKeyView: Bool { false }
  override var visibleRect: NSRect {
    let visible = bounds.intersection(super.visibleRect)
    guard let scroll = enclosingScrollView, let document = scroll.documentView else { return visible }
    return visible.intersection(convert(scroll.documentVisibleRect, from: document))
  }
  override func rightMouseDown(with event: NSEvent) { onContextMenu?(NSEvent.mouseLocation) }
  override func mouseDown(with event: NSEvent) {
    if event.modifierFlags.contains(.control) { rightMouseDown(with: event) }
    else { super.mouseDown(with: event) }
  }
  func releaseContent() {
    isEnabled = false
    target = nil
    action = nil
    onContextMenu = nil
  }
}

@available(macOS 12.0, *)
@MainActor
final class PanelFilterControl: NSView {
  private weak var state: PanelToolbarState?
  private var choices: [PanelFilterChoice] = []
  private(set) var buttons: [PanelFilterButton] = []
  private var revealRequest = 0
  override var acceptsFirstResponder: Bool { false }
  override var canBecomeKeyView: Bool { false }
  override var isFlipped: Bool { true }

  init(state: PanelToolbarState) {
    self.state = state
    super.init(frame: .zero)
    setAccessibilityElement(true)
    setAccessibilityRole(.radioGroup)
    setAccessibilityLabel(state.local("History filters", "历史记录筛选"))
    update()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update() {
    guard let state, !state.closed else { return }
    if choices != state.choices {
      buttons.forEach { $0.releaseContent(); $0.removeFromSuperview() }
      choices = state.choices
      buttons = choices.enumerated().map { index, choice in
        let button = PanelFilterButton(frame: .zero)
        button.title = choice.label
        button.toolTip = choice.title
        button.controlSize = .large
        button.bezelStyle = .rounded
        #if VPASTE_LIQUID_GLASS_SDK
          if #available(macOS 26.0, *) {
            button.bezelStyle = .glass
            button.borderShape = .capsule
          }
        #endif
        button.setButtonType(.pushOnPushOff)
        button.refusesFirstResponder = true
        button.focusRingType = .none
        button.tag = index
        button.target = self
        button.action = #selector(chooseFilter(_:))
        button.cell?.setAccessibilityRole(.radioButton)
        button.cell?.setAccessibilityLabel(choice.title)
        if !choice.isFixed {
          button.onContextMenu = { [weak state] point in state?.contextMenu(id: choice.id, at: point) }
        }
        button.sizeToFit()
        addSubview(button)
        return button
      }
      var x: CGFloat = 4
      for button in buttons {
        button.setFrameOrigin(NSPoint(x: x, y: (PanelStyle.headerHeight - button.frame.height) / 2))
        x = button.frame.maxX + 8
      }
      let size = NSSize(width: max(0, x - 8 + 4), height: PanelStyle.headerHeight)
      setFrameSize(NSSize(width: size.width * state.scale, height: size.height * state.scale))
      setBoundsSize(size)
      setAccessibilityChildren(NSAccessibility.unignoredChildren(from: buttons))
    }
    for (index, button) in buttons.enumerated() {
      let selected = index == state.selected
      #if VPASTE_LIQUID_GLASS_SDK
        if #available(macOS 26.0, *) {
          button.tintProminence = selected ? .none : .automatic
          button.bezelColor = selected ? NSColor(white: 0.5, alpha: 0.40) : nil
        }
      #endif
      button.state = selected ? .on : .off
      button.isEnabled = !state.navigationLocked
    }
  }

  var buttonFrames: [NSRect] { buttons.map(\.frame) }
  var dragFrames: [PanelTabDragFrame] {
    buttons.indices.compactMap { index in
      guard !choices[index].isFixed, let superview else { return nil }
      return PanelTabDragFrame(id: choices[index].id, frame: convert(buttons[index].frame, to: superview))
    }
  }
  func revealSelection() {
    guard let state, !state.closed, buttons.indices.contains(state.selected) else { return }
    let button = buttons[state.selected]
    button.scrollToVisible(button.bounds.insetBy(dx: -2, dy: 0))
  }
  func requestReveal() {
    revealRequest &+= 1
    let request = revealRequest
    DispatchQueue.main.async { [weak self] in
      guard let self, self.revealRequest == request, self.state?.closed == false else { return }
      self.revealSelection()
    }
  }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil { requestReveal() }
  }
  @objc private func chooseFilter(_ sender: PanelFilterButton) {
    guard let state, !state.closed, buttons.indices.contains(sender.tag), buttons[sender.tag] === sender else { return }
    state.choose(sender.tag)
    // A selected toggle can turn itself off; the query state remains single-select.
    update()
  }
  func releaseContent() {
    revealRequest &+= 1
    buttons.forEach { $0.releaseContent(); $0.removeFromSuperview() }
    buttons.removeAll()
    setAccessibilityChildren([])
    state = nil
  }
}

// Retain the existing wheel mapping and private tab-drag session around the
// native control. This surface does not add another background or indicator.
@available(macOS 12.0, *)
@MainActor
private struct PanelFilterViewport: NSViewRepresentable {
  @ObservedObject var state: PanelToolbarState
  let width: CGFloat
  let height: CGFloat
  @Binding var contentWidth: CGFloat?
  final class Coordinator {
    var control: PanelFilterControl?
    var surface: PanelTabDragSurface?
    var selection: Int?
    var choices: [PanelFilterChoice] = []
    var width: CGFloat = 0
    var contentWidth: CGFloat = 0
  }
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeNSView(context: Context) -> PanelScroll {
    let scroll = PanelScroll()
    scroll.drawsBackground = false
    if PanelToolbarMaterial.liquidGlass {
      // The clip view cuts native glass shadows into a rectangle. Fade only the horizontal edges.
      scroll.contentView.clipsToBounds = false
      scroll.wantsLayer = true
      let mask = CAGradientLayer()
      mask.colors = [NSColor.clear, .white, .white, .clear].map(\.cgColor)
      mask.startPoint = CGPoint(x: 0, y: 0.5)
      mask.endPoint = CGPoint(x: 1, y: 0.5)
      scroll.layer?.mask = mask
    }
    let control = PanelFilterControl(state: state)
    let surface = PanelTabDragSurface()
    surface.scale = state.scale
    surface.addSubview(control)
    surface.tabFrames = { [weak control] in control?.dragFrames ?? [] }
    surface.onMove = { [weak state] source, target, before in
      guard let state, state.interactive else { return }
      state.onTabReorder?(source, target, before)
    }
    surface.onDragChanged = { [weak state] id in state?.dragging(id) }
    state.cancelTabDrag = { [weak surface] in surface?.cancelInteraction() }
    state.releaseTabDrag = { [weak surface, weak control] in
      surface?.releaseContent()
      control?.releaseContent()
    }
    context.coordinator.control = control
    context.coordinator.surface = surface
    scroll.documentView = surface
    return scroll
  }
  func updateNSView(_ scroll: PanelScroll, context: Context) {
    guard let control = context.coordinator.control, let surface = context.coordinator.surface else { return }
    // SwiftUI applies its frame later. Reveal must use the new search viewport.
    scroll.setFrameSize(NSSize(width: width, height: height))
    if let mask = scroll.layer?.mask as? CAGradientLayer {
      let frame = scroll.bounds.insetBy(dx: 0, dy: -height)
      if mask.frame != frame {
        let edge = min(10 * state.scale / width, 0.5)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        mask.frame = frame
        mask.locations = [0, NSNumber(value: Double(edge)), NSNumber(value: Double(1 - edge)), 1]
        CATransaction.commit()
      }
    }
    surface.interactionEnabled = !state.navigationLocked && !state.closed
    control.update()
    let naturalWidth = control.frame.width + 4 * state.scale
    if context.coordinator.contentWidth != naturalWidth {
      context.coordinator.contentWidth = naturalWidth
      let coordinator = context.coordinator
      let measuredWidth = $contentWidth
      // Report native fitting size after SwiftUI's update, discarding obsolete or detached measurements.
      DispatchQueue.main.async { [weak coordinator, weak state] in
        guard let coordinator, coordinator.control != nil, coordinator.contentWidth == naturalWidth,
          let state, !state.closed else { return }
        measuredWidth.wrappedValue = naturalWidth
      }
    }
    surface.setFrameSize(NSSize(width: max(width, naturalWidth), height: height))
    control.setFrameOrigin(NSPoint(x: 2 * state.scale, y: (height - control.frame.height) / 2))
    if context.coordinator.selection != state.selected || context.coordinator.choices != state.choices
      || context.coordinator.width != width {
      context.coordinator.selection = state.selected
      context.coordinator.choices = state.choices
      context.coordinator.width = width
      control.requestReveal()
    }
  }
  static func dismantleNSView(_ scroll: PanelScroll, coordinator: Coordinator) {
    coordinator.surface?.releaseContent()
    coordinator.control?.releaseContent()
    scroll.documentView = nil
    coordinator.surface = nil
    coordinator.control = nil
  }
}

// The system owns the material, its edge lighting and interactive deformation.
// Gate SDK symbols independently of runtime availability for older SDKs.
@available(macOS 12.0, *)
private struct PanelToolbarGlass: ViewModifier {
  let interactive: Bool
  let enabled: Bool
  @Environment(\.accessibilityReduceMotion) private var reducedMotion
  @Environment(\.accessibilityReduceTransparency) private var reducedTransparency
  @Environment(\.colorSchemeContrast) private var contrast
  func body(content: Content) -> some View {
    Group {
      #if VPASTE_LIQUID_GLASS_SDK
        if #available(macOS 26.0, *), enabled, !reducedTransparency {
          content.glassEffect(.regular.interactive(interactive && !reducedMotion), in: Capsule())
        } else { fallback(content) }
      #else
        fallback(content)
      #endif
    }
    .overlay(Capsule().strokeBorder(Color.primary.opacity(enabled && contrast == .increased ? 0.7 : 0), lineWidth: 1)
      .allowsHitTesting(false).accessibilityHidden(true))
  }
  private func fallback(_ content: Content) -> some View {
    content.background { if enabled { Capsule().fill(Color(NSColor.controlBackgroundColor)) } }
  }
}
