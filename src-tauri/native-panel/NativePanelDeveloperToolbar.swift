import AppKit
import Combine
import SwiftUI

@MainActor
final class PanelDeveloperTools: ObservableObject {
  static let fullWidth: CGFloat = 405
  static let menuWidth: CGFloat = 104
  private static var rememberedExpanded = true
  @Published var expanded = rememberedExpanded {
    didSet { Self.rememberedExpanded = expanded }
  }
  let scale: CGFloat
  let chinese: Bool
  var onAction: ((String) -> Void)?
  var onExpansionChanged: (() -> Void)?
  struct Action {
    let id: String
    let symbol: String
    let title: String
    var text = ""
  }
  let actions: [Action]
  init(scale: CGFloat, chinese: Bool) {
    self.scale = scale
    self.chinese = chinese
    func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }
    actions = [
      Action(id: "tutorial-mac", symbol: "applelogo", title: local("Mac tutorial", "Mac 引导"), text: "Mac"),
      Action(id: "language", symbol: "", title: local("Preview Chinese", "预览英文"), text: chinese ? "中" : "EN"),
      Action(id: "theme", symbol: "sun.max", title: local("Toggle theme preview", "切换主题预览")),
      Action(id: "test-room", symbol: "testtube.2", title: local("Test room", "测试间")),
      Action(id: "memory", symbol: "memorychip", title: local("Memory monitor", "内存监控")),
      Action(id: "native-panel", symbol: "macwindow", title: local("Native main panel (current)", "原生主界面（当前）")),
      Action(id: "native-window", symbol: "rectangle.on.rectangle", title: local("Native demo window", "原生演示窗口")),
      Action(id: "ui-lab", symbol: "square.grid.2x2", title: local("UI Lab (requires Vite)", "UI 样板间（需要 Vite）")),
      Action(id: "refresh", symbol: "arrow.clockwise", title: local("Refresh", "刷新")),
      Action(id: "diagnostics", symbol: "info.circle", title: local("Memory and history details", "内存与历史记录统计")),
    ]
  }
  func width(toolbarWidth: CGFloat, searching: Bool) -> CGFloat {
    guard expanded else { return 28 * scale }
    return (toolbarWidth / scale >= (searching ? 1120 : 920) ? Self.fullWidth : Self.menuWidth) * scale
  }
  func perform(_ id: String) {
    guard actions.contains(where: { $0.id == id }) else { return }
    onAction?(id)
  }
  func toggle() { expanded.toggle(); onExpansionChanged?() }
  func releaseContent() { onAction = nil; onExpansionChanged = nil }
}

// Shared pointer-only controls keep the macOS 11 fallback and SwiftUI host in sync.
@MainActor
final class PanelDeveloperToolbar: NSView {
  private let tools: PanelDeveloperTools
  private let group = PanelDeveloperGroup()
  private let badge = NSTextField(labelWithString: "DEV")
  private let eye = PanelIconButton(symbol: "eye", label: "DEV tools")
  private let more = PanelIconButton(symbol: "ellipsis", label: "DEV tools")
  private var buttons: [PanelIconButton] = []
  var infoVisible = false { didSet { updateAppearance() } }
  init(tools: PanelDeveloperTools) {
    self.tools = tools
    super.init(frame: .zero)
    addSubview(group)
    badge.font = PanelToolbarTypography.font(size: 9 * tools.scale, cssWeight: 800)
    group.addSubview(badge)
    for (index, action) in tools.actions.enumerated() {
      let button = PanelIconButton(symbol: action.symbol, label: action.title)
      if !action.text.isEmpty {
        button.title = action.text
        button.imagePosition = action.symbol.isEmpty ? .noImage : .imageLeading
        button.font = PanelToolbarTypography.font(size: 10 * tools.scale, cssWeight: 650)
      }
      button.scale = tools.scale
      button.tag = index
      button.target = self
      button.action = #selector(performAction(_:))
      group.addSubview(button)
      buttons.append(button)
    }
    for button in [eye, more] {
      button.scale = tools.scale
      button.target = self
      addSubview(button)
    }
    eye.action = #selector(toggle)
    eye.toolTip = tools.chinese ? "显示／隐藏 DEV 工具栏" : "Show/hide DEV toolbar"
    eye.setAccessibilityLabel(eye.toolTip)
    more.action = #selector(openMenu)
    more.toolTip = tools.chinese ? "更多 DEV 工具" : "More DEV tools"
    more.setAccessibilityLabel(more.toolTip)
    updateAppearance()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override var acceptsFirstResponder: Bool { false }
  override var isFlipped: Bool { true }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    updateAppearance()
  }
  private func updateAppearance() {
    badge.textColor = PanelStyle.accent(self)
    for (index, button) in buttons.enumerated() {
      let id = tools.actions[index].id
      button.active = id == "native-panel" || (id == "diagnostics" && infoVisible)
      if id == "theme" {
        button.image = NSImage(systemSymbolName: PanelStyle.dark(self) ? "moon" : "sun.max", accessibilityDescription: nil)
      }
    }
    group.needsDisplay = true
  }
  override func layout() {
    super.layout()
    let s = tools.scale
    let full = tools.expanded && bounds.width >= PanelDeveloperTools.fullWidth * s - 1
    group.isHidden = !tools.expanded
    more.isHidden = !tools.expanded || full
    eye.frame = NSRect(x: bounds.width - 28 * s, y: 2 * s, width: 28 * s, height: 28 * s)
    group.frame = NSRect(x: 0, y: 0, width: max(0, eye.frame.minX - 8 * s), height: 32 * s)
    badge.frame = NSRect(x: 9 * s, y: 9 * s, width: 28 * s, height: 15 * s)
    more.frame = NSRect(x: 34 * s, y: 2 * s, width: 28 * s, height: 28 * s)
    var x: CGFloat = 39 * s
    for (index, button) in buttons.enumerated() {
      button.isHidden = !full
      let width: CGFloat = tools.actions[index].id == "tutorial-mac" ? 42 : 28
      button.frame = NSRect(x: x, y: 2 * s, width: width * s, height: 28 * s)
      x += (width + 3) * s
    }
  }
  @objc private func performAction(_ sender: NSObject) {
    guard let index = (sender as? NSButton)?.tag ?? (sender as? NSMenuItem)?.tag,
      tools.actions.indices.contains(index) else { return }
    tools.perform(tools.actions[index].id)
  }
  @objc private func toggle() { tools.toggle(); needsLayout = true }
  @objc private func openMenu() {
    let menu = NSMenu()
    for (index, action) in tools.actions.enumerated() {
      let item = NSMenuItem(title: action.title, action: #selector(performAction(_:)), keyEquivalent: "")
      item.tag = index
      item.target = self
      item.image = NSImage(systemSymbolName: action.symbol, accessibilityDescription: nil)
      if action.id == "native-panel" || (action.id == "diagnostics" && infoVisible) { item.state = .on }
      menu.addItem(item)
    }
    menu.popUp(positioning: nil, at: NSPoint(x: more.frame.minX, y: more.frame.maxY + 4), in: self)
  }
}

@available(macOS 12.0, *)
struct PanelDeveloperToolsView: NSViewRepresentable {
  @ObservedObject var tools: PanelDeveloperTools
  let infoVisible: Bool
  func makeNSView(context: Context) -> PanelDeveloperToolbar { PanelDeveloperToolbar(tools: tools) }
  func updateNSView(_ view: PanelDeveloperToolbar, context: Context) {
    view.infoVisible = infoVisible
    view.needsLayout = true
  }
}
