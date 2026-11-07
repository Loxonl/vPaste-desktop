import AppKit
import SwiftUI

@MainActor
protocol PanelToolbarContent: AnyObject {
  var onFilter: ((Int) -> Void)? { get set }
  var onRefresh: (() -> Void)? { get set }
  var onClose: (() -> Void)? { get set }
  var onSettings: (() -> Void)? { get set }
  var onDiagnostics: (() -> Void)? { get set }
  func beginSearch()
  func endEmptySearch()
  func setSelection(_ index: Int)
  func setInfoVisible(_ visible: Bool)
  func releaseContent()
}

// Stable AppKit boundary: the controller keeps owning search/IME and window
// behavior, while actual buttons, labels and filter content are SwiftUI views.
@MainActor
final class PanelToolbar: NSView {
  var onFilter: ((Int) -> Void)?
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
  func setInfoVisible(_ visible: Bool) { content?.setInfoVisible(visible) }
  func releaseContent() {
    content?.releaseContent()
    content?.removeFromSuperview()
    content = nil
    onFilter = nil
    onRefresh = nil
    onClose = nil
    onSettings = nil
    onDiagnostics = nil
  }
}

extension PanelLegacyToolbar: PanelToolbarContent {
  func releaseContent() {
    onFilter = nil
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
  func width(scale: CGFloat) -> CGFloat {
    let width = (title as NSString).size(withAttributes: [
      .font: NSFont.systemFont(ofSize: 14.5 * scale, weight: .semibold)
    ]).width
    return min(128 * scale, max(58 * scale, width + 42 * scale))
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
  let choices: [PanelFilterChoice]
  private(set) var closed = false
  var onFilter: ((Int) -> Void)?
  var onRefresh: (() -> Void)?
  var onClose: (() -> Void)?
  var onSettings: (() -> Void)?
  var onDiagnostics: (() -> Void)?

  init(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    self.scale = scale
    self.chinese = chinese
    self.search = search
    choices = [
      ("All", "全部", "", "square.grid.3x3.fill"), ("Favorites", "收藏", "", "star"),
      ("Text", "文本", "📝", ""), ("Image", "图片", "🖼️", ""), ("Link", "链接", "🔗", ""),
      ("Color", "颜色", "🎨", ""), ("File", "文件", "📁", ""),
    ].map { PanelFilterChoice(title: chinese ? $0.1 : $0.0, emoji: $0.2, symbol: $0.3) }
    search.isHidden = true
    search.font = .systemFont(ofSize: 13 * scale)
    search.controlSize = .small
    search.focusRingType = .exterior
  }
  func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }
  func choose(_ index: Int) {
    guard !closed, choices.indices.contains(index) else { return }
    if selected != index { selected = index }
    onFilter?(index)
  }
  func neighbor(of index: Int, step: Int) -> Int {
    (index + step + choices.count) % choices.count
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
    onRefresh = nil
    onClose = nil
    onSettings = nil
    onDiagnostics = nil
    searchOpen = false
  }
}

@available(macOS 12.0, *)
@MainActor
final class PanelSwiftUIToolbarHost: NSHostingView<PanelToolbarView>, PanelToolbarContent {
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
      let left = pad + button + 10 * s + (state.searchOpen ? fieldWidth + 12 * s : 0)
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
          Text("DEV · SwiftUI").font(.system(size: 9 * s, weight: .heavy))
            .foregroundColor(accent).frame(width: 65 * s, alignment: .leading)
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
private struct PanelSwiftUIIcon: View {
  let symbol: String
  let label: String
  let scale: CGFloat
  let dark: Bool
  let active: Bool
  let action: () -> Void
  @FocusState private var focused: Bool
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 16 * scale))
        .frame(width: 28 * scale, height: 28 * scale)
    }
    .buttonStyle(PanelIconStyle(scale: scale, dark: dark, active: active))
    .focused($focused)
    .overlay(Circle().stroke(focused ? Color(NSColor.keyboardFocusIndicatorColor) : .clear, lineWidth: 2 * scale))
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
    var host: NSHostingView<PanelFilterStrip>?
    var selection: Int?
  }
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeNSView(context: Context) -> PanelScroll {
    let scroll = PanelScroll()
    scroll.drawsBackground = false
    scroll.setAccessibilityLabel(state.local("History filters", "历史记录筛选"))
    let host = NSHostingView(rootView: PanelFilterStrip(state: state))
    context.coordinator.host = host
    scroll.documentView = host
    return scroll
  }
  func updateNSView(_ scroll: PanelScroll, context: Context) {
    let widths = state.choices.map { $0.width(scale: state.scale) }
    let gap = 8 * state.scale
    let extent = widths.reduce(0, +) + gap * CGFloat(max(0, widths.count - 1))
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
  @FocusState private var focused: Int?
  var body: some View {
    HStack(spacing: 8 * state.scale) {
      ForEach(state.choices.indices, id: \.self) { index in
        let choice = state.choices[index]
        let selected = state.selected == index
        let accent = Color(PanelStyle.rgb(scheme == .dark ? 0x8ab7ff : 0x2466d8))
        Button { state.choose(index) } label: {
          HStack(spacing: 5 * state.scale) {
            if !choice.emoji.isEmpty {
              Text(choice.emoji).font(.system(size: 17 * state.scale)).frame(width: 18 * state.scale)
            } else if choice.symbol == "star" {
              Text("☆").font(.system(size: 22 * state.scale)).frame(width: 18 * state.scale)
            } else {
              Image(systemName: choice.symbol).font(.system(size: 17 * state.scale)).frame(width: 18 * state.scale)
            }
            Text(choice.title).font(.system(size: 14.5 * state.scale, weight: selected ? .bold : .semibold))
          }
          .frame(width: choice.width(scale: state.scale), height: PanelStyle.headerHeight * state.scale)
        }
        .buttonStyle(PanelFilterStyle(scale: state.scale, selected: selected, dark: scheme == .dark))
        .focused($focused, equals: index)
        .overlay(alignment: .bottom) {
          if selected {
            Capsule().fill(accent).frame(width: choice.width(scale: state.scale) - 20 * state.scale, height: 3 * state.scale)
          }
        }
        .overlay(RoundedRectangle(cornerRadius: 6 * state.scale)
          .stroke(focused == index ? Color(NSColor.keyboardFocusIndicatorColor) : .clear, lineWidth: 2 * state.scale)
          .padding(2 * state.scale))
        .accessibilityLabel(Text(choice.title))
        .accessibilityValue(Text(selected ? state.local("Selected", "已选择") : ""))
        .onMoveCommand { direction in
          let step: Int
          switch direction { case .left: step = -1; case .right: step = 1; default: return }
          let next = state.neighbor(of: index, step: step)
          state.choose(next)
          focused = next
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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
      .onHover { hovering = $0 }
  }
}
