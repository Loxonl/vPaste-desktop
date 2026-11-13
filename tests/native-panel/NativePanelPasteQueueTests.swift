import AppKit
import XCTest

@MainActor
final class NativePanelPasteQueueTests: XCTestCase {
  func testQueueIndicatorIgnoresAnOlderInitialSnapshotAfterAnEvent() throws {
    var indicator = PanelPasteQueueIndicator()
    XCTAssertTrue(indicator.apply(active: true, revision: 12))
    XCTAssertFalse(indicator.apply(active: false, revision: 11))
    XCTAssertTrue(indicator.active)
    XCTAssertTrue(indicator.apply(active: false, revision: 13))
    XCTAssertFalse(indicator.active)
    XCTAssertTrue(indicator.apply(active: true, revision: 14))
    XCTAssertTrue(indicator.active)
  }

  func testPendingQueueSelectionRejectsOlderRepliesAndKeepsClickOrder() {
    var state = PanelPasteQueueIndicator()
    let first = PanelPasteQueueStatus(active: true, revision: 10, activationEpoch: 3,
      selectedHashes: ["b", "a"], selectionRevision: 4, selectionBusy: false)
    XCTAssertTrue(state.apply(first))
    XCTAssertEqual(state.selectedHashes, ["b", "a"])
    XCTAssertFalse(state.apply(PanelPasteQueueStatus(active: true, revision: 10, activationEpoch: 3,
      selectedHashes: ["b"], selectionRevision: 3, selectionBusy: false)))
    XCTAssertEqual(state.selectedHashes, ["b", "a"])
    XCTAssertTrue(state.apply(PanelPasteQueueStatus(active: false, revision: 11, activationEpoch: 4,
      selectedHashes: [], selectionRevision: 5, selectionBusy: false)))
    XCTAssertTrue(state.selectedHashes.isEmpty)
    XCTAssertFalse(state.active)
  }

  func testQueueFailureSurvivesUnrelatedStatusUpdatesUntilTheNextUserAction() {
    var state = PanelPasteQueueIndicator()
    let selected = PanelPasteQueueStatus(active: true, revision: 5, activationEpoch: 1,
      selectedHashes: ["a"], selectionRevision: 2, selectionBusy: false)
    XCTAssertTrue(state.apply(selected))
    state.reportError("Queue is full")
    XCTAssertTrue(state.apply(selected))
    XCTAssertEqual(state.error, "Queue is full")
    state.clearError()
    XCTAssertNil(state.error)
    state.reportError("Queue is full")
    XCTAssertTrue(state.apply(PanelPasteQueueStatus(active: false, revision: 6, activationEpoch: 2,
      selectedHashes: [], selectionRevision: 3, selectionBusy: false)))
    XCTAssertNil(state.error)
  }

  func testQueueFooterShowsCountDisablesDuplicateSubmissionAndReleasesAction() throws {
    let bar = PanelPasteQueueBar(scale: 0.8, chinese: false)
    var calls = 0
    bar.onAdd = { calls += 1 }
    bar.update(count: 2, busy: false)
    let button = try XCTUnwrap(descendants(of: bar).compactMap { $0 as? NSButton }.first)
    XCTAssertEqual(button.title, "Add 2 items")
    XCTAssertFalse(button.acceptsFirstResponder)
    button.performClick(nil)
    XCTAssertEqual(calls, 1)
    bar.update(count: 2, busy: true)
    XCTAssertFalse(button.isEnabled)
    bar.update(count: 0, busy: false)
    XCTAssertFalse(button.isEnabled)
    bar.releaseContent()
    XCTAssertNil(bar.onAdd)
  }

  func testQueueFooterFitsNativeControlsAsCountsAndPanelScaleChange() throws {
    for chinese in [false, true] {
      for scale: CGFloat in [0.8, 0.9, 1] {
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 120))
        let bar = PanelPasteQueueBar(scale: scale, chinese: chinese)
        bar.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(bar)
        NSLayoutConstraint.activate([
          bar.centerXAnchor.constraint(equalTo: host.centerXAnchor),
          bar.centerYAnchor.constraint(equalTo: host.centerYAnchor),
        ])
        var firstWidth: CGFloat = 0
        for count in [0, 7, 100, 12345] {
          bar.update(count: count, busy: false)
          host.layoutSubtreeIfNeeded()
          bar.layoutSubtreeIfNeeded()
          let views = descendants(of: bar)
          let button = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first)
          for control in views.compactMap({ $0 as? NSControl }) {
            XCTAssertGreaterThanOrEqual(control.bounds.width + 0.5, control.fittingSize.width)
            let rect = control.convert(control.bounds, to: bar)
            XCTAssertGreaterThanOrEqual(rect.minX, 8 * scale)
            XCTAssertLessThanOrEqual(rect.maxX, bar.bounds.width - 8 * scale)
          }
          XCTAssertGreaterThanOrEqual(button.bounds.height + 0.5, button.fittingSize.height)
          XCTAssertEqual(bar.frame.midX, host.bounds.midX, accuracy: 0.5)
          XCTAssertLessThanOrEqual(bar.frame.maxX, host.bounds.maxX)
          if count == 0 { firstWidth = bar.frame.width }
          if count == 12345 { XCTAssertGreaterThan(bar.frame.width, firstWidth) }
        }
      }
    }
  }

  private func descendants(of view: NSView) -> [NSView] {
    view.subviews.flatMap { [$0] + descendants(of: $0) }
  }

  func testQueueCardClickCannotPasteAndExternalDragDoesNotStart() throws {
    let view = PanelCardView(frame: NSRect(x: 0, y: 0, width: 220, height: 230))
    view.queueSelectionMode = true
    view.singleClick = false
    var activations = 0
    var drags = 0
    view.activate = { activations += 1 }
    view.prepareDrag = { _ in drags += 1 }
    let down = try XCTUnwrap(NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 20, y: 20),
      modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    let move = try XCTUnwrap(NSEvent.mouseEvent(with: .leftMouseDragged, location: NSPoint(x: 50, y: 20),
      modifierFlags: [], timestamp: 0.1, windowNumber: 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    let up = try XCTUnwrap(NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: 20, y: 20),
      modifierFlags: [], timestamp: 0.2, windowNumber: 0, context: nil, eventNumber: 2, clickCount: 1, pressure: 0))
    view.mouseDown(with: down)
    view.mouseDragged(with: move)
    view.mouseUp(with: up)
    XCTAssertEqual(drags, 0)
    XCTAssertEqual(activations, 0, "Dragging to scroll must not toggle a card")
    view.mouseDown(with: down)
    view.mouseUp(with: up)
    XCTAssertEqual(activations, 1, "Queue selection must ignore the ordinary double-click preference")
    view.selected = true
    XCTAssertTrue(view.queueCheckVisible)
    view.selected = false
    XCTAssertFalse(view.queueCheckVisible)
    view.releaseContent()
    XCTAssertFalse(view.queueCheckVisible)
  }

  func testToolbarForwardsQueueActionAndReleasesItOnClose() throws {
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1080, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    let content = try XCTUnwrap(toolbar.subviews.first as? PanelToolbarContent)
    var calls = 0
    toolbar.onPasteQueue = { calls += 1 }
    content.onPasteQueue?()
    XCTAssertEqual(calls, 1)
    toolbar.setQueueActive(true)
    toolbar.releaseContent()
    content.onPasteQueue?()
    XCTAssertEqual(calls, 1)
    XCTAssertNil(toolbar.onPasteQueue)
  }

  @available(macOS 12.0, *)
  func testSwiftUIQueueIndicatorDoesNotChangeSelectionAndReleasesAction() {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    state.selected = 1
    var calls = 0
    state.onPasteQueue = { calls += 1 }
    state.queueActive = true
    XCTAssertEqual(state.selected, 1)
    state.onPasteQueue?()
    XCTAssertEqual(calls, 1)
    state.close()
    state.onPasteQueue?()
    XCTAssertEqual(calls, 1)
  }

  func testAppKitQueueButtonTracksStateAndDoesNotOverlapSettings() throws {
    for scale: CGFloat in [0.8, 0.9, 1] {
      let toolbar = PanelLegacyToolbar(frame: NSRect(x: 0, y: 0, width: 1080, height: 48 * scale))
      toolbar.configure(scale: scale, chinese: false, search: NSSearchField())
      toolbar.layoutSubtreeIfNeeded()
      let queue = try XCTUnwrap(toolbar.subviews.compactMap { $0 as? PanelIconButton }
        .first { $0.accessibilityLabel() == "Open paste queue" })
      let settings = try XCTUnwrap(toolbar.subviews.compactMap { $0 as? PanelIconButton }
        .first { $0.accessibilityLabel() == "Settings" })
      XCTAssertLessThanOrEqual(queue.frame.maxX, settings.frame.minX)
      XCTAssertFalse(queue.acceptsFirstResponder)
      var calls = 0
      toolbar.onPasteQueue = { calls += 1 }
      queue.performClick(nil)
      XCTAssertEqual(calls, 1)
      toolbar.setQueueActive(true)
      XCTAssertTrue(queue.active)
      XCTAssertEqual(queue.accessibilityLabel(), "Close paste queue")
      toolbar.setQueueActive(false)
      XCTAssertFalse(queue.active)
      toolbar.releaseContent()
      queue.performClick(nil)
      XCTAssertEqual(calls, 1)
    }
  }
}
