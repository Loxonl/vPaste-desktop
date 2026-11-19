import AppKit

struct PanelTabDragFrame {
  let id: String
  let frame: NSRect
}
struct PanelTabDrop: Equatable {
  let id: String
  let before: Bool
  let slot: Int
}

// Completion settles the preview if the authoritative tabs did not replace it.
typealias PanelTabMoveHandler = (String, String, Bool, @escaping () -> Void) -> Void

enum PanelTabDragLayout {
  static func target(x: CGFloat, source: String, tabs: [PanelTabDragFrame]) -> PanelTabDrop? {
    guard let original = tabs.firstIndex(where: { $0.id == source }),
      x >= tabs[0].frame.minX else { return nil }
    let others = tabs.filter { $0.id != source }
    let slot = others.firstIndex(where: { x < $0.frame.midX }) ?? others.count
    guard slot != original else { return nil }
    if slot < others.count { return PanelTabDrop(id: others[slot].id, before: true, slot: slot) }
    return others.last.map { PanelTabDrop(id: $0.id, before: false, slot: slot) }
  }
  static func offsets(source: String, drop: PanelTabDrop?, tabs: [PanelTabDragFrame]) -> [CGFloat] {
    var offsets = [CGFloat](repeating: 0, count: tabs.count)
    guard let drop, tabs.count > 1, tabs.indices.contains(drop.slot),
      let original = tabs.firstIndex(where: { $0.id == source }) else { return offsets }
    var order = Array(tabs.indices)
    order.remove(at: original)
    order.insert(original, at: drop.slot)
    let gap = tabs[1].frame.minX - tabs[0].frame.maxX
    var x = tabs[0].frame.minX
    for index in order {
      offsets[index] = x - tabs[index].frame.minX
      x += tabs[index].frame.width + gap
    }
    return offsets
  }
  static func scrollStep(x: CGFloat, visible: NSRect, scale: CGFloat) -> CGFloat {
    guard x >= visible.minX, x <= visible.maxX else { return 0 }
    let edge = min(24 * scale, visible.width / 2)
    guard edge > 0 else { return 0 }
    if x < visible.minX + edge { return -4 * scale * (1 - (x - visible.minX) / edge) }
    if x > visible.maxX - edge { return 4 * scale * (1 - (visible.maxX - x) / edge) }
    return 0
  }
}

@MainActor
private final class PanelTabPan: NSPanGestureRecognizer {
  private(set) var down: NSEvent?
  override func mouseDown(with event: NSEvent) {
    down = event
    super.mouseDown(with: event)
  }
  override func reset() { super.reset(); down = nil }
}

// Shared document surface for the SwiftUI row and macOS 11 button strip.
// Only this surface's private dragging pasteboard is accepted; no clipboard
// payload is fetched, and no data is written to the general pasteboard.
@MainActor
final class PanelTabDragSurface: NSView, NSDraggingSource, NSGestureRecognizerDelegate {
  private static let type = NSPasteboard.PasteboardType("com.loxonl.vpaste.toolbar-tab")
  var tabViews: (() -> [(id: String, view: NSView)])?
  var tabFrames: [PanelTabDragFrame] {
    tabViews?().map { PanelTabDragFrame(id: $0.id, frame: convert($0.view.bounds, from: $0.view)) } ?? []
  }
  var onMove: PanelTabMoveHandler?
  var onDragChanged: ((String?) -> Void)?
  var scale: CGFloat = 1
  var interactionEnabled = true {
    didSet {
      guard oldValue != interactionEnabled else { return }
      pan.isEnabled = interactionEnabled
      if !interactionEnabled { cancelInteraction() }
    }
  }
  private let pan = PanelTabPan()
  private struct Snapshot {
    let tab: PanelTabDragFrame
    let view: NSView
    let origin: NSPoint
  }
  private var snapshot: [Snapshot] = []
  private var source: Int?
  private var pending: PanelTabDrop?
  private var saving = false
  private var generation = 0
  var isReordering: Bool { source != nil }
  private var timer: Timer?
  private var closed = false
  override var acceptsFirstResponder: Bool { false }
  override var canBecomeKeyView: Bool { false }
  override var isFlipped: Bool { true }
  // The glass mask affects drawing only. Input still ends at the scroll viewport.
  override var visibleRect: NSRect {
    let visible = super.visibleRect
    guard let scroll = enclosingScrollView else { return visible }
    return visible.intersection(scroll.documentVisibleRect)
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard visibleRect.contains(convert(point, from: superview)) else { return nil }
    return super.hitTest(point)
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    pan.target = self
    pan.action = #selector(startDrag(_:))
    pan.buttonMask = 1
    pan.delaysPrimaryMouseButtonEvents = true
    pan.delegate = self
    addGestureRecognizer(pan)
    registerForDraggedTypes([Self.type])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  // Buttons wait for the drag to fail; releasing without motion still clicks.
  func gestureRecognizer(_ gestureRecognizer: NSGestureRecognizer,
    shouldBeRequiredToFailBy otherGestureRecognizer: NSGestureRecognizer) -> Bool {
    otherGestureRecognizer.view?.isDescendant(of: self) == true
  }
  func gestureRecognizerShouldBegin(_ gestureRecognizer: NSGestureRecognizer) -> Bool {
    guard interactionEnabled, !closed, !isReordering, let down = pan.down,
      !down.modifierFlags.contains(.control) else { return false }
    let point = convert(down.locationInWindow, from: nil)
    let tabs = tabFrames
    return tabs.count > 1 && tabs.contains { $0.frame.contains(point) }
  }
  @objc private func startDrag(_ gesture: NSPanGestureRecognizer) {
    guard gesture.state == .began, let down = pan.down,
      let item = beginPreview(at: convert(down.locationInWindow, from: nil)) else { return }
    NSCursor.closedHand.set()
    beginDraggingSession(with: [item], event: down, source: self)
      .animatesToStartingPositionsOnCancelOrFail = false
  }
  func beginPreview(at point: NSPoint) -> NSDraggingItem? {
    guard interactionEnabled, !closed, !isReordering, visibleRect.contains(point),
      let views = tabViews?(), views.count > 1 else { return nil }
    let initial = views.map { tab in
      Snapshot(tab: PanelTabDragFrame(id: tab.id, frame: convert(tab.view.bounds, from: tab.view)),
        view: tab.view, origin: tab.view.frame.origin)
    }
    guard let index = initial.firstIndex(where: { $0.tab.frame.contains(point) }) else { return nil }
    let tab = initial[index].tab
    guard let button = initial[index].view as? NSButton,
      let preview = Self.textPreview(for: button) else { return nil }
    let payload = NSPasteboardItem()
    payload.setString(tab.id, forType: Self.type)
    let item = NSDraggingItem(pasteboardWriter: payload)
    item.setDraggingFrame(button.convert(preview.frame, to: self), contents: preview.image)
    generation &+= 1
    snapshot = initial
    source = index
    initial[index].view.alphaValue = 0
    onDragChanged?(tab.id)
    return item
  }
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    !closed && context == .withinApplication ? .move : []
  }
  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    endPreview(accepting: operation == .move)
  }
  func endPreview(accepting: Bool) {
    guard let source, !saving else { return }
    guard accepting, let move = pending, let onMove else { finish(animated: true); return }
    stopTimer()
    saving = true
    snapshot[source].view.alphaValue = 1
    let request = generation
    onMove(snapshot[source].tab.id, move.id, move.before) { [weak self] in
      guard let self, self.generation == request else { return }
      self.finish(animated: true)
    }
  }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggingUpdated(sender) }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
    guard interactionEnabled, !closed, !saving,
      let owner = sender.draggingSource as? PanelTabDragSurface, owner === self, let source,
      sender.draggingPasteboard.string(forType: Self.type) == snapshot[source].tab.id else { return [] }
    updateTarget(convert(sender.draggingLocation, from: nil))
    return pending == nil ? [] : .move
  }
  override func draggingExited(_ sender: NSDraggingInfo?) {
    if !saving { clearTarget() }
  }
  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard draggingUpdated(sender) == .move else { return false }
    sender.animatesToDestination = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    return true
  }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard draggingUpdated(sender) == .move, let source else { return false }
    guard let button = snapshot[source].view as? NSButton,
      let preview = Self.textPreview(for: button) else { return false }
    let destination = button.convert(preview.frame, to: self)
    if sender.animatesToDestination {
      sender.enumerateDraggingItems(options: [], for: self, classes: [NSPasteboardItem.self], searchOptions: [:]) {
        item, _, _ in item.draggingFrame = destination
      }
    }
    return true
  }

  static func textPreview(for button: NSButton) -> (frame: NSRect, image: NSImage)? {
    let title = button.attributedTitle
    guard !title.string.isEmpty else { return nil }
    let measured = title.boundingRect(
      with: NSSize(width: .greatestFiniteMagnitude, height: button.bounds.height),
      options: [.usesLineFragmentOrigin, .usesFontLeading]
    )
    let inset: CGFloat = 2
    let size = NSSize(
      width: ceil(measured.width) + inset * 2,
      height: ceil(measured.height) + inset * 2
    )
    guard size.width < button.bounds.width, size.height < button.bounds.height else { return nil }
    let image = NSImage(size: size)
    image.lockFocus()
    title.draw(in: NSRect(
      x: inset, y: inset, width: size.width - inset * 2, height: size.height - inset * 2
    ))
    image.unlockFocus()
    let frame = NSRect(
      x: (button.bounds.width - size.width) / 2,
      y: (button.bounds.height - size.height) / 2,
      width: size.width,
      height: size.height
    )
    return (frame, image)
  }

  func updateTarget(_ point: NSPoint) {
    guard !saving, let source else { return }
    guard visibleRect.contains(point) else { clearTarget(); return }
    let drop = PanelTabDragLayout.target(x: point.x, source: snapshot[source].tab.id, tabs: snapshot.map(\.tab))
    if pending != drop {
      pending = drop
      placeTabs(source: source, drop: drop)
    }
    if PanelTabDragLayout.scrollStep(x: point.x, visible: visibleRect, scale: scale) != 0 {
      if timer == nil {
        let work = Timer(timeInterval: 1 / 60, repeats: true) { [weak self] _ in
          MainActor.assumeIsolated { self?.scrollAtEdge() }
        }
        timer = work
        RunLoop.main.add(work, forMode: .common)
      }
    } else { stopTimer() }
  }
  private func placeTabs(source: Int, drop: PanelTabDrop?, animated: Bool = true) {
    let offsets = PanelTabDragLayout.offsets(source: snapshot[source].tab.id, drop: drop, tabs: snapshot.map(\.tab))
    let shouldAnimate = animated && window?.isVisible == true
      && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    for (index, entry) in snapshot.enumerated() {
      guard let parent = entry.view.superview else { continue }
      let dx = parent.convert(NSPoint(x: offsets[index], y: 0), from: self).x
        - parent.convert(.zero, from: self).x
      let destination = NSPoint(x: entry.origin.x + dx, y: entry.origin.y)
      guard entry.view.frame.origin != destination else { continue }
      if shouldAnimate {
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.15
          context.timingFunction = CAMediaTimingFunction(name: .easeOut)
          entry.view.animator().setFrameOrigin(destination)
        }
      } else {
        entry.view.setFrameOrigin(destination)
      }
    }
  }
  private func scrollAtEdge() {
    guard !closed, source != nil, let window, let scroll = enclosingScrollView else { clearTarget(); return }
    let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
    let step = PanelTabDragLayout.scrollStep(x: point.x, visible: visibleRect, scale: scale)
    guard visibleRect.contains(point), step != 0 else { stopTimer(); return }
    let old = scroll.contentView.bounds.origin
    let x = max(0, min(bounds.width - scroll.contentView.bounds.width, old.x + step))
    scroll.contentView.scroll(to: NSPoint(x: x, y: old.y))
    scroll.reflectScrolledClipView(scroll.contentView)
    updateTarget(convert(window.mouseLocationOutsideOfEventStream, from: nil))
  }
  private func stopTimer() { timer?.invalidate(); timer = nil }
  private func clearTarget() {
    stopTimer()
    guard pending != nil, let source else { return }
    pending = nil
    placeTabs(source: source, drop: nil)
  }
  private func finish(replacingTabs: Bool = false, animated: Bool = false) {
    stopTimer()
    guard let source else { return }
    if !replacingTabs { placeTabs(source: source, drop: nil, animated: animated) }
    snapshot[source].view.alphaValue = 1
    self.source = nil
    snapshot = []
    pending = nil
    saving = false
    onDragChanged?(nil)
    window?.invalidateCursorRects(for: self)
    if let window, window.isKeyWindow,
      visibleRect.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil)) {
      NSCursor.pointingHand.set()
    }
  }
  func cancelInteraction(replacingTabs: Bool = false) { finish(replacingTabs: replacingTabs) }
  func releaseContent() {
    guard !closed else { return }
    closed = true
    finish()
    unregisterDraggedTypes()
    removeGestureRecognizer(pan)
    tabViews = nil
    onMove = nil
    onDragChanged = nil
  }
}
