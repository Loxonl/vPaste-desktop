import AppKit
import QuartzCore
import XCTest

// Compile alongside the native-panel sources. These cases do not use a WebView
// or the user's clipboard/database. Kept for future execution; suites are not
// run as part of the requested implementation workflow.
@MainActor
final class NativePanelWindowBehaviorTests: XCTestCase {
  func testVerticalWheelWithHorizontalNoiseBrowsesTheRow() {
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 100, maximum: 500, deltaX: -0.4, deltaY: -20, precise: true),
      120)
  }

  func testHorizontalTrackpadAndMouseWheelKeepTheirDirectionAndUnits() {
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 100, maximum: 500, deltaX: -30, deltaY: -2, precise: true),
      130)
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 100, maximum: 500, deltaX: 0, deltaY: -3, precise: false),
      136)
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 100, maximum: 500, deltaX: 0, deltaY: 3, precise: false),
      64)
  }

  func testWheelStopsAtBothEdgesAndShortContentStaysAtZero() {
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 5, maximum: 500, deltaX: 0, deltaY: 20, precise: true), 0)
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 490, maximum: 500, deltaX: -20, deltaY: 0, precise: true),
      500)
    XCTAssertEqual(
      PanelScroll.targetOffset(current: 0, maximum: 0, deltaX: 0, deltaY: -20, precise: true), 0)
  }

  func testPanelHasNoScrollbarsButRetainsItsScrollDocument() {
    let scroll = PanelScroll(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
    let document = PanelList(frame: NSRect(x: 0, y: 0, width: 2000, height: 200))
    document.collectionViewLayout = PanelListLayout()
    scroll.documentView = document
    // Collection layout can request a scroller again after attachment.
    scroll.hasHorizontalScroller = true
    scroll.hasVerticalScroller = true
    XCTAssertFalse(scroll.hasHorizontalScroller)
    XCTAssertFalse(scroll.hasVerticalScroller)
    XCTAssertTrue(scroll.documentView === document)
  }

  func testDockedWindowRetainsExactFrameAndCannotBeMoved() {
    _ = NSApplication.shared
    let frame = NSRect(x: -1932, y: -900, width: 1944, height: 272)
    let panel = NativeHistoryPanel(dockedFrame: frame)
    defer { panel.close() }
    XCTAssertEqual(panel.frame, frame)
    XCTAssertEqual(panel.constrainFrameRect(frame, to: NSScreen.main), frame)
    XCTAssertFalse(panel.isMovable)
    XCTAssertFalse(panel.isMovableByWindowBackground)
    XCTAssertFalse(panel.styleMask.contains(.titled))
    XCTAssertTrue(panel.canBecomeKey)
  }

  func testSizePreviewCannotTakeKeyboardOrMainWindowFocus() {
    _ = NSApplication.shared
    let panel = NativeHistoryPanel(dockedFrame: NSRect(x: -12, y: 0, width: 1944, height: 302))
    defer { panel.close() }
    panel.sizePreview = true
    XCTAssertFalse(panel.canBecomeKey)
    XCTAssertFalse(panel.canBecomeMain)
    XCTAssertFalse(panel.isMovable)
  }

  func testReducedMotionUpdatesContentWithoutMovingTheHost() {
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 1944, height: 302))
    let surface = NSView(frame: root.bounds)
    surface.wantsLayer = true
    root.addSubview(surface)
    PanelSlide.prepare(surface, hidden: true)
    XCTAssertEqual(surface.frame.origin.y, -302)
    var completed = false
    PanelSlide.animate(surface, show: true, duration: 0.15, curve: [0.2, 0.8, 0.2, 1], reduced: true) {
      completed = true
    }
    XCTAssertTrue(completed)
    XCTAssertEqual(surface.frame, root.bounds)
    XCTAssertNil(surface.layer?.animation(forKey: "position"))
    PanelSlide.animate(surface, show: false, duration: 0.2, curve: [0.42, 0, 0.58, 1], reduced: true) {}
    XCTAssertEqual(surface.frame.origin.y, -302)
    XCTAssertEqual(root.frame.origin, .zero)
  }

  func testNormalSlideAnimatesOnlyTheContentPosition() {
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 1944, height: 302))
    let surface = NSView(frame: root.bounds)
    surface.wantsLayer = true
    root.addSubview(surface)
    PanelSlide.prepare(surface, hidden: true)
    PanelSlide.animate(surface, show: true, duration: 0.15, curve: [0.2, 0.8, 0.2, 1], reduced: false) {}
    let animation = surface.layer?.animation(forKey: "position") as? CABasicAnimation
    XCTAssertEqual(animation?.keyPath, "position")
    XCTAssertEqual(animation?.duration, 0.15)
    XCTAssertEqual(surface.frame, root.bounds)
    XCTAssertEqual(root.frame.origin, .zero)
    surface.layer?.removeAllAnimations()
  }
}
