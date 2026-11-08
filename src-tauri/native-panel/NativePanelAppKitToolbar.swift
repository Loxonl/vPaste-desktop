// macOS 11 fallback; newer systems use the SwiftUI toolbar.
import AppKit

@MainActor
final class PanelIconButton: NSButton {
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
    if window?.firstResponder === self {
      NSColor.keyboardFocusIndicatorColor.setStroke()
      shape.lineWidth = 2 * scale
      shape.stroke()
    }
  }
}

@MainActor
final class PanelTabButton: NSButton {
  var scale: CGFloat = 1
  var emoji = ""
  var symbol = ""
  var selected = false {
    didSet {
      state = selected ? .on : .off
      needsDisplay = true
    }
  }
  var move: ((Int) -> Void)?
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
  var preferredWidth: CGFloat {
    let text = (title as NSString).size(withAttributes: [
      .font: NSFont.systemFont(ofSize: 14.5 * scale, weight: .semibold)
    ]).width
    return min(128 * scale, max(58 * scale, text + 42 * scale))
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
  override func keyDown(with event: NSEvent) {
    if event.keyCode == 123 {
      move?(-1)
    } else if event.keyCode == 124 {
      move?(1)
    } else {
      super.keyDown(with: event)
    }
  }
  override func draw(_ dirtyRect: NSRect) {
    if hovering {
      (PanelStyle.dark(self)
        ? NSColor.white.withAlphaComponent(0.07) : NSColor.white.withAlphaComponent(0.30)).setFill()
      bounds.fill()
    }
    let color = selected ? PanelStyle.accent(self) : PanelStyle.secondary(self)
    let font = NSFont.systemFont(ofSize: 14.5 * scale, weight: selected ? .bold : .semibold)
    let titleSize = (title as NSString).size(withAttributes: [.font: font])
    let total = titleSize.width + 23 * scale
    let left = max(10 * scale, (bounds.width - total) / 2)
    let iconRect = NSRect(
      x: left, y: (bounds.height - 18 * scale) / 2, width: 18 * scale, height: 18 * scale)
    if !emoji.isEmpty {
      (emoji as NSString).draw(
        in: iconRect.insetBy(dx: -scale, dy: -scale),
        withAttributes: [.font: NSFont.systemFont(ofSize: 17 * scale)])
    } else if symbol == "grid" {
      color.setFill()
      for row in 0..<3 {
        for col in 0..<3 {
          NSRect(
            x: iconRect.minX + CGFloat(col) * 6 * scale,
            y: iconRect.minY + CGFloat(row) * 6 * scale, width: 4 * scale, height: 4 * scale
          ).fill()
        }
      }
    } else {
      ("☆" as NSString).draw(
        in: iconRect.insetBy(dx: -2 * scale, dy: -2 * scale),
        withAttributes: [.font: NSFont.systemFont(ofSize: 22 * scale), .foregroundColor: color])
    }
    (title as NSString).draw(
      at: NSPoint(x: left + 23 * scale, y: (bounds.height - titleSize.height) / 2),
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
    if window?.firstResponder === self {
      NSColor.keyboardFocusIndicatorColor.setStroke()
      let ring = NSBezierPath(
        roundedRect: bounds.insetBy(dx: 2 * scale, dy: 3 * scale), xRadius: 6 * scale,
        yRadius: 6 * scale)
      ring.lineWidth = 2 * scale
      ring.stroke()
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
  var onRefresh: (() -> Void)?
  var onClose: (() -> Void)?
  var onSettings: (() -> Void)?
  var onDiagnostics: (() -> Void)?
  private let tabScroll = PanelScroll()
  private let tabStrip = NSView()
  private var tabs: [PanelTabButton] = []
  private let developer = PanelDeveloperGroup()
  private let badge = NSTextField(labelWithString: "DEV · Native")
  private var searchButton: PanelIconButton!
  private var refreshButton: PanelIconButton!
  private var infoButton: PanelIconButton!
  private var settingsButton: PanelIconButton!
  private var closeButton: PanelIconButton!
  private weak var search: NSSearchField?
  private var scale: CGFloat = 1
  private var searchOpen = false
  private var built = false
  override init(frame: NSRect) { super.init(frame: frame) }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(scale: CGFloat, chinese: Bool, search: NSSearchField) {
    guard !built else { return }
    built = true
    self.scale = scale
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
    search.font = .systemFont(ofSize: 13 * scale)
    search.controlSize = .small
    search.focusRingType = .exterior
    tabScroll.documentView = tabStrip
    tabScroll.drawsBackground = false
    tabScroll.hasHorizontalScroller = false
    tabScroll.hasVerticalScroller = false
    tabScroll.horizontalScrollElasticity = .none
    tabScroll.verticalScrollElasticity = .none
    tabScroll.setAccessibilityLabel(local("History filters", "历史记录筛选"))
    addSubview(tabScroll)
    let choices = [
      ("All", "全部", "", "grid"), ("Favorites", "收藏", "", "star"),
      ("Text", "文本", "📝", ""), ("Image", "图片", "🖼️", ""), ("Link", "链接", "🔗", ""),
      ("Color", "颜色", "🎨", ""), ("File", "文件", "📁", ""),
    ]
    for (index, choice) in choices.enumerated() {
      let button = PanelTabButton()
      button.title = local(choice.0, choice.1)
      button.emoji = choice.2
      button.symbol = choice.3
      button.scale = scale
      button.tag = index
      button.target = self
      button.action = #selector(selectFilter(_:))
      button.setAccessibilityLabel(button.title)
      button.move = { [weak self] step in
        guard let self else { return }
        let next = (index + step + self.tabs.count) % self.tabs.count
        self.tabs[next].performClick(nil)
        self.window?.makeFirstResponder(self.tabs[next])
      }
      tabs.append(button)
      tabStrip.addSubview(button)
    }
    addSubview(developer)
    badge.font = .systemFont(ofSize: 9 * scale, weight: .heavy)
    badge.textColor = PanelStyle.accent(self)
    developer.addSubview(badge)
    refreshButton = icon(
      "arrow.clockwise", local("Refresh", "刷新"), #selector(refresh), in: developer)
    infoButton = icon(
      "info.circle", local("Memory and history details", "内存与历史记录统计"), #selector(info),
      in: developer)
    settingsButton = icon("gearshape", local("Settings", "设置"), #selector(settings))
    closeButton = icon("xmark", local("Close native panel", "关闭原生主界面"), #selector(closePanel))
    setSelection(0)
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    badge.textColor = PanelStyle.accent(self)
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
      max(100 * scale, bounds.width - 2 * pad - 140 * scale - 3 * button - 4 * gap - 68 * scale))
    let expanded: CGFloat = searchOpen ? fieldWidth + 12 * scale : 0
    search?.frame = NSRect(
      x: pad + button + 7 * scale, y: (bounds.height - 32 * scale) / 2, width: fieldWidth,
      height: 32 * scale)
    let devWidth: CGFloat = 140 * scale
    closeButton.frame = NSRect(
      x: bounds.width - pad - button, y: center, width: button, height: button)
    settingsButton.frame = closeButton.frame.offsetBy(dx: -button - gap, dy: 0)
    developer.frame = NSRect(
      x: settingsButton.frame.minX - gap - devWidth, y: (bounds.height - 32 * scale) / 2,
      width: devWidth, height: 32 * scale)
    badge.frame = NSRect(x: 9 * scale, y: 8 * scale, width: 65 * scale, height: 16 * scale)
    refreshButton.frame = NSRect(x: 77 * scale, y: 2 * scale, width: button, height: button)
    infoButton.frame = NSRect(x: 108 * scale, y: 2 * scale, width: button, height: button)
    let left = searchButton.frame.maxX + 10 * scale + expanded
    tabScroll.frame = NSRect(
      x: left, y: 0, width: max(50 * scale, developer.frame.minX - left - 10 * scale),
      height: bounds.height)
    var x: CGFloat = 0
    for tab in tabs {
      tab.frame = NSRect(x: x, y: 0, width: tab.preferredWidth, height: bounds.height)
      x += tab.preferredWidth + 8 * scale
    }
    tabStrip.frame = NSRect(
      x: 0, y: 0, width: max(tabScroll.bounds.width, x - 8 * scale), height: bounds.height)
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
    if index < tabs.count { tabs[index].scrollToVisible(tabs[index].bounds) }
  }
  func setInfoVisible(_ visible: Bool) { infoButton?.active = visible }
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
  @objc private func refresh() { onRefresh?() }
  @objc private func info() { onDiagnostics?() }
  @objc private func settings() { onSettings?() }
  @objc private func closePanel() { onClose?() }
}
