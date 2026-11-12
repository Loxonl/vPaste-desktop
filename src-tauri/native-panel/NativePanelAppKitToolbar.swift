// macOS 11 fallback; newer systems use the SwiftUI toolbar.
import AppKit

@MainActor
class PanelPointerButton: NSButton {
  override var isEnabled: Bool {
    didSet { if oldValue != isEnabled { window?.invalidateCursorRects(for: self) } }
  }
  override func resetCursorRects() {
    super.resetCursorRects()
    if isEnabled { addCursorRect(visibleRect, cursor: .pointingHand) }
  }
}

@MainActor
final class PanelIconButton: PanelPointerButton {
  override var acceptsFirstResponder: Bool { false }
  var scale: CGFloat = 1
  var active = false {
    didSet {
      updateTint()
      needsDisplay = true
    }
  }
  private var hovering = false
  private var tracking: NSTrackingArea?
  init(symbol: String, label: String) {
    super.init(frame: .zero)
    title = ""
    image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    imagePosition = .imageOnly
    imageScaling = .scaleProportionallyDown
    isBordered = false
    bezelStyle = .regularSquare
    focusRingType = .none
    setButtonType(.momentaryChange)
    toolTip = label
    setAccessibilityLabel(label)
    updateTint()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  private func updateTint() {
    contentTintColor = active ? PanelStyle.accent(self) : PanelStyle.secondary(self)
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    updateTint()
    needsDisplay = true
  }
  override func updateTrackingAreas() {
    if let tracking { removeTrackingArea(tracking) }
    tracking = NSTrackingArea(
      rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
      owner: self)
    addTrackingArea(tracking!)
    super.updateTrackingAreas()
  }
  override func mouseEntered(with event: NSEvent) {
    hovering = true
    needsDisplay = true
  }
  override func mouseExited(with event: NSEvent) {
    hovering = false
    needsDisplay = true
  }
  override func draw(_ dirtyRect: NSRect) {
    let rect = bounds.insetBy(dx: 1 * scale, dy: 1 * scale)
    let shape = NSBezierPath(ovalIn: rect)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowBlurRadius = 3 * scale
    shadow.shadowOffset = NSSize(width: 0, height: -scale)
    shadow.shadowColor = NSColor.black.withAlphaComponent(PanelStyle.dark(self) ? 0.24 : 0.09)
    shadow.set()
    (active
      ? PanelStyle.accent(self).withAlphaComponent(0.16)
      : PanelStyle.control(self, hover: hovering)).setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    PanelStyle.secondary(self).withAlphaComponent(0.08).setStroke()
    shape.lineWidth = scale
    shape.stroke()
    super.draw(dirtyRect)
  }
}

@MainActor
final class PanelTabButton: PanelPointerButton {
  var onContextMenu: ((NSPoint) -> Void)?
  var tabID = ""
  override var acceptsFirstResponder: Bool { false }
  var scale: CGFloat = 1
  var emoji = ""
  var symbol = ""
  var selected = false {
    didSet {
      state = selected ? .on : .off
      needsDisplay = true
    }
  }
  private var hovering = false
  private var tracking: NSTrackingArea?
  override init(frame: NSRect) {
    super.init(frame: frame)
    isBordered = false
    focusRingType = .none
    setButtonType(.momentaryChange)
    setAccessibilityRole(.radioButton)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func rightMouseDown(with event: NSEvent) { onContextMenu?(NSEvent.mouseLocation) }
  override func mouseDown(with event: NSEvent) {
    if event.modifierFlags.contains(.control) { rightMouseDown(with: event) }
    else { super.mouseDown(with: event) }
  }
  var preferredWidth: CGFloat {
    PanelFilterChoice(title: title, emoji: emoji, symbol: symbol)
      .width(scale: scale, selected: selected)
  }
  override func updateTrackingAreas() {
    if let tracking { removeTrackingArea(tracking) }
    tracking = NSTrackingArea(
      rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
      owner: self)
    addTrackingArea(tracking!)
    super.updateTrackingAreas()
  }
  override func mouseEntered(with event: NSEvent) {
    hovering = true
    needsDisplay = true
  }
  override func mouseExited(with event: NSEvent) {
    hovering = false
    needsDisplay = true
  }
  override func draw(_ dirtyRect: NSRect) {
    if hovering {
      (PanelStyle.dark(self)
        ? NSColor.white.withAlphaComponent(0.07) : NSColor.white.withAlphaComponent(0.30)).setFill()
      bounds.fill()
    }
    let color = selected ? PanelStyle.accent(self) : PanelStyle.secondary(self)
    let font = PanelToolbarTypography.tabFont(scale: scale, selected: selected)
    let label = emoji.isEmpty ? title : "\(emoji) \(title)"
    let titleSize = (label as NSString).size(withAttributes: [.font: font])
    let total = titleSize.width + (emoji.isEmpty ? 22 * scale : 0)
    let padding = (emoji.isEmpty ? 33 : 20) * scale
    let left = 10 * scale + max(0, (bounds.width - padding - total) / 2)
    let iconRect = NSRect(
      x: left, y: (bounds.height - 17 * scale) / 2, width: 17 * scale, height: 17 * scale)
    if emoji.isEmpty && symbol == "grid" {
      color.setFill()
      for row in 0..<3 {
        for col in 0..<3 {
          NSRect(
            x: iconRect.minX + CGFloat(col) * 6 * scale,
            y: iconRect.minY + CGFloat(row) * 6 * scale, width: 4 * scale, height: 4 * scale
          ).fill()
        }
      }
    } else if emoji.isEmpty {
      ("☆" as NSString).draw(
        in: iconRect.insetBy(dx: -2 * scale, dy: -2 * scale),
        withAttributes: [.font: NSFont.systemFont(ofSize: 17 * scale), .foregroundColor: color])
    }
    (label as NSString).draw(
      at: NSPoint(x: left + (emoji.isEmpty ? 22 * scale : 0), y: (bounds.height - titleSize.height) / 2),
      withAttributes: [.font: font, .foregroundColor: color])
    if selected {
      color.setFill()
      NSBezierPath(
        roundedRect: NSRect(
          x: 10 * scale, y: isFlipped ? bounds.height - 3 * scale : 0,
          width: bounds.width - 20 * scale, height: 3 * scale),
        xRadius: 2 * scale, yRadius: 2 * scale
      ).fill()
    }
  }
}

@MainActor
final class PanelDeveloperGroup: NSView {
  override func draw(_ dirtyRect: NSRect) {
    let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
    (PanelStyle.dark(self)
      ? PanelStyle.rgb(0x21262d, 0.64) : NSColor.white.withAlphaComponent(0.44)).setFill()
    let path = NSBezierPath(
      roundedRect: rect, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    path.fill()
    PanelStyle.secondary(self).withAlphaComponent(0.13).setStroke()
    path.stroke()
  }
}

@MainActor
final class PanelLegacyToolbar: NSView {
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
  private let tabScroll = PanelScroll()
  private let tabStrip = PanelTabDragSurface()
  private let addButton = PanelPointerButton()
  private var tabs: [PanelTabButton] = []
  private let developer = PanelDeveloperGroup()
  private let badge = NSTextField(labelWithString: "DEV · Native")
  private var searchButton: PanelIconButton!
  private var refreshButton: PanelIconButton!
  private var infoButton: PanelIconButton!
  private var queueButton: PanelIconButton!
  private var settingsButton: PanelIconButton!
  private var closeButton: PanelIconButton!
  private weak var search: NSSearchField?
  private var scale: CGFloat = 1
  private var chinese = false
  private var searchOpen = false
  private var built = false
  override init(frame: NSRect) { super.init(frame: frame) }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    guard !built else { return }
    built = true
    self.scale = scale
    self.chinese = chinese
    self.search = search
    func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }
    func icon(_ symbol: String, _ label: String, _ action: Selector, in host: NSView? = nil)
      -> PanelIconButton
    {
      let button = PanelIconButton(symbol: symbol, label: label)
      button.scale = scale
      button.target = self
      button.action = action
      button.font = .systemFont(ofSize: 16 * scale)
      (host ?? self).addSubview(button)
      return button
    }
    searchButton = icon("magnifyingglass", local("Search", "搜索"), #selector(toggleSearch))
    addSubview(search)
    search.isHidden = true
    search.font = PanelToolbarTypography.font(size: 13 * scale, cssWeight: 450)
    search.controlSize = .small
    search.focusRingType = .exterior
    tabStrip.scale = scale
    tabStrip.tabFrames = { [weak self] in
      self?.tabs.filter { !$0.tabID.isEmpty }.map { PanelTabDragFrame(id: $0.tabID, frame: $0.frame) } ?? []
    }
    tabStrip.onMove = { [weak self] in self?.onTabReorder?($0, $1, $2) }
    tabStrip.onDragChanged = { [weak self] id in
      guard let self else { return }
      for tab in self.tabs { tab.alphaValue = !tab.tabID.isEmpty && tab.tabID == id ? 0.55 : 1 }
      self.onTabDragging?(id != nil)
    }
    tabScroll.documentView = tabStrip
    tabScroll.drawsBackground = false
    tabScroll.hasHorizontalScroller = false
    tabScroll.hasVerticalScroller = false
    tabScroll.horizontalScrollElasticity = .none
    tabScroll.verticalScrollElasticity = .none
    tabScroll.setAccessibilityLabel(local("History filters", "历史记录筛选"))
    addSubview(tabScroll)
    addTab(local("All", "全部"), symbol: "grid")
    addTab(local("Favorites", "收藏"), symbol: "star")
    addButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
    addButton.imagePosition = .imageOnly
    addButton.isBordered = false
    addButton.refusesFirstResponder = true
    addButton.focusRingType = .none
    addButton.target = self
    addButton.action = #selector(requestAddTab)
    addButton.contentTintColor = PanelStyle.secondary(self)
    addButton.setAccessibilityLabel(local("Add tab", "添加标签"))
    tabStrip.addSubview(addButton)
    addSubview(developer)
    badge.font = PanelToolbarTypography.font(size: 9 * scale, cssWeight: 800)
    badge.textColor = PanelStyle.accent(self)
    developer.addSubview(badge)
    refreshButton = icon(
      "arrow.clockwise", local("Refresh", "刷新"), #selector(refresh), in: developer)
    infoButton = icon(
      "info.circle", local("Memory and history details", "内存与历史记录统计"), #selector(info),
      in: developer)
    queueButton = icon("list.bullet", local("Open paste queue", "开启粘贴队列"), #selector(toggleQueue))
    settingsButton = icon("gearshape", local("Settings", "设置"), #selector(settings))
    closeButton = icon("xmark", local("Close native panel", "关闭原生主界面"), #selector(closePanel))
    setSelection(0)
  }
  private func addTab(_ title: String, symbol: String = "", id: String = "") {
    let button = PanelTabButton()
    button.title = title
    button.symbol = symbol
    button.tabID = id
    button.scale = scale
    button.tag = tabs.count
    button.target = self
    button.action = #selector(selectFilter(_:))
    button.setAccessibilityLabel(title)
    if !id.isEmpty {
      button.onContextMenu = { [weak self] point in self?.onTabContextMenu?(id, point) }
    }
    tabs.append(button)
    tabStrip.addSubview(button)
  }
  // Dynamic tabs follow the fixed All and Favorites tabs.
  func setTabs(_ dynamic: [PanelTab]) {
    guard built else { return }
    let selected = tabs.firstIndex { $0.selected }
    for button in tabs.dropFirst(PanelFilterQuery.fixed) { button.removeFromSuperview() }
    tabs.removeSubrange(min(PanelFilterQuery.fixed, tabs.count)...)
    for tab in dynamic { addTab(tab.name, id: tab.id) }
    setSelection(selected ?? 0)
  }
  var tabTitles: [String] { tabs.map(\.title) }
  func releaseContent() {
    tabStrip.releaseContent()
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
  }
  func chooseTab(_ index: Int) {
    guard tabs.indices.contains(index) else { return }
    selectFilter(tabs[index])
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    badge.textColor = PanelStyle.accent(self)
    addButton.contentTintColor = PanelStyle.secondary(self)
    needsDisplay = true
  }
  override func draw(_ dirtyRect: NSRect) {
    let dark = PanelStyle.dark(self)
    let top = dark ? PanelStyle.rgb(0x252b33, 0.92) : PanelStyle.rgb(0xffffff, 0.90)
    let bottom = dark ? PanelStyle.rgb(0x161b22, 0.86) : PanelStyle.rgb(0xf2f5f2, 0.82)
    NSGradient(starting: top, ending: bottom)?.draw(in: bounds, angle: -90)
    (dark ? NSColor.white.withAlphaComponent(0.08) : PanelStyle.rgb(0x747e7a, 0.14)).setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: scale).fill()
    (dark ? NSColor.white.withAlphaComponent(0.08) : NSColor.white.withAlphaComponent(0.58))
      .setFill()
    NSRect(x: 0, y: bounds.height - scale, width: bounds.width, height: scale).fill()
  }
  override func layout() {
    super.layout()
    guard built else { return }
    let button: CGFloat = 28 * scale
    let pad: CGFloat = 28 * scale
    let gap: CGFloat = 8 * scale
    let center = (bounds.height - button) / 2
    searchButton.frame = NSRect(x: pad, y: center, width: button, height: button)
    let fieldWidth = min(
      276 * scale,
      max(100 * scale, bounds.width - 2 * pad - 140 * scale - 4 * button - 5 * gap - 68 * scale))
    let expanded: CGFloat = searchOpen ? fieldWidth + 12 * scale : 0
    search?.frame = NSRect(
      x: pad + button + 7 * scale, y: (bounds.height - 32 * scale) / 2, width: fieldWidth,
      height: 32 * scale)
    let devWidth: CGFloat = 140 * scale
    closeButton.frame = NSRect(
      x: bounds.width - pad - button, y: center, width: button, height: button)
    settingsButton.frame = closeButton.frame.offsetBy(dx: -button - gap, dy: 0)
    queueButton.frame = settingsButton.frame.offsetBy(dx: -button - gap, dy: 0)
    developer.frame = NSRect(
      x: queueButton.frame.minX - gap - devWidth, y: (bounds.height - 32 * scale) / 2,
      width: devWidth, height: 32 * scale)
    badge.frame = NSRect(x: 9 * scale, y: 8 * scale, width: 65 * scale, height: 16 * scale)
    refreshButton.frame = NSRect(x: 77 * scale, y: 2 * scale, width: button, height: button)
    infoButton.frame = NSRect(x: 108 * scale, y: 2 * scale, width: button, height: button)
    let left = searchButton.frame.maxX + 15 * scale + expanded
    tabScroll.frame = NSRect(
      x: left, y: 0, width: max(50 * scale, developer.frame.minX - left - 10 * scale),
      height: bounds.height)
    var x: CGFloat = 0
    for tab in tabs {
      tab.frame = NSRect(x: x, y: 0, width: tab.preferredWidth, height: bounds.height)
      x += tab.preferredWidth + 8 * scale
    }
    let addX = max(0, x - 8 * scale) + scale
    addButton.frame = NSRect(x: addX, y: (bounds.height - 36 * scale) / 2,
      width: 36 * scale, height: 36 * scale)
    tabStrip.frame = NSRect(
      x: 0, y: 0, width: max(tabScroll.bounds.width, addButton.frame.maxX), height: bounds.height)
  }
  func beginSearch() {
    searchOpen = true
    search?.isHidden = false
    searchButton.active = true
    needsLayout = true
    layoutSubtreeIfNeeded()
    window?.makeFirstResponder(search)
  }
  func endEmptySearch() {
    if search?.stringValue.isEmpty == true {
      searchOpen = false
      search?.isHidden = true
      searchButton.active = false
      needsLayout = true
    }
  }
  func setSelection(_ index: Int) {
    for (i, tab) in tabs.enumerated() { tab.selected = i == index }
    needsLayout = true
    layoutSubtreeIfNeeded()
    if index < tabs.count { tabs[index].scrollToVisible(tabs[index].bounds) }
  }
  func setInfoVisible(_ visible: Bool) { infoButton?.active = visible }
  func setQueueActive(_ active: Bool) {
    queueButton?.active = active
    let label = active
      ? (chinese ? "关闭粘贴队列" : "Close paste queue")
      : (chinese ? "开启粘贴队列" : "Open paste queue")
    queueButton?.toolTip = label
    queueButton?.setAccessibilityLabel(label)
  }
  @objc private func toggleSearch() {
    if searchOpen {
      window?.makeFirstResponder(nil)
      endEmptySearch()
    } else {
      beginSearch()
    }
  }
  @objc private func selectFilter(_ sender: PanelTabButton) {
    setSelection(sender.tag)
    onFilter?(sender.tag)
  }
  @objc private func requestAddTab() { onAddTab?() }
  @objc private func refresh() { onRefresh?() }
  @objc private func info() { onDiagnostics?() }
  @objc private func toggleQueue() { onPasteQueue?() }
  @objc private func settings() { onSettings?() }
  @objc private func closePanel() { onClose?() }
}
