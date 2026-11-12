import AppKit
import ObjectiveC
import QuartzCore

final class NativeHistoryPanel: NSPanel {
  var keyHandler: ((NSEvent) -> Bool)?
  var pointerHandler: (() -> Void)?
  var sizePreview = false { didSet { updateGlassAppearance() } }
  init(dockedFrame: NSRect) {
    super.init(contentRect: dockedFrame, styleMask: [.borderless], backing: .buffered, defer: false)
    isMovable = false
    isMovableByWindowBackground = false
    isReleasedWhenClosed = false
    animationBehavior = .none
    setFrame(dockedFrame, display: false)
    updateGlassAppearance()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  // The main panel deliberately extends below the Dock and past both screen
  // edges. AppKit's visible-frame constraint must not pull this panel upward.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    frameRect
  }
  override var canBecomeKey: Bool { !sizePreview }
  override var canBecomeMain: Bool { !sizePreview }
  func retainMainAppearanceForPreview() {
    guard !sizePreview, isVisible, !isMainWindow else { return }
    // A utility preview owns keyboard input; this panel remains the main surface.
    // makeMain changes the main role without ordering the panel or taking key focus.
    makeMain()
  }
  private func updateGlassAppearance() {
    #if VPASTE_LIQUID_GLASS_SDK
      guard #available(macOS 26.0, *) else { return }
      // Liquid Glass has no public equivalent of NSVisualEffectView.state.
      // Keep only this DEV panel's appearance active through focus loss and the
      // closing slide. This does not change actual key/main status or activation.
      let selector = NSSelectorFromString("_setForceMainAppearance:")
      guard responds(to: selector),
        let method = class_getInstanceMethod(type(of: self), selector),
        method_getNumberOfArguments(method) == 3 else { return }
      let resultType = method_copyReturnType(method)
      defer { free(resultType) }
      guard let valueType = method_copyArgumentType(method, 2) else { return }
      defer { free(valueType) }
      guard String(cString: resultType) == "v",
        ["B", "c"].contains(String(cString: valueType)) else { return }
      typealias SetAppearance = @convention(c) (AnyObject, Selector, ObjCBool) -> Void
      let setAppearance = unsafeBitCast(method_getImplementation(method), to: SetAppearance.self)
      setAppearance(self, selector, ObjCBool(!sizePreview))
      if ProcessInfo.processInfo.arguments.contains("--native-panel-check") {
        NSLog("[native-panel] keep-glass-appearance=%d sizePreview=%d", !sizePreview, sizePreview)
      }
      // Do not reset this in windowWillClose: that notification precedes orderOut
      // and would let an inactive final frame reach the compositor.
    #endif
  }
  override func sendEvent(_ event: NSEvent) {
    if [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(event.type) {
      pointerHandler?()
    }
    super.sendEvent(event)
  }
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let editor = firstResponder as? NSTextView
    let composing = editor?.hasMarkedText() == true
    let command = event.modifierFlags.contains(.command)
    let character = event.charactersIgnoringModifiers?.lowercased()
    // SwiftUI buttons and a collapsed search can leave focus on the toolbar or
    // window. Keep main commands available without stealing text-copy, cursor
    // movement or Escape from an active input-method composition.
    let toolbarCommand = !composing && command && (character == "f" || character == "r")
    let dismissCommand = event.keyCode == 53 && editor == nil
    let categoryCommand = !composing && event.keyCode == 48 && event.modifierFlags.contains(.control)
      && !event.modifierFlags.contains(.command) && !event.modifierFlags.contains(.option)
    if (firstResponder is PanelList || toolbarCommand || dismissCommand || categoryCommand),
      keyHandler?(event) == true { return true }
    return super.performKeyEquivalent(with: event)
  }
}

@MainActor
enum PanelSlide {
  static func prepare(_ surface: NSView, hidden: Bool) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    surface.layer?.removeAnimation(forKey: "position")
    surface.setFrameOrigin(NSPoint(x: 0, y: hidden ? -surface.bounds.height : 0))
    CATransaction.commit()
  }

  static func animate(
    _ surface: NSView, show: Bool, duration: Double, curve: [Double], reduced: Bool,
    completion: @escaping () -> Void
  ) {
    guard !reduced, let layer = surface.layer else {
      prepare(surface, hidden: !show)
      completion()
      return
    }
    // Match panel_animation/macos.rs: the host frame is fixed and one child
    // containing the glass and controls moves. Retarget an interrupted opening
    // from its presentation position, rather than jumping to the model endpoint.
    let start = show ? layer.position : (layer.presentation()?.position ?? layer.position)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    CATransaction.setCompletionBlock {
      MainActor.assumeIsolated { completion() }
    }
    surface.setFrameOrigin(NSPoint(x: 0, y: show ? 0 : -surface.bounds.height))
    let animation = CABasicAnimation(keyPath: "position")
    animation.fromValue = NSValue(point: start)
    animation.toValue = NSValue(point: layer.position)
    animation.duration = duration
    if curve.count == 4 {
      animation.timingFunction = CAMediaTimingFunction(
        controlPoints: Float(curve[0]), Float(curve[1]), Float(curve[2]), Float(curve[3]))
    }
    layer.add(animation, forKey: "position")
    CATransaction.commit()
  }
}

@MainActor
final class NativePanelController: NSObject, NSWindowDelegate, NSSearchFieldDelegate,
  NSCollectionViewDataSource, NSCollectionViewDelegate
{
  let bridge: PanelBridge
  private let config: PanelConfiguration
  private let window: NativeHistoryPanel
  private let root = NSView()
  private let backdrop: PanelBackdrop
  private var surface: NSView { backdrop.contentView }
  private let search = NSSearchField()
  private let toolbar = PanelToolbar()
  private let infoBar = PanelInfoBar()
  private let emptyState = PanelEmptyState()
  private var infoHeight: NSLayoutConstraint!
  private var footer: NSTextField { infoBar.label }
  private let list = PanelList()
  private let layout = PanelListLayout()
  private let scroll = PanelScroll()
  private let media = PanelMedia()
  private var filter = ""
  private var filterIndex = 0
  private var filterEntryPending = false
  private var filterEntryPreviousHashes: [String] = []
  private var filterEntrySequence = 0
  private var filterEntryHashes: Set<String> = []
  private var filterEntryAnimated: Set<String> = []
  private var pendingPreviewSelection: (index: Int, direction: Int)?
  private lazy var previews = PanelPreviewDriver(hoverEnabled: config.hoverPreviewEnabled) {
    [weak self] operation, args in
    guard let self, !self.closed else { return }
    if operation == "hover-dismiss" || operation == "preview-close" {
      self.bridge.send(operation, args)
      return
    }
    guard !self.hiding, self.window.attachedSheet == nil, !self.dragging else { return }
    if args["mode"] as? String == "hover", !self.window.isKeyWindow { return }
    self.bridge.send(operation, args) { [weak self] result in
      if case .failure(let error) = result, args["mode"] as? String != "hover" {
        self?.showMessage(error.localizedDescription)
      }
    }
  }
  private var token: PanelToken?
  private var pages: [Int: [PanelRef]] = [:]
  private var cards: [String: PanelCard] = [:]
  private let renderedViews = NSHashTable<PanelCardView>.weakObjects()
  private var missingCards = Set<String>()
  private var pendingPages = Set<Int>()
  private var cardRequest = false
  private var count = 0
  private var hasMore = false
  private var terminalCount: Int?
  private var selected = 0
  private var generation = 0
  private var pageEpoch = 0
  private var closed = false
  private var dragging = false
  private var heldHash: String?
  private var debounce: DispatchWorkItem?
  private var boundsObserver: NSObjectProtocol?
  private var applicationFocus: PanelApplicationFocus?
  private var mainRoleObserver: NSObjectProtocol?
  private let previewWindows = NSHashTable<NSWindow>.weakObjects()
  private var transition = 0
  private var starting = true
  private var hiding = false
  private var viewportScheduled = false
  private var lastViewport = ""
  private var busyAction = false
  private var lastDiagnostic = ""
  private var chinese: Bool { config.chinese }
  private func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }

  init(callbacks: VPastePanelCallbacks, config: PanelConfiguration) {
    self.config = config
    backdrop = PanelBackdrop(scale: config.scale)
    bridge = PanelBridge(callbacks, session: config.session)
    let screen =
      NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
      ?? NSScreen.main
    let bounds = screen?.frame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    let fallback = NSRect(
      x: bounds.minX - config.horizontalBleed, y: bounds.minY,
      width: bounds.width + config.horizontalBleed * 2, height: config.panelHeight)
    window = NativeHistoryPanel(dockedFrame: config.dockedFrame?.rect ?? fallback)
    super.init()
    build()
  }
  private func build() {
    window.title = "vPaste · Native panel (DEV)"
    window.sizePreview = config.sizePreview
    window.ignoresMouseEvents = config.sizePreview
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.isReleasedWhenClosed = false
    window.hidesOnDeactivate = false
    window.acceptsMouseMovedEvents = true
    window.level = NSWindow.Level(rawValue: 103)
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.delegate = self
    window.keyHandler = { [weak self] event in self?.key(event) ?? false }
    window.pointerHandler = { [weak self] in self?.previews.cancelHover() }
    applicationFocus = PanelApplicationFocus { [weak self] active in
      guard let self, !self.closed, !self.config.sizePreview else { return }
      self.bridge.setKey(active && self.window.isKeyWindow)
      if !active { self.scheduleFocusLoss() }
    }
    mainRoleObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.didBecomeMainNotification, object: nil, queue: .main
    ) { [weak self] notification in
      MainActor.assumeIsolated {
        guard let self, let preview = notification.object as? NSWindow,
          self.previewWindows.contains(preview) else { return }
        self.retainMainAppearanceForPreview(windowNumber: preview.windowNumber)
      }
    }
    switch config.theme {
    case "dark": window.appearance = NSAppearance(named: .darkAqua)
    case "light": window.appearance = NSAppearance(named: .aqua)
    default: window.appearance = nil
    }
    root.frame = NSRect(origin: .zero, size: window.frame.size)
    root.wantsLayer = true
    root.layer?.masksToBounds = true
    window.contentView = root
    backdrop.frame = root.bounds
    backdrop.wantsLayer = true
    backdrop.autoresizingMask = [.width, .height]
    root.addSubview(backdrop)
    toolbar.configure(scale: config.scale, chinese: chinese, search: search)
    toolbar.translatesAutoresizingMaskIntoConstraints = false
    surface.addSubview(toolbar)
    search.placeholderString = local("Search clipboard history", "搜索剪贴板历史")
    search.delegate = self
    search.sendsSearchStringImmediately = true
    search.setAccessibilityLabel(search.placeholderString)
    toolbar.onFilter = { [weak self] index in self?.changeFilter(index) }
    toolbar.onAddTab = { [weak self] in self?.openAddTabMenu() }
    toolbar.onTabContextMenu = { [weak self] in self?.openTabContextMenu(id: $0, at: $1) }
    toolbar.onRefresh = { [weak self] in self?.reload() }
    toolbar.onClose = { [weak self] in self?.dismiss() }
    toolbar.onSettings = { [weak self] in self?.bridge.send("settings") }
    toolbar.onDiagnostics = { [weak self] in self?.setInfoVisible(self?.infoBar.isHidden ?? true) }
    layout.cardWidth = PanelStyle.cardWidth * config.scale
    layout.gap = PanelStyle.cardGap * config.scale
    layout.inset = PanelStyle.cardInset * config.scale
    layout.verticalInset = PanelStyle.cardPadding * config.scale
    layout.maximumCardHeight = PanelStyle.cardHeight * config.scale
    list.collectionViewLayout = layout
    list.autoresizingMask = []
    list.backgroundColors = [.clear]
    list.isSelectable = true
    list.allowsMultipleSelection = false
    list.dataSource = self
    list.delegate = self
    list.register(PanelCardItem.self, forItemWithIdentifier: NSUserInterfaceItemIdentifier("card"))
    list.keyHandler = { [weak self] event in self?.key(event) ?? false }
    scroll.documentView = list
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    surface.addSubview(scroll)
    infoBar.scale = config.scale
    infoBar.isHidden = true
    infoBar.translatesAutoresizingMaskIntoConstraints = false
    surface.addSubview(infoBar)
    emptyState.scale = config.scale
    emptyState.translatesAutoresizingMaskIntoConstraints = false
    surface.addSubview(emptyState)
    infoHeight = infoBar.heightAnchor.constraint(equalToConstant: 0)
    NSLayoutConstraint.activate([
      toolbar.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
      toolbar.topAnchor.constraint(equalTo: surface.topAnchor),
      toolbar.heightAnchor.constraint(equalToConstant: PanelStyle.headerHeight * config.scale),
      scroll.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: infoBar.topAnchor),
      infoBar.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
      infoBar.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
      infoBar.bottomAnchor.constraint(equalTo: surface.bottomAnchor), infoHeight,
      emptyState.leadingAnchor.constraint(equalTo: scroll.leadingAnchor),
      emptyState.trailingAnchor.constraint(equalTo: scroll.trailingAnchor),
      emptyState.topAnchor.constraint(equalTo: scroll.topAnchor),
      emptyState.bottomAnchor.constraint(equalTo: scroll.bottomAnchor),
    ])
    scroll.contentView.postsBoundsChangedNotifications = true
    boundsObserver = NotificationCenter.default.addObserver(
      forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.scheduleViewport() }
    }
    bridge.changed = { [weak self] in
      guard let self, !self.closed, !self.dragging, !self.busyAction else { return }
      self.scheduleReload()
    }
    bridge.event = { [weak self] name, value in
      guard let self, !self.closed else { return }
      if name == "tabs-changed" {
        if let id = value["activeId"] as? String { self.pendingTabSelection = id }
        self.reload()
        if let message = value["assignmentError"] as? String {
          self.showMessage(self.local("Could not add the new tag: \(message)", "无法添加新标签：\(message)"))
        }
      } else if name == "preview-focused", let number = value["windowNumber"] as? Int {
        self.retainMainAppearanceForPreview(windowNumber: number)
      } else if name == "preview-hover", let inside = value["inside"] as? Bool {
        self.previews.pointerInPreview(inside)
      } else if name == "preview-navigation" {
        let direction = (value["direction"] as? Int) == -1 ? -1 : 1
        self.previews.cancelHover()
        if value["ctrlKey"] as? Bool == true {
          let tabs = PanelFilterQuery.count(tabs: self.tabs)
          self.changeFilter((self.filterIndex + direction + tabs) % tabs)
        } else if value["key"] as? String != "Tab" || self.config.tabQuickSelectEnabled {
          self.select(max(0, min(self.count - 1, self.selected + direction)), scroll: true)
        }
      }
    }
    media.changed = { [weak self] in self?.status() }
  }
  func present() {
    root.layoutSubtreeIfNeeded()
    if let screen = window.screen {
      let frame = window.frame
      bridge.send("surface", ["frame": [frame.minX - screen.frame.minX,
        screen.frame.maxY - frame.maxY, frame.width, frame.height]])
    }
    // Prepare before ordering the host front, so the first composited frame is
    // already below the clipped surface, just like the existing main panel.
    PanelSlide.prepare(
      backdrop, hidden: !config.sizePreview && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    if ProcessInfo.processInfo.arguments.contains("--native-panel-check") {
      NSLog("[native-panel] toolbar=%@", toolbar.rendererName)
      NSLog(
        "[native-panel] backdrop=%@ host=%@ expected=%@ movable=%d backgroundMovable=%d scrollers=%d/%d",
        backdrop.materialName, NSStringFromRect(window.frame),
        config.dockedFrame.map { NSStringFromRect($0.rect) } ?? "screen fallback",
        window.isMovable, window.isMovableByWindowBackground,
        scroll.hasHorizontalScroller, scroll.hasVerticalScroller)
    }
    if config.sizePreview {
      window.orderFrontRegardless()
      starting = false
    } else {
      focus()
      animate(show: true) { [weak self] in self?.starting = false }
    }
    reload()
  }
  private func focus() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    // Borderless panels do not automatically become the app's main window.
    window.makeMain()
    window.makeFirstResponder(list)
  }
  func activate(toggle: Bool) -> Bool {
    guard !closed, !hiding, !config.sizePreview else { return false }
    if toggle { dismiss() } else { focus() }
    return true
  }
  private func animate(show: Bool, completion: @escaping () -> Void) {
    transition &+= 1
    let id = transition
    let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let duration = (show ? config.showDuration : config.hideDuration) / 1000
    let check = ProcessInfo.processInfo.arguments.contains("--native-panel-check")
    if check {
      NSLog(
        "[native-panel] slide=%@ duration=%.3f reduced=%d startY=%.1f host=%@",
        show ? "show" : "hide", duration, reduced,
        backdrop.layer?.presentation()?.frame.origin.y ?? backdrop.frame.origin.y,
        NSStringFromRect(window.frame))
      if !reduced {
        DispatchQueue.main.asyncAfter(deadline: .now() + duration / 2) { [weak self] in
          guard let self, !self.closed, self.transition == id else { return }
          NSLog(
            "[native-panel] slide-mid=%@ contentY=%.1f host=%@",
            show ? "show" : "hide",
            self.backdrop.layer?.presentation()?.frame.origin.y ?? self.backdrop.frame.origin.y,
            NSStringFromRect(self.window.frame))
        }
      }
    }
    PanelSlide.animate(
      backdrop, show: show, duration: duration, curve: show ? config.showCurve : config.hideCurve,
      reduced: reduced
    ) { [weak self] in
      guard let self, !self.closed, self.transition == id else { return }
      if check {
        NSLog(
          "[native-panel] slide-end=%@ contentY=%.1f host=%@", show ? "show" : "hide",
          self.backdrop.frame.origin.y, NSStringFromRect(self.window.frame))
      }
      completion()
    }
  }
  func dismiss(animated: Bool = true) {
    guard !closed else { return }
    if animated {
      guard !hiding else { return }
      hiding = true
      animate(show: false) { [weak self] in self?.window.close() }
    } else {
      transition &+= 1
      window.close()
    }
  }
  func windowWillClose(_ notification: Notification) {
    guard !closed else { return }
    closed = true
    generation &+= 1
    debounce?.cancel()
    debounce = nil
    if let boundsObserver { NotificationCenter.default.removeObserver(boundsObserver) }
    boundsObserver = nil
    applicationFocus?.close()
    applicationFocus = nil
    if let mainRoleObserver { NotificationCenter.default.removeObserver(mainRoleObserver) }
    mainRoleObserver = nil
    previewWindows.removeAllObjects()
    previews.close()
    pendingPreviewSelection = nil
    toolbar.releaseContent()
    search.delegate = nil
    for view in renderedViews.allObjects { view.releaseContent() }
    renderedViews.removeAllObjects()
    missingCards.removeAll()
    bridge.close()
    media.changed = nil
    media.clear()
    pages.removeAll()
    cards.removeAll()
    pendingPages.removeAll()
    token = nil
    list.dataSource = nil
    list.delegate = nil
    window.delegate = nil
    window.keyHandler = nil
    window.pointerHandler = nil
    if ProcessInfo.processInfo.arguments.contains("--native-panel-check") {
      NSLog(
        "[native-panel] closed cards=%d pages=%d decodedBytes=%d", cards.count, pages.count,
        media.decodedBytes)
    }
    if panelController === self { panelController = nil }
  }
  func windowDidBecomeKey(_ notification: Notification) { bridge.setKey(NSApp.isActive) }
  func windowDidResignKey(_ notification: Notification) {
    bridge.setKey(false)
    scheduleFocusLoss()
  }
  private func retainMainAppearanceForPreview(windowNumber number: Int) {
    // AppKit may finish assigning the main role after its key notification.
    // Defer until that event unwinds, and ignore superseded focus handoffs.
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.closed, !self.hiding, NSApp.isActive,
        let preview = NSApp.keyWindow, preview.windowNumber == number else { return }
      self.previewWindows.add(preview)
      self.window.retainMainAppearanceForPreview()
      if ProcessInfo.processInfo.arguments.contains("--native-panel-check") {
        NSLog("[native-panel] preview-focus main=%d key=%d alpha=%.2f",
          self.window.isMainWindow, self.window.isKeyWindow, self.window.alphaValue)
      }
    }
  }
  private func scheduleFocusLoss() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
      guard let self, !self.closed, (!self.starting || !NSApp.isActive),
        (!self.window.isKeyWindow || !NSApp.isActive),
        self.window.attachedSheet == nil, !self.dragging
      else { return }
      self.bridge.send("blur")
    }
  }
  private func changeFilter(_ index: Int) {
    guard let label = PanelFilterQuery.label(index: index, tabs: tabs) else { return }
    pendingTabSelection = nil
    previews.clear()
    pendingPreviewSelection = nil
    filterIndex = index
    filter = label
    let previousHashes = (0..<min(count, 36)).compactMap { ref($0)?.hash }
    toolbar.setSelection(index)
    reload()
    // WebView animates the new result cards when the filter actually changes
    // them; compare against the first page captured before this reload.
    filterEntryPreviousHashes = previousHashes
    filterEntryPending = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    window.makeFirstResponder(list)
  }
  private func setInfoVisible(_ visible: Bool) {
    infoBar.isHidden = !visible
    infoHeight.constant = visible ? 28 * config.scale : 0
    toolbar.setInfoVisible(visible)
    root.layoutSubtreeIfNeeded()
    syncListSize()
    scheduleViewport()
  }
  private func showMessage(_ message: String) {
    footer.stringValue = message
    setInfoVisible(true)
    if count == 0 { emptyState.show(title: message, detail: "") }
  }
  func controlTextDidEndEditing(_ obj: Notification) { toolbar.endEmptySearch() }
  func controlTextDidChange(_ obj: Notification) {
    if (search.currentEditor() as? NSTextView)?.hasMarkedText() == true { return }
    previews.clear()
    pendingPreviewSelection = nil
    scheduleReload()
  }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if textView.hasMarkedText() { return false }
    if selector == #selector(NSResponder.insertNewline(_:)) {
      action("paste", at: selected)
      return true
    }
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      dismiss()
      return true
    }
    if selector == #selector(NSResponder.moveDown(_:)) {
      window.makeFirstResponder(list)
      return true
    }
    return false
  }
  private func scheduleReload() {
    debounce?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.reload() }
    debounce = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
  }
  private func reload() {
    guard !closed else { return }
    refreshTabs()
    filterEntryPending = false
    filterEntryPreviousHashes = []
    filterEntryHashes.removeAll()
    filterEntryAnimated.removeAll()
    previews.cancelHover()
    pendingPreviewSelection = nil
    generation &+= 1
    let epoch = generation
    token = nil
    for view in renderedViews.allObjects { view.releaseContent() }
    renderedViews.removeAllObjects()
    missingCards.removeAll()
    pages.removeAll()
    cards.removeAll()
    pendingPages.removeAll()
    cardRequest = false
    count = 0
    hasMore = false
    terminalCount = nil
    selected = 0
    lastViewport = ""
    media.clear()
    layout.itemCount = 0
    list.reloadData()
    syncListSize()
    scroll.contentView.scroll(to: .zero)
    emptyState.show(title: local("Loading history…", "正在加载历史记录…"), detail: "", loading: true)
    footer.stringValue = local("Loading history…", "正在加载历史记录…")
    bridge.send("open", ["keywords": search.stringValue, "label": filter]) { [weak self] result in
      guard let self, self.generation == epoch, !self.closed else { return }
      do {
        let page = try panelDecode(PanelPage.self, result.get())
        self.token = page.token
        self.accept(page)
        self.scheduleViewport()
      } catch {
        self.filterEntryPending = false
        self.showMessage(error.localizedDescription)
      }
    }
  }
  private func accept(_ page: PanelPage) {
    if filterEntryPending, page.pageIndex == 0 {
      filterEntryPending = false
      let hashes = page.items.map(\.hash)
      if hashes != filterEntryPreviousHashes {
        filterEntrySequence &+= 1
        filterEntryHashes = Set(hashes)
        filterEntryAnimated.removeAll()
      }
    }
    pages[page.pageIndex] = page.items
    count = max(count, page.startIndex + page.items.count)
    if !page.hasMore { terminalCount = page.knownCount }
    if let terminalCount {
      count = terminalCount
      hasMore = false
    } else {
      hasMore = true
    }
    layout.itemCount = count + (hasMore ? 1 : 0)
    list.reloadData()
    syncListSize()
    if count == 0 {
      emptyState.show(
        title: local("No matching history", "没有匹配的历史记录"),
        detail: local("Try another search or filter", "试试其他关键词或筛选条件"))
    } else {
      emptyState.hide()
    }
    refreshSelectedPreview()
    status()
  }
  // Remove one record from the loaded pages instead of reloading the view.
  // Later cards shift forward, matching the WebView's local page update.
  private func removeHistoryItem(hash: String, at index: Int) {
    guard !closed, index >= 0, index < count,
      let splice = PanelPageSplice.remove(hash: hash, at: index, pages: pages)
    else {
      reload()
      return
    }
    pages = splice.pages
    // Page payloads requested before this deletion describe the old offsets.
    pageEpoch &+= 1
    pendingPages.removeAll()
    count = max(0, count - 1)
    if let terminalCount { self.terminalCount = max(0, terminalCount - 1) }
    cards.removeValue(forKey: hash)
    missingCards.remove(hash)
    previews.clear()
    pendingPreviewSelection = nil
    if heldHash == hash {
      heldHash = nil
      dragging = false
    }
    if selected > index {
      selected -= 1
    } else if selected == index {
      selected = max(0, min(index, count - 1))
    }
    layout.itemCount = count + (hasMore ? 1 : 0)
    list.deleteItems(at: [IndexPath(item: index, section: 0)])
    if count == 0 {
      emptyState.show(
        title: local("No matching history", "没有匹配的历史记录"),
        detail: local("Try another search or filter", "试试其他关键词或筛选条件"))
    } else {
      emptyState.hide()
    }
    status()
    let needsTail = hasMore || (splice.runEndWasFull && splice.coveredEnd < count)
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.closed else { return }
      for path in self.list.indexPathsForVisibleItems() {
        if let item = self.list.item(at: path) as? PanelCardItem {
          self.configure(item, index: path.item)
        }
      }
      self.syncListSize()
      self.scheduleViewport()
      if needsTail { self.refreshPage(splice.endPage) }
    }
  }
  // Refill the final loaded page after a local deletion without touching the
  // rest of the visible list.
  private func refreshPage(_ index: Int) {
    guard !closed, let token, index >= 0, !pendingPages.contains(index) else { return }
    let epoch = generation
    let requestEpoch = pageEpoch
    pendingPages.insert(index)
    bridge.send(
      "page", ["viewId": token.viewId, "revision": token.revision, "page": index]
    ) { [weak self] result in
      guard let self, self.generation == epoch, self.pageEpoch == requestEpoch,
        !self.closed
      else { return }
      self.pendingPages.remove(index)
      do {
        let page = try panelDecode(PanelPage.self, result.get())
        guard page.pageIndex == index else { return }
        let previous = self.count
        if !page.hasMore {
          // The refetched page now reaches the end of the result set; use the
          // normal acceptance path so the "load more" row is reconciled.
          self.accept(page)
          return
        }
        self.pages[index] = page.items
        let coverage = page.startIndex + page.items.count
        if coverage > previous {
          self.count = coverage
          self.layout.itemCount = self.count + 1
          self.list.insertItems(
            at: Set((previous..<coverage).map { IndexPath(item: $0, section: 0) }))
          self.emptyState.hide()
        }
        for path in self.list.indexPathsForVisibleItems() {
          if let item = self.list.item(at: path) as? PanelCardItem {
            self.configure(item, index: path.item)
          }
        }
        self.syncListSize()
        self.scheduleViewport()
        self.status()
      } catch { self.showMessage(error.localizedDescription) }
    }
  }
  private func syncListSize() {
    let viewport = scroll.contentView.bounds.size
    guard viewport.width > 0, viewport.height > 0 else { return }
    layout.viewportSize = viewport
    layout.invalidateLayout()
    // AppKit must know the full document extent, independently of its item cache.
    // The layout still creates attributes and views only around the visible rect.
    let extent = layout.collectionViewContentSize
    if list.frame.size != extent { list.setFrameSize(extent) }
    scroll.reflectScrolledClipView(scroll.contentView)
  }
  private func ref(_ index: Int) -> PanelRef? {
    guard index >= 0, let page = pages[index / 36], index % 36 < page.count else { return nil }
    return page[index % 36]
  }
  func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int)
    -> Int
  { count + (hasMore ? 1 : 0) }
  func numberOfSections(in collectionView: NSCollectionView) -> Int { 1 }
  func collectionView(
    _ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath
  ) -> NSCollectionViewItem {
    let item =
      collectionView.makeItem(withIdentifier: NSUserInterfaceItemIdentifier("card"), for: indexPath)
      as! PanelCardItem
    configure(item, index: indexPath.item)
    scheduleViewport()
    return item
  }
  private func configure(_ item: PanelCardItem, index: Int) {
    let entry = ref(index)
    let card = entry.flatMap { cards[$0.hash] }
    let view = item.cardView
    renderedViews.add(view)
    view.configure(
      card, placeholder: local("Loading…", "加载中…"), media: media, scale: config.scale,
      chinese: chinese, query: search.stringValue, selected: index == selected)
    if let hash = entry?.hash, filterEntryHashes.contains(hash), !filterEntryAnimated.contains(hash) {
      filterEntryAnimated.insert(hash)
      view.playFilterEntry(sequence: filterEntrySequence, hash: hash, index: index)
    }
    view.singleClick = config.mousePasteMode == "single"
    view.select = { [weak self] in self?.select(index, scroll: false) }
    let previewItem = entry.map { PanelPreviewItem(hash: $0.hash, itemType: $0.itemType) }
    view.hoverEntered = { [weak self] in
      guard let self, let previewItem, !self.dragging, !self.busyAction,
        self.window.attachedSheet == nil else { return }
      self.select(index, scroll: false)
      self.previews.enter(previewItem)
    }
    view.hoverLeft = { [weak self] in
      if let previewItem { self?.previews.leave(previewItem) }
    }
    view.activate = { [weak self] in self?.action("paste", at: index) }
    view.requestMenu = { [weak self] point in self?.openContextMenu(at: index, point: point) }
    view.prepareDrag = { [weak self] completion in
      guard let self, let hash = self.ref(index)?.hash else { return }
      self.dragging = true
      self.heldHash = hash
      self.bridge.send("drag", ["hash": hash]) { [weak self] result in
        guard let self, !self.closed else { return }
        if case .success(let value) = result, let value = value as? [String: Any] {
          completion(value)
        } else {
          self.dragging = false
          self.heldHash = nil
          self.showMessage(self.local("Drag could not start", "无法开始拖拽"))
        }
      }
    }
    view.dragEnded = { [weak self] in
      self?.dragging = false
      self?.heldHash = nil
      self?.scheduleViewport()
    }
  }
  func collectionView(
    _ collectionView: NSCollectionView, willDisplay item: NSCollectionViewItem,
    forRepresentedObjectAt indexPath: IndexPath
  ) {
    if let item = item as? PanelCardItem { configure(item, index: indexPath.item) }
    scheduleViewport()
  }
  func collectionView(
    _ collectionView: NSCollectionView, didEndDisplaying item: NSCollectionViewItem,
    forRepresentedObjectAt indexPath: IndexPath
  ) {
    let view = (item as? PanelCardItem)?.cardView
    if view?.card?.hash != heldHash { view?.releaseContent() }
  }
  private func scheduleViewport() {
    guard !viewportScheduled, !closed else { return }
    viewportScheduled = true
    DispatchQueue.main.async { [weak self] in
      self?.viewportScheduled = false
      self?.updateViewport()
    }
  }
  private func range() -> Range<Int> {
    let x = scroll.contentView.bounds.minX
    let start = min(
      count, max(0, Int(floor((x - layout.inset) / (layout.cardWidth + layout.gap))) - 2))
    let end = min(
      count, Int(ceil((x + scroll.contentView.bounds.width) / (layout.cardWidth + layout.gap))) + 2)
    return start..<max(start, end)
  }
  private func updateViewport() {
    guard !closed, let token, count > 0 else { return }
    if layout.viewportSize != scroll.contentView.bounds.size { syncListSize() }
    let desired = range()
    let epoch = generation
    let requestEpoch = pageEpoch
    let first = desired.lowerBound / 36
    let last = max(desired.lowerBound, desired.upperBound - 1) / 36
    var needed = Set(first...last)
    if hasMore && desired.upperBound >= count - 4 { needed.insert(count / 36) }
    for page in needed.sorted() where pages[page] == nil && !pendingPages.contains(page) {
      if pendingPages.count >= 2 { break }
      pendingPages.insert(page)
      bridge.send("page", ["viewId": token.viewId, "revision": token.revision, "page": page]) {
        [weak self] result in
        guard let self, self.generation == epoch, self.pageEpoch == requestEpoch,
          !self.closed
        else { return }
        self.pendingPages.remove(page)
        do {
          self.accept(try panelDecode(PanelPage.self, result.get()))
          self.scheduleViewport()
        } catch { self.showMessage(error.localizedDescription) }
      }
    }
    let keepPages = Set(max(0, first - 1)...last + 1)
    pages = pages.filter { keepPages.contains($0.key) }
    var hashes = Set(desired.compactMap { ref($0)?.hash })
    if let heldHash { hashes.insert(heldHash) }
    cards = cards.filter { hashes.contains($0.key) }
    missingCards.formIntersection(hashes)
    for view in renderedViews.allObjects {
      if let hash = view.card?.hash, !hashes.contains(hash) { view.releaseContent() }
    }
    let viewport = "\(desired.lowerBound):\(desired.upperBound)"
    if viewport != lastViewport {
      lastViewport = viewport
      bridge.send(
        "viewport",
        [
          "viewId": token.viewId, "revision": token.revision, "start": desired.lowerBound,
          "end": desired.upperBound,
        ])
    }
    guard !cardRequest else {
      status()
      return
    }
    let missing = desired.compactMap { ref($0)?.hash }.filter {
      cards[$0] == nil && !missingCards.contains($0)
    }
    guard !missing.isEmpty else {
      status()
      return
    }
    cardRequest = true
    let pixels = layout.cardWidth * (window.screen?.backingScaleFactor ?? 2)
    let width = pixels <= 240 ? 240 : pixels <= 480 ? 480 : 720
    let requested = Array(missing.prefix(24))
    bridge.send(
      "cards",
      [
        "viewId": token.viewId, "revision": token.revision, "hashes": requested,
        "width": width,
      ]
    ) { [weak self] result in
      guard let self, self.generation == epoch, !self.closed else { return }
      self.cardRequest = false
      do {
        let response = try panelDecode(PanelCards.self, result.get())
        let wanted = Set(self.range().compactMap { self.ref($0)?.hash })
        let returned = Set(response.cards.map(\.hash))
        for hash in requested where wanted.contains(hash) && !returned.contains(hash) {
          self.missingCards.insert(hash)
        }
        for card in response.cards where wanted.contains(card.hash) { self.cards[card.hash] = card }
        for index in self.list.indexPathsForVisibleItems() {
          if let item = self.list.item(at: index) as? PanelCardItem {
            self.configure(item, index: index.item)
          }
        }
        // A vanished record must not cause an endless payload-request loop.
        if response.cards.isEmpty {
          self.showMessage(self.local("History changed. Refresh to reload.", "记录已变化，请刷新。"))
        } else {
          self.scheduleViewport()
        }
      } catch { self.showMessage(error.localizedDescription) }
    }
  }
  private func status() {
    if ProcessInfo.processInfo.arguments.contains("--native-panel-check") {
      let diagnostic =
        "items=\(count) selected=\(selected) frame=\(list.frame) bounds=\(list.bounds) clip=\(scroll.contentView.bounds) extent=\(layout.collectionViewContentSize)"
      if diagnostic != lastDiagnostic {
        NSLog("[native-panel] %@", diagnostic)
        lastDiagnostic = diagnostic
      }
    }

    if count == 0 {
      footer.stringValue = local("No matching history", "没有匹配的历史记录")
      return
    }
    footer.stringValue =
      local("Native preview · ", "原生预览 · ") + "\(count)\(hasMore ? "+" : "") · "
      + local("resident cards: ", "驻留卡片：") + "\(cards.count) · "
      + local("decoded images: ", "解码图片：")
      + String(format: "%.1f MiB", Double(media.decodedBytes) / 1_048_576)
      + local(
        " · Enter paste · ⌘C copy · Space preview · Esc close",
        " · Enter 粘贴 · ⌘C 复制 · 空格预览 · Esc 关闭")
  }
  private func refreshSelectedPreview() {
    guard let pending = pendingPreviewSelection, pending.index == selected,
      let entry = ref(selected) else { return }
    pendingPreviewSelection = nil
    previews.selection(PanelPreviewItem(hash: entry.hash, itemType: entry.itemType), direction: pending.direction)
  }
  private func select(_ index: Int, scroll shouldScroll: Bool) {
    guard index >= 0, index < count else { return }
    let previous = selected
    selected = index
    if index != previous {
      pendingPreviewSelection = (index, shouldScroll ? (index > previous ? 1 : -1) : 0)
      refreshSelectedPreview()
    }
    for path in list.indexPathsForVisibleItems() {
      (list.item(at: path) as? PanelCardItem)?.cardView.selected = path.item == index
    }
    if shouldScroll {
      let frame =
        layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame ?? .zero
      var point = scroll.contentView.bounds.origin
      if frame.minX < point.x {
        point.x = frame.minX - layout.inset
      } else if frame.maxX > point.x + scroll.contentView.bounds.width {
        point.x = frame.maxX - scroll.contentView.bounds.width + layout.inset
      }
      point.x = max(0, min(point.x, max(0, list.bounds.width - scroll.contentView.bounds.width)))
      scroll.contentView.scroll(to: point)
      scroll.reflectScrolledClipView(scroll.contentView)
    }
    scheduleViewport()
  }
  private func key(_ event: NSEvent) -> Bool {
    if event.keyCode == 48 && event.modifierFlags.contains(.control)
      && !event.modifierFlags.contains(.command) && !event.modifierFlags.contains(.option) {
      let total = PanelFilterQuery.count(tabs: tabs)
      changeFilter((filterIndex + (event.modifierFlags.contains(.shift) ? -1 : 1) + total) % total)
      return true
    }
    if event.modifierFlags.contains(.command) {
      if event.charactersIgnoringModifiers?.lowercased() == "f" {
        toolbar.beginSearch()
        return true
      }
      if event.charactersIgnoringModifiers?.lowercased() == "c" {
        action(event.modifierFlags.contains(.shift) ? "plain" : "copy", at: selected)
        return true
      }
      if event.charactersIgnoringModifiers?.lowercased() == "r" {
        reload()
        return true
      }
    }
    switch event.keyCode {
    case 53:
      dismiss()
      return true
    case 123:
      select(max(0, selected - 1), scroll: true)
      return true
    case 124:
      select(min(count - 1, selected + 1), scroll: true)
      return true
    case 125:
      openContextMenu(at: selected, point: nil)
      return true
    case 36, 76:
      action("paste", at: selected)
      return true
    case 48 where config.tabQuickSelectEnabled:
      select(max(0, min(count - 1, selected + (event.modifierFlags.contains(.shift) ? -1 : 1))), scroll: true)
      return true
    case 49:
      if !event.isARepeat, let entry = ref(selected) {
        previews.toggle(PanelPreviewItem(hash: entry.hash, itemType: entry.itemType))
      }
      return true
    case 51, 117:
      action("delete", at: selected)
      return true
    default: return false
    }
  }
  private func action(_ operation: String, at index: Int) {
    guard !busyAction, let entry = ref(index) else { return }
    let hash = entry.hash
    if operation == "preview" {
      previews.open(PanelPreviewItem(hash: hash, itemType: entry.itemType))
      return
    }
    // Match the WebView: deleting a history record is immediate. Only custom
    // tab and record-tag deletion ask for confirmation there.
    perform(operation, hash: hash, index: index)
  }
  private func perform(_ operation: String, hash: String, index: Int? = nil) {
    busyAction = true
    var args: [String: Any] = ["hash": hash]
    args["plain"] = operation == "plain" || operation == "paste-plain"
    args["favorite"] = !(cards[hash]?.favorite ?? false)
    let op = operation == "plain" ? "copy" : operation == "paste-plain" ? "paste" : operation
    bridge.send(op, args) { [weak self] result in
      guard let self, !self.closed else { return }
      self.busyAction = false
      switch result {
      case .failure(let error): self.showMessage(error.localizedDescription)
      case .success:
        if operation == "delete" {
          if let index {
            self.removeHistoryItem(hash: hash, at: index)
          } else {
            self.reload()
          }
        } else if operation == "favorite" {
          self.reload()
        } else {
          self.showMessage(self.local("Copied to clipboard", "已复制到剪贴板"))
        }
      }
    }
  }

  // MARK: Card context menu (mirrors the WebView menu; see NativePanelContextMenu)

  // Record tags offered by the card menu (last loaded list).
  private var tags: [PanelTag] = []
  // The user's filter tabs and record tags, in their stored order.
  private var tabs: [PanelTab] = []
  private var tabsRequest = 0
  private var pendingTabSelection: String?

  private func openAddTabMenu() {
    guard !closed, !hiding, !busyAction, window.attachedSheet == nil else { return }
    previews.cancelHover()
    let mouse = NSEvent.mouseLocation
    let anchor = PanelContextMenu.editorAnchor(mouse: mouse,
      primaryHeight: NSScreen.screens.first?.frame.maxY ?? 0)
    let handler = PanelTabKindHandler { [weak self] record in
      self?.openTabEditor(record: record, anchor: anchor)
    }
    let menu = PanelContextMenu.tabKindMenu(chinese: chinese, handler: handler)
    // Associate the menu with the elevated panel, as the card context menu does.
    guard let event = NSEvent.mouseEvent(with: .rightMouseDown,
      location: window.convertPoint(fromScreen: mouse), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return }
    withExtendedLifetime(handler) { NSMenu.popUpContextMenu(menu, with: event, for: toolbar) }
  }
  private func openTabEditor(record: Bool, anchor: [CGFloat], assignTo hash: String = "", tabID: String = "") {
    menuRun("tab-editor", ["kind": record ? "record" : "filter", "point": anchor, "hash": hash, "tabId": tabID],
      success: nil, reload: false)
  }

  private func openTabContextMenu(id: String, at mouse: NSPoint) {
    guard !closed, !hiding, !busyAction, window.attachedSheet == nil,
      tabs.contains(where: { $0.id == id }) else { return }
    previews.cancelHover()
    let anchor = PanelContextMenu.editorAnchor(mouse: mouse,
      primaryHeight: NSScreen.screens.first?.frame.maxY ?? 0)
    let handler = PanelTabMenuHandler { [weak self] action in
      guard let self, !self.closed, !self.hiding,
        let tab = self.tabs.first(where: { $0.id == id }) else { return }
      switch action {
      case .edit: self.openTabEditor(record: tab.record, anchor: anchor, tabID: id)
      case .delete: self.confirmDeleteTab(tab)
      }
    }
    let menu = PanelContextMenu.tabMenu(chinese: chinese, handler: handler)
    guard let event = NSEvent.mouseEvent(with: .rightMouseDown,
      location: window.convertPoint(fromScreen: mouse), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return }
    withExtendedLifetime(handler) { NSMenu.popUpContextMenu(menu, with: event, for: toolbar) }
  }

  private func confirmDeleteTab(_ tab: PanelTab) {
    guard !busyAction, window.attachedSheet == nil else { return }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = local("Delete Tab", "删除标签")
    alert.informativeText = tab.record
      ? local("Remove tag “\(tab.name)” from all records? History records will be kept.",
        "从全部记录中删除标签「\(tab.name)」？历史记录保留。")
      : local("Delete “\(tab.name)”? History records will be kept.",
        "删除「\(tab.name)」？历史记录会保留。")
    alert.addButton(withTitle: local("Delete", "删除"))
    alert.addButton(withTitle: local("Cancel", "取消"))
    alert.buttons.first?.hasDestructiveAction = true
    alert.beginSheetModal(for: window) { [weak self] response in
      guard let self, !self.closed, !self.hiding else { return }
      if response == .alertFirstButtonReturn {
        self.menuRun("tab-delete", ["tabId": tab.id], success: nil) { [weak self] in self?.focus() }
      } else { self.focus() }
    }
  }

  private func refreshTabs() {
    tabsRequest &+= 1
    let request = tabsRequest
    bridge.send("tabs") { [weak self] result in
      guard let self, !self.closed, self.tabsRequest == request, case .success(let value) = result,
        let tabs = try? panelDecode([PanelTab].self, value) else { return }
      let selection = self.pendingTabSelection
      self.pendingTabSelection = nil
      self.applyTabs(tabs, selecting: selection)
    }
  }
  private func applyTabs(_ next: [PanelTab], selecting id: String? = nil) {
    guard next != tabs || id != nil else { return }
    let fixed = PanelFilterQuery.fixed
    let active = tabs.indices.contains(filterIndex - fixed) ? tabs[filterIndex - fixed] : nil
    tabs = next
    toolbar.setTabs(next)
    if let id, let index = PanelFilterQuery.index(id: id, tabs: next) {
      changeFilter(index)
      return
    }
    guard let active else { return }
    if let position = next.firstIndex(where: { $0.id == active.id }) {
      filterIndex = fixed + position
      toolbar.setSelection(filterIndex)
      // An edited filter tab keeps its id but queries differently.
      if next[position].label != active.label { changeFilter(filterIndex) }
    } else {
      // Like the WebView, fall back to All when the active tab is gone.
      changeFilter(0)
    }
  }
  private var menuRequest = 0

  // `point` is in the card view's flipped coordinates; nil opens it from the
  // keyboard at the WebView's offset (card left + 14, top + 40).
  private func openContextMenu(at index: Int, point: NSPoint?) {
    guard !busyAction, window.attachedSheet == nil, let entry = ref(index),
      cards[entry.hash] != nil else { return }
    menuRequest &+= 1
    let request = menuRequest
    if point == nil { select(index, scroll: true) }
    previews.cancelHover()
    loadMenuData(hash: entry.hash, color: entry.itemType == "Color") { [weak self] tags, colors in
      guard let self, !self.closed, request == self.menuRequest, self.selected == index,
        self.window.attachedSheet == nil, let card = self.cards[entry.hash],
        let view = (self.list.item(at: IndexPath(item: index, section: 0)) as? PanelCardItem)?
          .cardView
      else { return }
      let handler = PanelMenuHandler { [weak self] action in
        self?.performMenu(action, card: card, index: index)
      }
      let menu = PanelContextMenu.menu(
        PanelContextMenu.options(card: card, tags: tags, colors: colors, chinese: self.chinese),
        handler: handler)
      let scale = CGFloat(self.config.scale)
      // popUp(positioning:) pins the menu's top-left like a pop-up button and
      // scrolls when it does not fit; the docked panel sits at the screen
      // bottom, so use a context-menu popup, which opens upward fully expanded.
      let location = view.convert(point ?? NSPoint(x: 14 * scale, y: 40 * scale), to: nil)
      guard
        let event = NSEvent.mouseEvent(
          with: .rightMouseDown, location: location, modifierFlags: [],
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: self.window.windowNumber,
          context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
      else { return }
      NSMenu.popUpContextMenu(menu, with: event, for: view)
      withExtendedLifetime(handler) {}
    }
  }

  // Like the WebView, a failed tag load falls back to the last list and a
  // failed color lookup shows the unsupported entry.
  private func loadMenuData(
    hash: String, color: Bool, completion: @escaping ([PanelTag], [PanelColorOption]) -> Void
  ) {
    bridge.send("tags") { [weak self] result in
      guard let self, !self.closed else { return }
      if case .success(let value) = result, let tags = try? panelDecode([PanelTag].self, value) {
        self.tags = tags
      }
      let tags = self.tags
      guard color else { return completion(tags, []) }
      self.bridge.send("color-options", ["hash": hash]) { result in
        var colors: [PanelColorOption] = []
        if case .success(let value) = result {
          colors = (try? panelDecode([PanelColorOption].self, value)) ?? []
        }
        completion(tags, colors)
      }
    }
  }

  private func performMenu(_ menuAction: PanelMenuAction, card: PanelCard, index: Int) {
    let hash = card.hash
    switch menuAction {
    case .preview: action("preview", at: index)
    case .editText: action("edit", at: index)
    case .viewImageText: action("ocr", at: index)
    case .toggleFavorite: action("favorite", at: index)
    case .pastePlainText: action("paste-plain", at: index)
    case .delete: action("delete", at: index)
    case .createTag:
      let anchor = PanelContextMenu.editorAnchor(mouse: NSEvent.mouseLocation,
        primaryHeight: NSScreen.screens.first?.frame.maxY ?? 0)
      openTabEditor(record: true, anchor: anchor, assignTo: hash)
    case .assignTag(let tag):
      menuRun("tag-assign", ["hash": hash, "tagId": tag.id],
        success: local("Added tag \(tag.name)", "已添加标签 \(tag.name)"))
    case .removeTag(let tag):
      menuRun("tag-remove", ["hash": hash, "tagIds": [tag.id]],
        success: local("Removed tag \(tag.name)", "已移除标签 \(tag.name)"))
    case .removeAllTags:
      menuRun("tag-remove", ["hash": hash, "tagIds": card.tags.map(\.id)],
        success: local("Removed all record tags", "已移除全部记录标签"))
    case .exportImage:
      PanelMenuSheets.chooseExportTarget(window: window) { [weak self] url in
        self?.menuRun("export-image", ["hash": hash, "target": url.path], success: nil) {
          PanelMenuSheets.rememberExportDirectory(of: url)
        }
      }
    case .openFolder:
      menuRun("open-folder", ["hash": hash], success: nil, reload: false)
    case .copyFolder:
      menuRun("copy-folder", ["hash": hash],
        success: local("Containing folder copied", "所在路径已复制"))
    case .copyColor(let value):
      menuRun("copy-text", ["text": value], success: local("Copied \(value)", "已复制 \(value)"))
    }
  }

  private func menuRun(
    _ op: String, _ args: [String: Any], success: String?, reload: Bool = true,
    completed: (() -> Void)? = nil
  ) {
    guard !busyAction else { return }
    busyAction = true
    bridge.send(op, args) { [weak self] result in
      guard let self, !self.closed else {
        if case .success = result { completed?() }
        return
      }
      self.busyAction = false
      switch result {
      case .failure(let error):
        self.showMessage(
          self.local("Action failed: \(error.localizedDescription)",
            "操作失败：\(error.localizedDescription)"))
      case .success:
        completed?()
        if reload { self.reload() }
        if let success { self.showMessage(success) }
      }
    }
  }
}

@MainActor private var panelController: NativePanelController?
@_cdecl("vpaste_native_panel_show")
public func vpasteNativePanelShow(
  _ callbacks: UnsafePointer<VPastePanelCallbacks>, _ bytes: UnsafePointer<UInt8>, _ length: Int
) {
  let data = Data(bytes: bytes, count: length)
  let table = callbacks.pointee
  guard table.abi_version == 1,
    let config = try? JSONDecoder().decode(PanelConfiguration.self, from: data)
  else { return }
  MainActor.assumeIsolated {
    panelController?.dismiss(animated: false)
    let controller = NativePanelController(callbacks: table, config: config)
    panelController = controller
    controller.present()
  }
}
@_cdecl("vpaste_native_panel_receive")
public func vpasteNativePanelReceive(_ bytes: UnsafePointer<UInt8>, _ length: Int) {
  guard
    let value = try? JSONSerialization.jsonObject(with: Data(bytes: bytes, count: length))
      as? [String: Any]
  else { return }
  MainActor.assumeIsolated { panelController?.bridge.receive(value) }
}
@_cdecl("vpaste_native_panel_close")
public func vpasteNativePanelClose(_ animated: Bool) {
  MainActor.assumeIsolated { panelController?.dismiss(animated: animated) }
}
@_cdecl("vpaste_native_panel_activate")
public func vpasteNativePanelActivate(_ toggle: Bool) -> Bool {
  MainActor.assumeIsolated { panelController?.activate(toggle: toggle) ?? false }
}
