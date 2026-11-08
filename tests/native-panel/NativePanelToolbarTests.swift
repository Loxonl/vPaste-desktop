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
