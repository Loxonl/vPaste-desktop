import AppKit
import XCTest

@MainActor
private var searchRequests: [[String: Any]] = []

@MainActor
final class NativePanelSearchTests: XCTestCase {
  func testReturnWhileDebouncingUsesNewQueryNotOldSelection() throws {
    try withPanel { controller, search, editor in
      editor.string = "bravo"
      changed(controller, search)
      enter(controller, search, editor)
      XCTAssertTrue(actions.isEmpty)
      let open = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
      XCTAssertEqual(open["keywords"] as? String, "bravo")
      XCTAssertTrue(search.window?.firstResponder === search.currentEditor())
      reply(controller, open, data: page("B"))
      XCTAssertTrue(search.window?.firstResponder === search.currentEditor())
      XCTAssertEqual(actions.compactMap { $0["hash"] as? String }, ["B"])
    }
  }

  func testZeroResultsErrorAndCancellationDoNotReplayEnter() throws {
    for outcome in ["empty", "error", "cancel"] {
      try withPanel { controller, search, editor in
        editor.string = "bravo"
        changed(controller, search)
        enter(controller, search, editor)
        let open = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
        if outcome == "cancel" {
          _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.cancelOperation(_:)))
        }
        reply(controller, open, data: page(outcome == "cancel" ? "B" : nil), error: outcome == "error" ? "fixture failure" : nil)
        XCTAssertTrue(actions.isEmpty, outcome)
      }
    }
  }

  func testOldListCannotPasteOrDeleteDuringDebounce() throws {
    for (code, characters): (UInt16, String) in [(36, "\r"), (51, "\u{7f}")] {
      try withPanel { controller, search, editor in
        editor.string = "bravo"
        changed(controller, search)
        let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
        _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
        _ = window.keyHandler?(try key(code, characters: characters, window: window))
        XCTAssertTrue(actions.isEmpty)
      }
    }
  }

  func testMarkedTextDoesNotSubmitOrStartTheDebouncedQuery() throws {
    try withPanel { controller, search, editor in
      editor.setMarkedText("候選", selectedRange: NSRange(location: 0, length: 0), replacementRange: editor.selectedRange())
      XCTAssertTrue(editor.hasMarkedText())
      changed(controller, search)
      XCTAssertFalse(controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:))))
      RunLoop.current.run(until: Date().addingTimeInterval(0.20))
      XCTAssertFalse(searchRequests.contains { $0["op"] as? String == "open" })
      XCTAssertTrue(actions.isEmpty)
      editor.unmarkText()
      changed(controller, search)
      enter(controller, search, editor)
      let open = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
      XCTAssertEqual(open["keywords"] as? String, "候選")
    }
  }

  func testNewQueryDiscardsPendingEnterAndOlderReply() throws {
    try withPanel { controller, search, editor in
      editor.string = "bravo"
      changed(controller, search)
      enter(controller, search, editor)
      let old = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
      editor.string = "alpha"
      changed(controller, search)
      enter(controller, search, editor)
      let new = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
      reply(controller, old, data: page("B"))
      XCTAssertTrue(actions.isEmpty)
      reply(controller, new, data: page("A"))
      XCTAssertEqual(actions.compactMap { $0["hash"] as? String }, ["A"])
    }
  }

  func testOversizeSearchReportsFailureWithoutPasting() throws {
    try withPanel { controller, search, editor in
      editor.string = String(repeating: "x", count: 66_000)
      changed(controller, search)
      enter(controller, search, editor)
      XCTAssertTrue(actions.isEmpty)
      XCTAssertFalse(searchRequests.contains { $0["op"] as? String == "open" })
      let content = try XCTUnwrap(search.window?.contentView)
      let retry = allViews(content).compactMap { $0 as? NSButton }.first { $0.title == "Retry" }
      XCTAssertEqual(retry?.isHiddenOrHasHiddenAncestor, false)
    }
  }

  private var actions: [[String: Any]] {
    searchRequests.filter { ["paste", "delete"].contains($0["op"] as? String ?? "") }
  }

  private func withPanel(_ body: (NativePanelController, NSSearchField, NSTextView) throws -> Void) throws {
    _ = NSApplication.shared
    let config = try JSONDecoder().decode(PanelConfiguration.self, from: Data("""
      {"session":42,"sizePreview":false,"language":"English","theme":"light","scale":1,
       "mousePasteMode":"double","hoverPreviewEnabled":false,"tabQuickSelectEnabled":true,
       "panelHeight":302,"horizontalBleed":0,"showDuration":0,"hideDuration":0,
       "showCurve":[],"hideCurve":[]}
      """.utf8))
    searchRequests = []
    let callbacks = VPastePanelCallbacks(abi_version: 1, request: { bytes, count in
      guard let bytes, let value = try? JSONSerialization.jsonObject(with: Data(bytes: bytes, count: count))
        as? [String: Any] else { return }
      MainActor.assumeIsolated { searchRequests.append(value) }
    }, set_key: { _ in })
    let controller = NativePanelController(callbacks: callbacks, config: config)
    defer { controller.dismiss(animated: false) }
    controller.present()
    let initial = try XCTUnwrap(searchRequests.first { $0["op"] as? String == "history-resume" })
    reply(controller, initial, data: ["tabs": [], "tabId": "all", "keywords": "", "label": "", "delta": [
      "token": ["viewId": "old", "revision": 1], "baseRevision": 0, "full": true,
      "pages": [["pageIndex": 0, "hashes": ["A"]]], "refs": [ref("A")], "knownCount": 1,
      "hasMore": false, "anchorIndex": 0, "selectedIndex": 0, "offset": 0,
      "viewportRevision": 0, "invalidated": [], "resourcesChanged": false]])
    let window = try XCTUnwrap(NSApp.windows.first { $0.delegate === controller })
    _ = window.performKeyEquivalent(with: try key(3, characters: "f", window: window, flags: .command))
    let search = try XCTUnwrap(allViews(try XCTUnwrap(window.contentView)).compactMap { $0 as? NSSearchField }.first)
    _ = window.makeFirstResponder(search)
    let editor = try XCTUnwrap(search.currentEditor() as? NSTextView)
    try body(controller, search, editor)
  }

  private func changed(_ controller: NativePanelController, _ search: NSSearchField) {
    controller.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
  }
  private func enter(_ controller: NativePanelController, _ search: NSSearchField, _ editor: NSTextView) {
    _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
  }
  private func reply(_ controller: NativePanelController, _ request: [String: Any], data: [String: Any], error: String? = nil) {
    var response: [String: Any] = ["session": 42, "data": data]
    response["id"] = request["id"]
    response["error"] = error
    controller.bridge.receive(response)
  }
  private func ref(_ hash: String) -> [String: Any] {
    ["hash": hash, "itemType": "Text", "time": 1, "label": 0, "appSource": "", "titleColor": ""]
  }
  private func page(_ hash: String?) -> [String: Any] {
    ["token": ["viewId": "new", "revision": 1], "pageIndex": 0, "startIndex": 0,
     "items": hash.map { [ref($0)] } ?? [], "knownCount": hash == nil ? 0 : 1, "hasMore": false]
  }
  private func key(_ code: UInt16, characters: String, window: NSWindow, flags: NSEvent.ModifierFlags = []) throws -> NSEvent {
    try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
      windowNumber: window.windowNumber, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
  }
  private func allViews(_ root: NSView) -> [NSView] { [root] + root.subviews.flatMap(allViews) }
}
