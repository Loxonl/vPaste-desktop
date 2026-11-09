import AppKit
import CoreText
import XCTest

@MainActor
final class NativePanelToolbarTests: XCTestCase {
  func testButtonCursorOnlyCoversEnabledControlsWithoutInterceptingClicks() {
    let region = RecordingCursorRegion(cursor: .pointingHand)
    region.frame = NSRect(x: 0, y: 0, width: 28, height: 28)
    region.resetCursorRects()
    XCTAssertTrue(region.registered.contains { $0.0 == region.bounds && $0.1 === NSCursor.pointingHand })
    XCTAssertNil(region.hitTest(NSPoint(x: 14, y: 14)), "The SwiftUI button must receive the click")
    XCTAssertFalse(region.acceptsFirstResponder)
    region.isEnabled = false
    region.registered.removeAll()
    region.resetCursorRects()
    XCTAssertFalse(region.registered.contains { $0.1 === NSCursor.pointingHand })

    let button = RecordingPointerButton(frame: NSRect(x: 0, y: 0, width: 78, height: 48))
    button.resetCursorRects()
    XCTAssertTrue(button.registered.contains { $0.1 === NSCursor.pointingHand })
    button.isEnabled = false
    button.registered.removeAll()
    button.resetCursorRects()
    XCTAssertFalse(button.registered.contains { $0.1 === NSCursor.pointingHand })
  }

  func testPassThroughCursorRegionDeliversPointerThroughHoverTracking() throws {
    // hitTest must stay nil so SwiftUI receives clicks. AppKit then skips this
    // view for cursor rects and cursorUpdate, so the tracking area's entered
    // message is the path that still shows the pointing hand.
    let cursor = RecordingCursor(
      image: NSImage(size: NSSize(width: 1, height: 1)), hotSpot: .zero)
    let region = PanelCursorRegion(cursor: cursor)
    region.frame = NSRect(x: 0, y: 0, width: 28, height: 28)
    region.updateTrackingAreas()
    let tracking = try XCTUnwrap(region.trackingAreas.first { $0.options.contains(.mouseEnteredAndExited) })
    XCTAssertTrue(tracking.options.contains(.cursorUpdate))
    XCTAssertNil(region.hitTest(NSPoint(x: 14, y: 14)), "The SwiftUI button must receive the click")

    let event = try XCTUnwrap(NSEvent.mouseEvent(
      with: .mouseMoved, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
      context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
    region.mouseEntered(with: event)
    XCTAssertEqual(cursor.setCount, 1)
    region.cursorUpdate(with: event)
    XCTAssertEqual(cursor.setCount, 2)
    region.isEnabled = false
    region.mouseEntered(with: event)
    region.cursorUpdate(with: event)
    XCTAssertEqual(cursor.setCount, 2, "Disabled regions must not change the pointer")
  }

  private final class RecordingCursor: NSCursor {
    private(set) var setCount = 0
    override func set() { setCount += 1 }
  }
  private final class RecordingCursorRegion: PanelCursorRegion {
    var registered: [(NSRect, NSCursor)] = []
    override func addCursorRect(_ rect: NSRect, cursor: NSCursor) { registered.append((rect, cursor)) }
  }
  private final class RecordingPointerButton: PanelPointerButton {
    var registered: [(NSRect, NSCursor)] = []
    override func addCursorRect(_ rect: NSRect, cursor: NSCursor) { registered.append((rect, cursor)) }
  }

  func testNativeToolbarChoosesTheAvailableRenderer() {
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1000, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    if #available(macOS 12.0, *) {
      XCTAssertEqual(toolbar.rendererName, "SwiftUI")
    } else {
      XCTAssertEqual(toolbar.rendererName, "AppKit fallback")
    }
    toolbar.releaseContent()
    XCTAssertTrue(toolbar.subviews.isEmpty)
  }

  func testFilterWidthsUseWebViewFontAndPaddingAtEveryPanelSize() {
    for scale: CGFloat in [0.8, 0.9, 1] {
      let all = PanelFilterChoice(title: "All", emoji: "", symbol: "square.grid.3x3.fill")
      XCTAssertEqual(all.width(scale: scale), 78 * scale, accuracy: 0.01)
      let favorite = PanelFilterChoice(title: "Favorites", emoji: "", symbol: "star")
      let font = PanelToolbarTypography.tabFont(scale: scale, selected: false)
      let text = (favorite.title as NSString).size(withAttributes: [.font: font]).width
      // Fixed tabs: 17px icon + 5px gap + 10px left / 23px right padding.
      XCTAssertEqual(favorite.width(scale: scale), text + 55 * scale, accuracy: 0.01)
      let image = PanelFilterChoice(title: "图片", emoji: "🖼️", symbol: "")
      let label = ("🖼️ 图片" as NSString).size(withAttributes: [.font: font]).width
      XCTAssertEqual(image.width(scale: scale), max(58 * scale, label + 20 * scale), accuracy: 0.01)
    }
  }

  func testSelectionIndicatorTracksTheSelectedTab() throws {
    let choices = [
      PanelFilterChoice(title: "All", emoji: "", symbol: "square.grid.3x3.fill"),
      PanelFilterChoice(title: "Favorites", emoji: "", symbol: "star"),
      PanelFilterChoice(title: "文本", emoji: "📝", symbol: ""),
    ]
    for scale: CGFloat in [0.8, 0.9, 1] {
      let first = try XCTUnwrap(
        PanelFilterIndicatorLayout.rect(choices: choices, selected: 0, scale: scale))
      XCTAssertEqual(first.minX, 10 * scale, accuracy: 0.01)
      XCTAssertEqual(
        first.width, choices[0].width(scale: scale, selected: true) - 20 * scale, accuracy: 0.01)
      XCTAssertEqual(first.height, 3 * scale, accuracy: 0.01)

      let second = try XCTUnwrap(
        PanelFilterIndicatorLayout.rect(choices: choices, selected: 1, scale: scale))
      XCTAssertEqual(second.minX, choices[0].width(scale: scale) + 18 * scale, accuracy: 0.01)
      XCTAssertEqual(
        second.width, choices[1].width(scale: scale, selected: true) - 20 * scale, accuracy: 0.01)

      XCTAssertNil(PanelFilterIndicatorLayout.rect(choices: choices, selected: 3, scale: scale))
    }
  }

  func testCJKFallbackUsesTheWebViewBaseWeight() {
    // PingFang ignores the CT variation axis, so the base weight decides the
    // CJK face: 590 must not fall back to PingFang Semibold.
    XCTAssertEqual(PanelToolbarTypography.baseWeight(for: 450), .regular)
    XCTAssertEqual(PanelToolbarTypography.baseWeight(for: 590), .medium)
    XCTAssertEqual(PanelToolbarTypography.baseWeight(for: 740), .bold)
  }

  func testToolbarFontsKeepWebViewPointSizesAndVariableWeights() throws {
    for scale: CGFloat in [0.8, 0.9, 1] {
      for selected in [false, true] {
        let font = PanelToolbarTypography.tabFont(scale: scale, selected: selected)
        XCTAssertEqual(font.pointSize, 14.5 * scale, accuracy: 0.001)
        let variation = try XCTUnwrap(CTFontCopyVariation(font as CTFont) as? [NSNumber: NSNumber])
        XCTAssertEqual(variation[NSNumber(value: 0x77676874)]?.doubleValue, selected ? 740 : 590)
      }
      XCTAssertEqual(PanelToolbarTypography.lineHeight * scale, 18 * scale)
    }
  }

  func testToolbarButtonsStayOutOfTabFocusWhileSearchRemainsEditable() throws {
    _ = NSApplication.shared
    let search = NSSearchField()
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1000, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: search)
    defer { toolbar.releaseContent() }
    toolbar.layoutSubtreeIfNeeded()
    let content = try XCTUnwrap(toolbar.subviews.first)
    XCTAssertFalse(content.acceptsFirstResponder)
    XCTAssertFalse(content.canBecomeKeyView)
    for view in descendants(of: content) {
      if view is PanelIconButton || view is PanelTabButton {
        XCTAssertFalse(view.acceptsFirstResponder)
        XCTAssertFalse(view.canBecomeKeyView)
      }
      if let scroll = view as? NSScrollView, let document = scroll.documentView {
        XCTAssertFalse(document.acceptsFirstResponder)
        XCTAssertFalse(document.canBecomeKeyView)
      }
    }
    toolbar.beginSearch()
    XCTAssertFalse(search.isHidden)
    XCTAssertTrue(search.acceptsFirstResponder)
  }

  private func descendants(of view: NSView) -> [NSView] {
    view.subviews.flatMap { [$0] + descendants(of: $0) }
  }

  func testMainCommandsWorkAfterToolbarLeavesWindowFocused() throws {
    _ = NSApplication.shared
    let panel = NativeHistoryPanel(dockedFrame: NSRect(x: 0, y: 0, width: 1000, height: 302))
    defer { panel.close() }
    var received: [UInt16] = []
    panel.keyHandler = { received.append($0.keyCode); return true }
    XCTAssertTrue(panel.performKeyEquivalent(with: try key("f", code: 3, in: panel)))
    XCTAssertTrue(panel.performKeyEquivalent(with: try key("r", code: 15, in: panel)))
    XCTAssertTrue(panel.performKeyEquivalent(with: try key("\u{1b}", code: 53, flags: [], in: panel)))
    XCTAssertEqual(received, [3, 15, 53])
  }

  func testSearchEditorKeepsItsCopyAndArrowKeys() throws {
    _ = NSApplication.shared
    let panel = NativeHistoryPanel(dockedFrame: NSRect(x: 0, y: 0, width: 1000, height: 302))
    defer { panel.close() }
    let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 32))
    panel.contentView?.addSubview(editor)
    XCTAssertTrue(panel.makeFirstResponder(editor))
    var received: [UInt16] = []
    panel.keyHandler = { received.append($0.keyCode); return true }
    _ = panel.performKeyEquivalent(with: try key("c", code: 8, in: panel))
    _ = panel.performKeyEquivalent(with: try key("\u{f702}", code: 123, flags: [], in: panel))
    _ = panel.performKeyEquivalent(with: try key("\u{1b}", code: 53, flags: [], in: panel))
    XCTAssertTrue(received.isEmpty)
    XCTAssertTrue(panel.performKeyEquivalent(with: try key("f", code: 3, in: panel)))
    XCTAssertEqual(received, [3])
  }

  private func key(_ text: String, code: UInt16, flags: NSEvent.ModifierFlags = .command,
    in window: NSWindow) throws -> NSEvent {
    try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
      timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
      charactersIgnoringModifiers: text, isARepeat: false, keyCode: code))
  }

  @available(macOS 12.0, *)
  func testFiltersKeepTheirMappingAndStopAfterClose() {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    var received: [Int] = []
    state.onFilter = { received.append($0) }
    state.choose(3)
    XCTAssertEqual(state.selected, 3)
    XCTAssertEqual(received, [3])
    state.choose(99)
    XCTAssertEqual(received, [3])
    state.close()
    state.choose(1)
    XCTAssertEqual(received, [3])
  }

  @available(macOS 12.0, *)
  func testNonemptySearchDoesNotCollapseAndCloseCancelsActions() {
    let search = NSSearchField()
    let state = PanelToolbarState(scale: 1, chinese: true, search: search)
    state.beginSearch()
    XCTAssertTrue(state.searchOpen)
    search.stringValue = "中文搜索"
    state.endEmptySearch()
    XCTAssertTrue(state.searchOpen)
    search.stringValue = ""
    state.endEmptySearch()
    XCTAssertFalse(state.searchOpen)
    var calls = 0
    state.onRefresh = { calls += 1 }
    state.close()
    state.onRefresh?()
    state.beginSearch()
    XCTAssertEqual(calls, 0)
    XCTAssertFalse(state.searchOpen)
  }
}
