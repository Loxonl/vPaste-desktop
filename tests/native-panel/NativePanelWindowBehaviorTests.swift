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

  func testFilterEntryMotionUsesWebViewSpringAndStagger() throws {
    try XCTSkipIf(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    let view = PanelCardView(frame: NSRect(x: 0, y: 0, width: 220, height: 230))
    view.configure(nil, placeholder: "Loading…", media: PanelMedia(), scale: 1,
      chinese: false, query: "", selected: false)
    defer { view.releaseContent() }
    let start = CACurrentMediaTime()
    view.playFilterEntry(sequence: 1, hash: "entry", index: 13)
    let slide = try XCTUnwrap(
      view.layer?.animation(forKey: "filterEntry.slide") as? CASpringAnimation)
    let fade = try XCTUnwrap(
      view.layer?.animation(forKey: "filterEntry.fade") as? CABasicAnimation)
    XCTAssertEqual(slide.fromValue as? CGFloat, 16)
    XCTAssertEqual(slide.toValue as? CGFloat, 0)
    XCTAssertEqual(slide.mass, 1)
    XCTAssertEqual(slide.stiffness, 220)
    XCTAssertEqual(slide.damping, 28)
    XCTAssertEqual(slide.beginTime - start, 0.018, accuracy: 0.002)
    XCTAssertEqual(fade.duration, 0.18, accuracy: 0.001)
    XCTAssertEqual(fade.fromValue as? CGFloat, 0)
    XCTAssertEqual(fade.toValue as? CGFloat, 1)

    let begin = slide.beginTime
    view.playFilterEntry(sequence: 1, hash: "entry", index: 13)
    XCTAssertEqual(
      (view.layer?.animation(forKey: "filterEntry.slide") as? CASpringAnimation)?.beginTime,
      begin, "The same card must not restart its entry")
  }

  func testDragPreviewIsTheWholeCardScaledToSixtyPercent() throws {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    let view = PanelCardView(frame: NSRect(x: 60, y: 30, width: 220, height: 230))
    window.contentView = view
    view.configure(nil, placeholder: "Loading…", media: PanelMedia(), scale: 1,
      chinese: false, query: "", selected: true)
    view.layoutSubtreeIfNeeded()
    let preview = try XCTUnwrap(view.dragPreviewImage())
    XCTAssertEqual(preview.size.width, 132, accuracy: 0.01)
    XCTAssertEqual(preview.size.height, 138, accuracy: 0.01)
    window.orderOut(nil)
  }

  func testCardSurfaceKeepsTextReadableOverVariableGlass() {
    XCTAssertGreaterThanOrEqual(PanelStyle.cardSurface(false).alphaComponent, 0.98)
    XCTAssertGreaterThanOrEqual(PanelStyle.cardSurface(true).alphaComponent, 0.99)
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

  func testPreviewCanKeepKeyboardFocusWhileNativePanelRetainsMainAppearance() {
    _ = NSApplication.shared
    let panel = NativeHistoryPanel(dockedFrame: NSRect(x: 0, y: 0, width: 800, height: 302))
    let preview = NSWindow(contentRect: NSRect(x: 100, y: 320, width: 400, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    preview.isReleasedWhenClosed = false
    defer { preview.close(); panel.close() }
    panel.makeKeyAndOrderFront(nil)
    panel.makeMain()
    preview.makeKeyAndOrderFront(nil)
    preview.makeMain()
    XCTAssertTrue(preview.isKeyWindow)
    XCTAssertFalse(panel.isMainWindow)
    let panelFrame = panel.frame
    let panelAlpha = panel.alphaValue

    panel.retainMainAppearanceForPreview()

    XCTAssertTrue(panel.isMainWindow, "The glass must retain the main-window appearance")
    XCTAssertTrue(preview.isKeyWindow, "The preview must still receive typing and shortcuts")
    XCTAssertTrue(NSApp.keyWindow === preview)
    XCTAssertEqual(panel.alphaValue, panelAlpha)
    XCTAssertEqual(panel.frame, panelFrame)
    XCTAssertFalse(panel.isMovable)

    preview.makeMain()
    panel.orderOut(nil)
    panel.retainMainAppearanceForPreview()
    XCTAssertTrue(preview.isMainWindow, "A hidden native panel must not retake the main role")
    panel.sizePreview = true
    panel.orderFrontRegardless()
    panel.retainMainAppearanceForPreview()
    XCTAssertTrue(preview.isMainWindow, "Settings size previews must remain noninteractive")
  }

  func testLiquidGlassKeepsActiveAppearanceAfterResigningKeyAndMain() throws {
    #if VPASTE_LIQUID_GLASS_SDK
      guard #available(macOS 26.0, *) else { return }
      _ = NSApplication.shared
      let panel = NativeHistoryPanel(dockedFrame: NSRect(x: 0, y: 0, width: 800, height: 302))
      panel.contentView = PanelBackdrop(scale: 1)
      defer { panel.close() }
      let selector = NSSelectorFromString("_hasMainAppearance")
      let method = try XCTUnwrap(class_getInstanceMethod(NSWindow.self, selector))
      typealias Appearance = @convention(c) (AnyObject, Selector) -> Bool
      let appearance = unsafeBitCast(method_getImplementation(method), to: Appearance.self)
      panel.makeKeyAndOrderFront(nil)
      panel.makeMain()
      let frame = panel.frame
      let alpha = panel.alphaValue

      // Paste and outside clicks can transfer focus before the 200 ms exit ends.
      panel.resignKey()
      panel.resignMain()
      XCTAssertFalse(panel.isKeyWindow)
      XCTAssertFalse(panel.isMainWindow)
      XCTAssertTrue(appearance(panel, selector), "Glass must remain active during the closing slide")
      XCTAssertEqual(panel.frame, frame)
      XCTAssertEqual(panel.alphaValue, alpha)

      panel.sizePreview = true
      XCTAssertFalse(appearance(panel, selector), "Settings size previews must keep their existing appearance")
      panel.orderOut(nil)
      XCTAssertFalse(panel.isVisible)
    #endif
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
