import AppKit
import XCTest

@MainActor
private var searchRequests: [[String: Any]] = []

@MainActor
final class NativePanelSearchTests: XCTestCase {
  func testPreviewFailureSurvivesViewportRefreshUntilAnotherCardIsSelected() throws {
    try withPanel(hashes: ["A", "B"]) { controller, search, _ in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      let content = try XCTUnwrap(window.contentView)
      let footer = try XCTUnwrap(allViews(content).compactMap { $0 as? NSTextField }.first {
        $0.stringValue.hasPrefix("Native preview")
      })

      _ = window.keyHandler?(try key(49, characters: " ", window: window))
      let request = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "preview-toggle" })
      reply(controller, request, data: [:], error: "fixture preview source missing")
      XCTAssertTrue(footer.stringValue.contains("fixture preview source missing"))

      let viewportUpdated = expectation(description: "Refresh the viewport after the footer appears")
      DispatchQueue.main.async { viewportUpdated.fulfill() }
      wait(for: [viewportUpdated], timeout: 1)
      XCTAssertTrue(footer.stringValue.contains("fixture preview source missing"))

      _ = window.keyHandler?(try key(124, characters: "", window: window))
      XCTAssertFalse(footer.stringValue.contains("fixture preview source missing"))
    }
  }

  func testLatePreviewFailureDoesNotReplaceFeedbackForNewerRequest() throws {
    try withPanel(hashes: ["A", "B"]) { controller, search, _ in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      let content = try XCTUnwrap(window.contentView)
      let space = try key(49, characters: " ", window: window)
      _ = window.keyHandler?(space)
      let first = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "preview-toggle" })
      _ = window.keyHandler?(try key(124, characters: "", window: window))
      _ = window.keyHandler?(space)
      let next = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "preview-toggle" })
      XCTAssertEqual(first["hash"] as? String, "A")
      XCTAssertEqual(next["hash"] as? String, "B")

      reply(controller, next, data: [:])
      reply(controller, first, data: [:], error: "fixture expired preview")
      XCTAssertFalse(allViews(content).compactMap { $0 as? NSTextField }.contains {
        $0.stringValue.contains("fixture expired preview")
      })
    }
  }

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

  func testListCommandCUsesOriginalFormatAndShiftCommandCDoesNotCopy() throws {
    try withPanel { controller, search, editor in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
      _ = window.performKeyEquivalent(with: try key(8, characters: "c", window: window, flags: .command))
      let copy = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "copy" })
      XCTAssertEqual(copy["hash"] as? String, "A")
      XCTAssertEqual(copy["plain"] as? Bool, false)
      reply(controller, copy, data: [:])
      XCTAssertTrue(window.isVisible)
      _ = window.performKeyEquivalent(with: try key(8, characters: "c", window: window, flags: [.command, .shift]))
      XCTAssertEqual(searchRequests.filter { $0["op"] as? String == "copy" }.count, 1)
      XCTAssertTrue(actions.isEmpty)
    }
  }

  func testRepeatedDeleteDoesNotDeleteOrOpenAConfirmation() throws {
    try withPanel { controller, search, editor in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
      _ = window.keyHandler?(try key(51, characters: "\u{7f}", window: window, repeating: true))
      XCTAssertNil(window.attachedSheet)
      XCTAssertTrue(actions.isEmpty)
      _ = window.keyHandler?(try key(51, characters: "\u{7f}", window: window))
      let sheet = try XCTUnwrap(window.attachedSheet)
      XCTAssertTrue(actions.isEmpty)
      window.endSheet(sheet, returnCode: .alertSecondButtonReturn)
      XCTAssertTrue(actions.isEmpty)
    }
  }

  func testEscapeInTheCommittedPdfReaderClosesItAndRestoresListFocus() throws {
    try withPanel { controller, search, _ in
      let panel = try XCTUnwrap(search.window as? NativeHistoryPanel)
      let list = try XCTUnwrap(allViews(try XCTUnwrap(panel.contentView)).compactMap {
        $0 as? NSCollectionView
      }.first)
      let reader = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
        styleMask: [.titled], backing: .buffered, defer: false)
      reader.isReleasedWhenClosed = false
      defer { reader.close() }
      reader.makeKeyAndOrderFront(nil)
      controller.bridge.receive(["session": 42, "event": "preview-pdf", "windowNumber": reader.windowNumber])
      searchRequests.removeAll()

      NSApp.sendEvent(try key(49, characters: " ", window: reader))
      XCTAssertFalse(searchRequests.contains { $0["op"] as? String == "preview-close" })
      NSApp.sendEvent(try key(53, characters: "\u{1b}", window: reader))

      XCTAssertEqual(searchRequests.filter { $0["op"] as? String == "preview-close" }.count, 1)
      XCTAssertTrue(panel.firstResponder === list)

      controller.bridge.receive(["session": 42, "event": "preview-pdf"])
      reader.makeKeyAndOrderFront(nil)
      NSApp.sendEvent(try key(53, characters: "\u{1b}", window: reader))
      XCTAssertEqual(searchRequests.filter { $0["op"] as? String == "preview-close" }.count, 1)
    }
  }

  func testFavoriteMenuKeepsTheCapturedHashAndIntentAfterHistoryReorders() throws {
    try withPanel(hashes: ["A", "B"]) { controller, _, _ in
      let b = try panelDecode(PanelCard.self, card("B"))
      let option = try XCTUnwrap(PanelContextMenu.options(card: b, tags: .loading, colors: nil,
        chinese: false).first { $0.action == .favorite(true) })
      controller.bridge.receive(["session": 42, "event": "history-dirty"])
      let sync = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "history-sync" })
      let checkpoint = try XCTUnwrap(sync["checkpoint"] as? [String: Any])
      var updatedB = ref("B")
      updatedB["label"] = 1
      reply(controller, sync, data: [
        "token": ["viewId": "old", "revision": 2], "baseRevision": 1, "full": false,
        "pages": [["pageIndex": 0, "hashes": ["B", "A"]]], "refs": [updatedB], "knownCount": 2,
        "hasMore": false, "anchorIndex": 0, "selectedIndex": 1, "offset": 0,
        "viewportRevision": checkpoint["viewportRevision"] ?? 0, "invalidated": ["B"], "resourcesChanged": false,
      ])
      controller.performMenu(try XCTUnwrap(option.action), card: b)
      let favorite = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "favorite" })
      XCTAssertEqual(favorite["hash"] as? String, "B")
      XCTAssertEqual(favorite["favorite"] as? Bool, true)
    }
  }

  func testCopyAndPasteMenuUsesTheOriginalFormatOfTheCapturedCard() throws {
    try withPanel(hashes: ["A", "B"]) { controller, _, _ in
      let b = try panelDecode(PanelCard.self, card("B"))
      let options = PanelContextMenu.options(card: b, tags: .loading, colors: nil, chinese: false)
      controller.performMenu(try XCTUnwrap(options.first { $0.title == "Copy and paste" }?.action), card: b)
      let request = try XCTUnwrap(actions.last)
      XCTAssertEqual(request["op"] as? String, "paste")
      XCTAssertEqual(request["hash"] as? String, "B")
      XCTAssertEqual(request["plain"] as? Bool, false)
    }
  }

  func testOldCardMouseAndMenuCannotPasteOrDeleteDuringDebounce() throws {
    try withPanel { controller, search, editor in
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
      let cards = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "cards" })
      reply(controller, cards, data: ["cards": [card("A")]])
      let window = try XCTUnwrap(search.window)
      let content = try XCTUnwrap(window.contentView)
      let view = try XCTUnwrap(allViews(content).compactMap { $0 as? PanelCardView }.first { $0.card?.hash == "A" })
      let old = try XCTUnwrap(view.card)
      editor.string = "bravo"
      changed(controller, search)
      let location = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
      for (type, clicks): (NSEvent.EventType, Int) in [(.leftMouseUp, 2), (.rightMouseDown, 1)] {
        let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: 0,
          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1))
        if type == .leftMouseUp { view.mouseUp(with: event) }
        else { view.rightMouseDown(with: event) }
      }
      controller.performMenu(.copyAndPaste, card: old)
      controller.performMenu(.pastePlainText, card: old)
      controller.performMenu(.delete, card: old)
      XCTAssertNil(window.attachedSheet)
      XCTAssertTrue(actions.isEmpty)
    }
  }

  func testAnimatedDismissalCancelsPendingPreviewWithoutClosingTheReader() throws {
    try withPanel { controller, search, _ in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      _ = window.keyHandler?(try key(49, characters: " ", window: window))
      XCTAssertEqual(searchRequests.last?["op"] as? String, "preview-toggle")

      let start = searchRequests.count
      controller.dismiss()
      controller.dismiss()

      let previewOperations = searchRequests.dropFirst(start)
        .compactMap { $0["op"] as? String }
        .filter { $0.hasPrefix("preview-") }
      XCTAssertEqual(previewOperations, ["preview-cancel-pending"])
    }
  }

  func testQueueSelectionDoesNotFollowPreviewButSpaceStillDoes() throws {
    try withPanel(hashes: ["A", "B"]) { controller, search, editor in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
      controller.bridge.receive(["session": 42, "event": "paste-queue-state", "active": true,
        "revision": 1, "activationEpoch": 1, "selectedHashes": ["A"], "selectionRevision": 1,
        "selectionBusy": false])
      let start = searchRequests.count
      _ = window.keyHandler?(try key(124, characters: "", window: window))
      XCTAssertFalse(searchRequests.dropFirst(start).contains {
        $0["op"] as? String == "preview" && $0["mode"] as? String == "selection"
      })
      _ = window.keyHandler?(try key(49, characters: " ", window: window))
      let explicit = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "preview-toggle" })
      XCTAssertEqual(explicit["hash"] as? String, "B")
      XCTAssertFalse(searchRequests.contains { $0["op"] as? String == "paste-queue-select" })
    }
  }

  func testTextEditorOpenFailureStaysOnTheNativePanel() throws {
    try withPanel { controller, search, _ in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      controller.performMenu(.editText, card: try panelDecode(PanelCard.self, card("A")))
      let request = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "edit" })
      reply(controller, request, data: [:], error: "fixture text source missing")

      let sheet = try XCTUnwrap(window.attachedSheet)
      XCTAssertTrue(allViews(try XCTUnwrap(sheet.contentView)).compactMap { $0 as? NSTextField }.contains {
        $0.stringValue.contains("fixture text source missing")
      })
      window.endSheet(sheet)
      XCTAssertTrue(window.isVisible)
    }
  }

  func testQueueListEnterRequiresAnExplicitCardInTheCurrentActivation() throws {
    try withPanel(hashes: ["A", "B"]) { controller, search, editor in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
      let cards = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "cards" })
      reply(controller, cards, data: ["cards": [card("A"), card("B")]])
      let content = try XCTUnwrap(window.contentView)
      let b = try XCTUnwrap(allViews(content).compactMap { $0 as? PanelCardView }.first { $0.card?.hash == "B" })
      @MainActor func queueRequests() -> [[String: Any]] {
        searchRequests.filter { $0["op"] as? String == "paste-queue-select" }
      }
      controller.bridge.receive(queueState(epoch: 1))
      let enter = try key(36, characters: "\r", window: window)
      _ = window.keyHandler?(enter)
      XCTAssertTrue(queueRequests().isEmpty)
      XCTAssertFalse(b.queueKeyboardFocused)

      _ = window.keyHandler?(try key(124, characters: "", window: window))
      XCTAssertTrue(b.queueKeyboardFocused)
      XCTAssertFalse(b.queueCheckVisible)
      _ = window.keyHandler?(enter)
      XCTAssertEqual(queueRequests().compactMap { $0["hash"] as? String }, ["B"])
      XCTAssertEqual(queueRequests().last?["activationEpoch"] as? UInt64, 1)

      controller.bridge.receive(queueState(epoch: 2))
      _ = window.keyHandler?(enter)
      XCTAssertFalse(b.queueKeyboardFocused)
      XCTAssertEqual(queueRequests().count, 1)
      XCTAssertTrue(actions.isEmpty)
    }
  }

  func testQueueSearchEnterStillSelectsTheCurrentFirstResult() throws {
    try withPanel { controller, search, editor in
      controller.bridge.receive(queueState(epoch: 1))
      editor.string = "bravo"
      changed(controller, search)
      enter(controller, search, editor)
      let open = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
      reply(controller, open, data: page("B"))
      let selection = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "paste-queue-select" })
      XCTAssertEqual(selection["hash"] as? String, "B")
      XCTAssertEqual(selection["activationEpoch"] as? UInt64, 1)
      XCTAssertTrue(actions.isEmpty)
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

  func testRemovingActiveTabRevalidatesPreviewWithoutClearingItFirst() throws {
    let review: [String: Any] = ["id": "record:7", "name": "Review", "label": "review", "record": true]
    try withPanel(tab: review, keywords: "result") { controller, search, editor in
      let window = try XCTUnwrap(search.window as? NativeHistoryPanel)
      _ = controller.control(search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
      _ = window.keyHandler?(try key(49, characters: " ", window: window))
      XCTAssertEqual(searchRequests.last { $0["op"] as? String == "preview-toggle" }?["hash"] as? String, "A")
      searchRequests.removeAll()

      controller.bridge.receive(["session": 42, "event": "tabs-changed"])
      let tabs = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "tabs" })
      reply(controller, tabs, data: [[String: Any]]())
      let open = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "open" })
      XCTAssertEqual(open["tabId"] as? String, "all")
      XCTAssertEqual(open["keywords"] as? String, "result")
      XCTAssertEqual(open["revalidatePreview"] as? Bool, true)
      XCTAssertFalse(searchRequests.contains { $0["op"] as? String == "preview-close" })

      reply(controller, open, data: page(nil), error: "fixture query failure")
      XCTAssertEqual(searchRequests.filter { $0["op"] as? String == "preview-close" }.count, 1)
    }
  }

  func testCreatedTagAssignmentFailureKeepsCurrentResultsAndOffersManualRetry() throws {
    try withPanel(hashes: ["A", "B"], keywords: "result") { controller, search, _ in
      let content = try XCTUnwrap(search.window?.contentView)
      let review: [String: Any] = ["id": "record:9", "name": "Review", "label": "review", "record": true]
      searchRequests.removeAll()

      controller.bridge.receive(["session": 42, "event": "tabs-changed", "activeId": "record:9",
        "assignmentError": "fixture assignment refused"])
      let tabs = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "tabs" })
      reply(controller, tabs, data: [review])

      XCTAssertFalse(searchRequests.contains { $0["op"] as? String == "open" })
      XCTAssertEqual(search.stringValue, "result")
      XCTAssertTrue(allViews(content).compactMap { $0 as? NSTextField }.contains {
        $0.stringValue.contains("Tag created") && $0.stringValue.contains("original card")
      })
    }
  }

  func testCreatedTagAssignmentSuccessSelectsNewTab() throws {
    try withPanel { controller, _, _ in
      let review: [String: Any] = ["id": "record:9", "name": "Review", "label": "review", "record": true]
      searchRequests.removeAll()

      controller.bridge.receive(["session": 42, "event": "tabs-changed", "activeId": "record:9"])
      let tabs = try XCTUnwrap(searchRequests.last { $0["op"] as? String == "tabs" })
      reply(controller, tabs, data: [review])

      XCTAssertEqual(searchRequests.last { $0["op"] as? String == "open" }?["tabId"] as? String, "record:9")
    }
  }

  private var actions: [[String: Any]] {
    searchRequests.filter { ["paste", "delete"].contains($0["op"] as? String ?? "") }
  }

  private func withPanel(hashes: [String] = ["A"], tab: [String: Any]? = nil, keywords: String = "",
    _ body: (NativePanelController, NSSearchField, NSTextView) throws -> Void
  ) throws {
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
    reply(controller, initial, data: ["tabs": tab.map { [$0] } ?? [], "tabId": tab?["id"] as? String ?? "all",
      "keywords": keywords, "label": tab?["label"] as? String ?? "", "delta": [
      "token": ["viewId": "old", "revision": 1], "baseRevision": 0, "full": true,
      "pages": [["pageIndex": 0, "hashes": hashes]], "refs": hashes.map(ref), "knownCount": hashes.count,
      "hasMore": false, "anchorIndex": 0, "selectedIndex": 0, "offset": 0,
      "viewportRevision": 0, "invalidated": [], "resourcesChanged": false]])
    let window = try XCTUnwrap(NSApp.windows.first { $0.delegate === controller })
    _ = window.performKeyEquivalent(with: try key(3, characters: "f", window: window, flags: .command))
    let searchReady = expectation(description: "Toolbar installed the field editor")
    DispatchQueue.main.async { searchReady.fulfill() }
    wait(for: [searchReady], timeout: 1)
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
  private func reply(_ controller: NativePanelController, _ request: [String: Any], data: Any, error: String? = nil) {
    var response: [String: Any] = ["session": 42, "data": data]
    response["id"] = request["id"]
    response["error"] = error
    controller.bridge.receive(response)
  }
  private func ref(_ hash: String) -> [String: Any] {
    ["hash": hash, "itemType": "Text", "time": 1, "label": 0, "appSource": "", "titleColor": ""]
  }
  private func queueState(epoch: UInt64) -> [String: Any] {
    ["session": 42, "event": "paste-queue-state", "active": true, "revision": epoch,
     "activationEpoch": epoch, "selectedHashes": [String](), "selectionRevision": epoch,
     "selectionBusy": false]
  }
  private func card(_ hash: String) -> [String: Any] {
    ["hash": hash, "itemType": "Text", "text": hash, "source": "", "sourceIcon": "",
     "remote": false, "time": 1, "color": "", "favorite": false, "tags": [], "assetPath": "",
     "animationPath": "", "dimensions": "", "mediaWidth": 0, "mediaHeight": 0, "displayTitle": "",
     "displaySubtitle": "", "displaySymbol": "", "fileFormat": "", "isGif": false, "rich": [],
     "exportImage": false]
  }
  private func page(_ hash: String?) -> [String: Any] {
    ["token": ["viewId": "new", "revision": 1], "pageIndex": 0, "startIndex": 0,
     "items": hash.map { [ref($0)] } ?? [], "knownCount": hash == nil ? 0 : 1, "hasMore": false]
  }
  private func key(_ code: UInt16, characters: String, window: NSWindow, flags: NSEvent.ModifierFlags = [],
    repeating: Bool = false) throws -> NSEvent {
    try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
      windowNumber: window.windowNumber, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: repeating, keyCode: code))
  }
  private func allViews(_ root: NSView) -> [NSView] { [root] + root.subviews.flatMap(allViews) }
}
