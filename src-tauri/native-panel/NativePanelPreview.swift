import AppKit

// A floating NSPanel can keep its key-window identity while its application
// deactivates. Forward both app transitions, and release the observers on close.
@MainActor
final class PanelApplicationFocus {
  private let center: NotificationCenter
  private var observers: [NSObjectProtocol] = []
  init(center: NotificationCenter = .default, changed: @escaping (Bool) -> Void) {
    self.center = center
    for (name, active) in [(NSApplication.didBecomeActiveNotification, true),
      (NSApplication.didResignActiveNotification, false)] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { changed(active) }
      })
    }
  }
  func close() {
    for observer in observers { center.removeObserver(observer) }
    observers.removeAll()
  }
}

struct PanelPreviewItem: Equatable {
  let hash: String
  let itemType: String
}

// Match clipboardHoverPreview.ts. Only small identities and cancellable delays
// live here; the shared Rust/React preview still owns content and window motion.
@MainActor
final class PanelPreviewDriver {
  var hoverEnabled: Bool { didSet { if !hoverEnabled { cancelHover() } } }
  private var send: ((String, [String: Any]) -> Void)?
  private let schedule: (TimeInterval, DispatchWorkItem) -> Void
  private var hoverWork: DispatchWorkItem?
  private var leaveWork: DispatchWorkItem?
  private var hovered: PanelPreviewItem?
  private var hovering = false
  private var insidePreview = false
  private var generation: UInt64 = 0
  private var request: UInt64 = 0
  private var closed = false

  init(hoverEnabled: Bool, send: @escaping (String, [String: Any]) -> Void,
    schedule: @escaping (TimeInterval, DispatchWorkItem) -> Void = {
      DispatchQueue.main.asyncAfter(deadline: .now() + $0, execute: $1)
    }) {
    self.hoverEnabled = hoverEnabled
    self.send = send
    self.schedule = schedule
  }
  private func nextRequest() -> UInt64 {
    request = max(request &+ 1, UInt64(Date().timeIntervalSince1970 * 1_000_000))
    return request
  }
  private func arguments(_ item: PanelPreviewItem, mode: String, direction: Int = 0) -> [String: Any] {
    ["hash": item.hash, "itemType": item.itemType, "mode": mode,
      "navigationDirection": min(1, max(-1, direction))]
  }
  func open(_ item: PanelPreviewItem) {
    guard !closed else { return }
    cancelHover()
    send?("preview", arguments(item, mode: "manual"))
  }
  func toggle(_ item: PanelPreviewItem) {
    guard !closed else { return }
    cancelHover()
    send?("preview-toggle", arguments(item, mode: "manual"))
  }
  func selection(_ item: PanelPreviewItem, direction: Int) {
    guard !closed else { return }
    cancelHover()
    send?("preview", arguments(item, mode: "selection", direction: direction))
  }
  func enter(_ item: PanelPreviewItem) {
    guard !closed, hoverEnabled, ["Text", "TextFile", "Image", "Link"].contains(item.itemType) else {
      cancelHover()
      return
    }
    leaveWork?.cancel()
    leaveWork = nil
    guard hovered != item else { return }
    hoverWork?.cancel()
    generation &+= 1
    let version = generation
    let hoverRequest = nextRequest()
    hovered = item
    hovering = true
    insidePreview = false
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.closed, self.hoverEnabled,
        self.generation == version, self.hovered == item else { return }
      self.hoverWork = nil
      var args = self.arguments(item, mode: "hover")
      args["hoverRequest"] = hoverRequest
      self.send?("preview", args)
    }
    hoverWork = work
    schedule(0.5, work)
  }
  func leave(_ item: PanelPreviewItem? = nil) {
    guard !closed, hovering else { return }
    if let item, hovered != item { return }
    hovered = nil
    hoverWork?.cancel()
    hoverWork = nil
    leaveWork?.cancel()
    let version = generation
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.closed, self.generation == version, !self.insidePreview else { return }
      self.cancelHover()
    }
    leaveWork = work
    schedule(0.25, work)
  }
  func pointerInPreview(_ inside: Bool) {
    guard !closed, hovering else { return }
    insidePreview = inside
    if inside {
      leaveWork?.cancel()
      leaveWork = nil
    } else { leave() }
  }
  func cancelHover() {
    guard hovering || hoverWork != nil || leaveWork != nil else { return }
    generation &+= 1
    hoverWork?.cancel()
    leaveWork?.cancel()
    hoverWork = nil
    leaveWork = nil
    hovered = nil
    hovering = false
    insidePreview = false
    if !closed { send?("hover-dismiss", ["hoverRequest": nextRequest()]) }
  }
  func clear() {
    guard !closed else { return }
    cancelHover()
    send?("preview-close", [:])
  }
  func close() {
    closed = true
    cancelHover()
    send = nil
  }
}
