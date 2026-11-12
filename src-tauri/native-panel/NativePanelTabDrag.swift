import AppKit

struct PanelTabDragFrame {
  let id: String
  let frame: NSRect
}
struct PanelTabDrop {
  let id: String
  let before: Bool
  let x: CGFloat
}
enum PanelTabDragLayout {
  static func target(x: CGFloat, source: String, tabs: [PanelTabDragFrame]) -> PanelTabDrop? {
    guard tabs.contains(where: { $0.id == source }), let first = tabs.first,
      x >= first.frame.minX else { return nil }
    let others = tabs.filter { $0.id != source }
    if let next = others.first(where: { x < $0.frame.midX }) {
      return PanelTabDrop(id: next.id, before: true, x: next.frame.minX)
    }
    return others.last.map { PanelTabDrop(id: $0.id, before: false, x: $0.frame.maxX) }
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
  var tabFrames: (() -> [PanelTabDragFrame])?
  var onMove: ((String, String, Bool) -> Void)?
  var onDragChanged: ((String?) -> Void)?
  var scale: CGFloat = 1
  private let pan = PanelTabPan()
  private let marker = CALayer()
  private var source: String?
  private var pending: PanelTabDrop?
  private var timer: Timer?
  private var closed = false
  override var acceptsFirstResponder: Bool { false }
  override var canBecomeKeyView: Bool { false }
  override var isFlipped: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    marker.isHidden = true
    layer?.addSublayer(marker)
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
    guard !closed, source == nil, let down = pan.down, !down.modifierFlags.contains(.control),
      let tabs = tabFrames?(), tabs.count > 1 else { return false }
    let point = convert(down.locationInWindow, from: nil)
    return tabs.contains { $0.frame.contains(point) }
  }
  @objc private func startDrag(_ gesture: NSPanGestureRecognizer) {
    guard gesture.state == .began, !closed, source == nil, let down = pan.down,
      let tab = tabFrames?().first(where: { $0.frame.contains(convert(down.locationInWindow, from: nil)) })
    else { return }
    let image = NSImage(size: tab.frame.size)
    if let rep = bitmapImageRepForCachingDisplay(in: tab.frame) {
      cacheDisplay(in: tab.frame, to: rep)
      image.addRepresentation(rep)
    }
    let payload = NSPasteboardItem()
    payload.setString(tab.id, forType: Self.type)
    let item = NSDraggingItem(pasteboardWriter: payload)
    item.setDraggingFrame(tab.frame, contents: image)
    source = tab.id
    onDragChanged?(tab.id)
    NSCursor.closedHand.set()
    beginDraggingSession(with: [item], event: down, source: self)
      .animatesToStartingPositionsOnCancelOrFail = true
  }
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    !closed && context == .withinApplication ? .move : []
  }
  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    let move = operation == .move ? pending : nil
    let id = source
    finish()
    if !closed, let move, let id { onMove?(id, move.id, move.before) }
  }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggingUpdated(sender) }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
    guard !closed, let owner = sender.draggingSource as? PanelTabDragSurface, owner === self,
      let source, sender.draggingPasteboard.string(forType: Self.type) == source else { return [] }
    updateTarget(convert(sender.draggingLocation, from: nil))
    return pending == nil ? [] : .move
  }
  override func draggingExited(_ sender: NSDraggingInfo?) { clearTarget() }
  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { draggingUpdated(sender) == .move }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { draggingUpdated(sender) == .move }

  private func updateTarget(_ point: NSPoint) {
    guard let source, visibleRect.contains(point), let frames = tabFrames?() else {
      clearTarget(); return
    }
    pending = PanelTabDragLayout.target(x: point.x, source: source, tabs: frames)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    marker.isHidden = pending == nil
    if let pending {
      marker.backgroundColor = PanelStyle.accent(self).cgColor
      marker.frame = NSRect(x: pending.x - scale, y: 8 * scale,
        width: 2 * scale, height: max(0, bounds.height - 16 * scale))
    }
    CATransaction.commit()
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
  private func clearTarget() { stopTimer(); pending = nil; marker.isHidden = true }
  private func finish() {
    let wasDragging = source != nil
    clearTarget()
    source = nil
    if wasDragging { onDragChanged?(nil) }
    window?.invalidateCursorRects(for: self)
    if let window, window.isKeyWindow,
      visibleRect.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil)) {
      NSCursor.pointingHand.set()
    }
  }
  func releaseContent() {
    guard !closed else { return }
    closed = true
    finish()
    unregisterDraggedTypes()
    removeGestureRecognizer(pan)
    tabFrames = nil
    onMove = nil
    onDragChanged = nil
  }
}
