import AppKit
import XCTest

@MainActor
final class NativePanelTabDragTests: XCTestCase {
  private let tabs = [
    PanelTabDragFrame(id: "tab-a", frame: NSRect(x: 180, y: 0, width: 80, height: 48)),
    PanelTabDragFrame(id: "record:9", frame: NSRect(x: 268, y: 0, width: 80, height: 48)),
    PanelTabDragFrame(id: "tab-b", frame: NSRect(x: 356, y: 0, width: 80, height: 48)),
  ]
  func testDropUsesTheTargetsLeftOrRightSideAndRejectsTheFixedRegion() throws {
    XCTAssertNil(PanelTabDragLayout.target(x: 100, source: "tab-a", tabs: tabs))
    XCTAssertNil(PanelTabDragLayout.target(x: 380, source: "gone", tabs: tabs))
    let before = try XCTUnwrap(PanelTabDragLayout.target(x: 380, source: "tab-a", tabs: tabs))
    XCTAssertEqual(before.id, "tab-b")
    XCTAssertTrue(before.before)
    let after = try XCTUnwrap(PanelTabDragLayout.target(x: 425, source: "tab-a", tabs: tabs))
    XCTAssertEqual(after.id, "tab-b")
    XCTAssertFalse(after.before)
    let first = try XCTUnwrap(PanelTabDragLayout.target(x: 185, source: "tab-b", tabs: tabs))
    XCTAssertEqual(first.id, "tab-a")
    XCTAssertTrue(first.before)
  }
  func testDraggingOverTheOriginalSlotDoesNotRequestAMove() {
    XCTAssertNil(PanelTabDragLayout.target(x: 300, source: "record:9", tabs: tabs))
  }
  func testUnequalWidthTabsMakeRoomWithoutChangingTheOuterEdges() throws {
    for scale: CGFloat in [0.8, 0.9, 1] {
      let mixed = [
        PanelTabDragFrame(id: "a", frame: NSRect(x: 40 * scale, y: 0, width: 50 * scale, height: 48 * scale)),
        PanelTabDragFrame(id: "record", frame: NSRect(x: 98 * scale, y: 0, width: 120 * scale, height: 48 * scale)),
        PanelTabDragFrame(id: "b", frame: NSRect(x: 226 * scale, y: 0, width: 70 * scale, height: 48 * scale)),
      ]
      let right = try XCTUnwrap(PanelTabDragLayout.target(x: 270 * scale, source: "a", tabs: mixed))
      let left = try XCTUnwrap(PanelTabDragLayout.target(x: 150 * scale, source: "b", tabs: mixed))
      for (drop, source, expected) in [(right, "a", [206.0, -58, -58]), (left, "b", [0.0, 78, -128])] {
        let offsets = PanelTabDragLayout.offsets(source: source, drop: drop, tabs: mixed)
        for (offset, value) in zip(offsets, expected) { XCTAssertEqual(offset, value * scale, accuracy: 0.001) }
        let moved = zip(mixed, offsets).map { $0.frame.offsetBy(dx: $1, dy: 0) }
        XCTAssertEqual(try XCTUnwrap(moved.map(\.minX).min()), mixed[0].frame.minX, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(moved.map(\.maxX).max()), mixed[2].frame.maxX, accuracy: 0.001)
      }
    }
  }
  func testEdgeScrollingStopsOutsideTheViewportAndInItsCenter() {
    let viewport = NSRect(x: 100, y: 0, width: 400, height: 48)
    XCTAssertLessThan(PanelTabDragLayout.scrollStep(x: 101, visible: viewport, scale: 1), 0)
    XCTAssertGreaterThan(PanelTabDragLayout.scrollStep(x: 499, visible: viewport, scale: 1), 0)
    XCTAssertEqual(PanelTabDragLayout.scrollStep(x: 300, visible: viewport, scale: 1), 0)
    XCTAssertEqual(PanelTabDragLayout.scrollStep(x: 50, visible: viewport, scale: 1), 0)
  }
  func testNativeButtonsPreviewTheDropAndWaitForTheSavedOrder() throws {
    let surface = PanelTabDragSurface(frame: NSRect(x: 0, y: 0, width: 520, height: 48))
    let window = NSWindow(contentRect: surface.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = surface
    defer { surface.releaseContent(); window.contentView = nil }
    let fixed = NSButton(frame: NSRect(x: 0, y: 0, width: 80, height: 48))
    let add = NSButton(frame: NSRect(x: 440, y: 0, width: 38, height: 48))
    let buttons = tabs.map { tab in NSButton(frame: tab.frame) }
    ([fixed] + buttons + [add]).forEach { surface.addSubview($0) }
    surface.tabViews = { Array(zip(self.tabs.map(\.id), buttons)).map { ($0, $1) } }
    var writes: [String] = []
    var finish: (() -> Void)?
    surface.onMove = { source, target, before, settled in
      writes.append("\(source):\(target):\(before)")
      finish = settled
    }
    let start = NSPoint(x: 220, y: 24)
    let end = NSPoint(x: 425, y: 24)
    XCTAssertNil(surface.beginPreview(at: NSPoint(x: 40, y: 24)))
    XCTAssertNotNil(surface.beginPreview(at: start))
    XCTAssertEqual(buttons[0].alphaValue, 0)
    surface.updateTarget(end)
    XCTAssertEqual(buttons.map { $0.frame.minX }, [356, 180, 268])
    XCTAssertEqual(fixed.frame.minX, 0)
    XCTAssertEqual(add.frame.minX, 440)
    surface.updateTarget(start)
    surface.endPreview(accepting: true)
    XCTAssertTrue(writes.isEmpty)
    XCTAssertEqual(buttons.map(\.frame), tabs.map(\.frame))
    XCTAssertEqual(buttons[0].alphaValue, 1)

    XCTAssertNotNil(surface.beginPreview(at: start))
    surface.updateTarget(end)
    surface.updateTarget(NSPoint(x: -1, y: 24))
    surface.endPreview(accepting: false)
    XCTAssertTrue(writes.isEmpty)
    XCTAssertEqual(buttons.map(\.frame), tabs.map(\.frame))

    XCTAssertNotNil(surface.beginPreview(at: start))
    surface.updateTarget(end)
    surface.endPreview(accepting: true)
    surface.endPreview(accepting: true)
    XCTAssertEqual(writes, ["tab-a:tab-b:false"])
    XCTAssertEqual(buttons.map { $0.frame.minX }, [356, 180, 268])
    XCTAssertTrue(surface.isReordering)
    XCTAssertEqual(buttons[0].alphaValue, 1)
    try XCTUnwrap(finish)()  // The save failed or returned the original order.
    XCTAssertEqual(buttons.map(\.frame), tabs.map(\.frame))
    XCTAssertFalse(surface.isReordering)

    XCTAssertNotNil(surface.beginPreview(at: start))
    surface.updateTarget(end)
    surface.endPreview(accepting: true)
    surface.cancelInteraction(replacingTabs: true)
    try XCTUnwrap(finish)()
    XCTAssertEqual(buttons.map { $0.frame.minX }, [356, 180, 268])
    XCTAssertFalse(surface.isReordering)
  }
  func testDragPreviewContainsOnlyTheTabTitle() throws {
    let button = NSButton(frame: NSRect(x: 0, y: 0, width: 120, height: 48))
    button.title = "📝 Text"
    let preview = try XCTUnwrap(PanelTabDragSurface.textPreview(for: button))
    XCTAssertEqual(preview.image.size, preview.frame.size)
    XCTAssertLessThan(preview.frame.width, button.bounds.width)
    XCTAssertLessThan(preview.frame.height, button.bounds.height)
    XCTAssertEqual(preview.frame.midX, button.bounds.midX, accuracy: 0.001)
    XCTAssertEqual(preview.frame.midY, button.bounds.midY, accuracy: 0.001)
  }
  func testSwiftUIStateReleasesTheDragSurfaceExactlyOnce() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    var releases = 0
    state.releaseTabDrag = { releases += 1 }
    state.close()
    state.close()
    XCTAssertEqual(releases, 1)
    XCTAssertNil(state.releaseTabDrag)
  }
  func testReleaseClearsDragCallbacksAndDoesNotCommitAMove() {
    let surface = PanelTabDragSurface()
    var moves = 0
    surface.onMove = { _, _, _, _ in moves += 1 }
    surface.releaseContent()
    XCTAssertNil(surface.onMove)
    XCTAssertNil(surface.onDragChanged)
    XCTAssertEqual(moves, 0)
  }
}
