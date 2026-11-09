import AppKit
import QuartzCore
import XCTest

// Compile alongside the native-panel sources. These cases do not use a WebView
// or the user's clipboard/database. Kept for future execution; suites are not
// run as part of the requested implementation workflow.
@MainActor
final class NativePanelWindowBehaviorTests: XCTestCase {
  func testCardDragUsesClosedHandOnlyAfterThresholdAndRestoresOnRelease() throws {
    _ = NSApplication.shared
    let view = PanelCardView(frame: NSRect(x: 0, y: 0, width: 220, height: 230))
    let card = PanelCard(hash: "cursor", itemType: "Text", text: "Drag fixture", source: "",
      sourceIcon: "", remote: false, time: 0, color: "", favorite: false, tags: [], assetPath: "",
      animationPath: "", dimensions: "", mediaWidth: 0, mediaHeight: 0, displayTitle: "",
      displaySubtitle: "", displaySymbol: "", fileFormat: "", isGif: false, rich: [])
    view.configure(card, placeholder: "", media: PanelMedia(), scale: 1, chinese: false,
      query: "", selected: false)
    var prepared = 0
    var activated = 0
    view.prepareDrag = { _ in prepared += 1 } // Hold preparation; never touches the pasteboard.
    view.activate = { activated += 1 }
    defer { view.releaseContent(); NSCursor.arrow.set() }
    func mouse(_ type: NSEvent.EventType, x: CGFloat) throws -> NSEvent {
      try XCTUnwrap(NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: 20),
        modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
        clickCount: 1, pressure: 1))
    }
    NSCursor.openHand.set()
    view.mouseDown(with: try mouse(.leftMouseDown, x: 20))
    view.mouseDragged(with: try mouse(.leftMouseDragged, x: 22))
    XCTAssertEqual(prepared, 0)
    XCTAssertTrue(NSCursor.current === NSCursor.openHand)
    view.mouseDragged(with: try mouse(.leftMouseDragged, x: 30))
    XCTAssertEqual(prepared, 1)
    XCTAssertTrue(NSCursor.current === NSCursor.closedHand)
    view.mouseUp(with: try mouse(.leftMouseUp, x: 30))
    XCTAssertTrue(NSCursor.current === NSCursor.openHand)
    XCTAssertEqual(activated, 0, "A drag must not also trigger the paste click")
  }

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

  func testCardContentKeepsWebViewCornersWithoutClippingItsOutlineOrShadow() {
    _ = NSApplication.shared
    for scale: CGFloat in [0.8, 0.9, 1] {
      let card = PanelCardView(frame: NSRect(x: 0, y: 0, width: 220 * scale, height: 230 * scale))
      card.configure(nil, placeholder: "Loading", media: PanelMedia(), scale: scale,
        chinese: false, query: "", selected: true)
      card.needsLayout = true
      card.layoutSubtreeIfNeeded()
      XCTAssertFalse(card.layer?.masksToBounds ?? true, "The outer outline and shadow must remain visible")
      XCTAssertNotNil(card.layer?.shadowPath)
      let content = descendants(of: card).filter { $0 is NSImageView || $0 is NSTextField }
      XCTAssertFalse(content.isEmpty)
      for view in content {
        var ancestor = view.superview
        var clippedAtCardBounds = false
        while let parent = ancestor, parent !== card {
          if parent.frame == card.bounds, parent.layer?.masksToBounds == true,
            parent.layer?.cornerRadius == 14 * scale, parent.isFlipped == card.isFlipped {
            clippedAtCardBounds = true
            break
          }
          ancestor = parent.superview
        }
        XCTAssertTrue(clippedAtCardBounds, "Images and labels must share the card's rounded clipping")
      }
      card.releaseContent()
    }
  }

  private func descendants(of view: NSView) -> [NSView] {
    view.subviews.flatMap { [$0] + descendants(of: $0) }
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
