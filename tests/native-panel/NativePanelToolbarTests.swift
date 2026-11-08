import AppKit
import XCTest

@MainActor
final class NativePanelToolbarTests: XCTestCase {
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
  func testFiltersKeepTheirMappingAndKeyboardWraparound() {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    var received: [Int] = []
    state.onFilter = { received.append($0) }
    state.choose(3)
    XCTAssertEqual(state.selected, 3)
    XCTAssertEqual(received, [3])
    XCTAssertEqual(state.neighbor(of: 0, step: -1), 6)
    XCTAssertEqual(state.neighbor(of: 6, step: 1), 0)
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
