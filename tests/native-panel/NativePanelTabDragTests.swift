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
  func testEdgeScrollingStopsOutsideTheViewportAndInItsCenter() {
    let viewport = NSRect(x: 100, y: 0, width: 400, height: 48)
    XCTAssertLessThan(PanelTabDragLayout.scrollStep(x: 101, visible: viewport, scale: 1), 0)
    XCTAssertGreaterThan(PanelTabDragLayout.scrollStep(x: 499, visible: viewport, scale: 1), 0)
    XCTAssertEqual(PanelTabDragLayout.scrollStep(x: 300, visible: viewport, scale: 1), 0)
    XCTAssertEqual(PanelTabDragLayout.scrollStep(x: 50, visible: viewport, scale: 1), 0)
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
    surface.onMove = { _, _, _ in moves += 1 }
    surface.releaseContent()
    XCTAssertNil(surface.onMove)
    XCTAssertNil(surface.onDragChanged)
    XCTAssertEqual(moves, 0)
  }
}
