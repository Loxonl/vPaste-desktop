import AppKit
import XCTest

@MainActor
final class NativePanelTabEditorTests: XCTestCase {
  func testEmojiButtonAppearsLeftOfNameForBothTagKinds() throws {
    _ = NSApplication.shared
    let screen = try XCTUnwrap(NSScreen.main)
    let parent = NSWindow(contentRect: NSRect(x: 40, y: 80, width: 300, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    parent.isReleasedWhenClosed = false
    defer { parent.close() }
    for kind in ["record", "filter"] {
      let data = try decode(#"{"kind":"\#(kind)","name":"Notes","emojis":["📌"]}"#)
      let editor = PanelTabEditor(data: data, chinese: false, onSave: { _ in }, onCancel: {})
      defer { editor.close() }
      editor.show(parent: parent, anchor: NSPoint(x: screen.visibleFrame.midX, y: screen.visibleFrame.midY))
      let child = try XCTUnwrap(parent.childWindows?.first as? NSPanel)
      let content = try XCTUnwrap(child.contentView)
      content.layoutSubtreeIfNeeded()
      let views = descendants(content)
      let button = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.accessibilityLabel() == "Emoji prefix" })
      let field = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Name" })
      XCTAssertLessThanOrEqual(button.convert(button.bounds, to: content).maxX,
        field.convert(field.bounds, to: content).minX, kind)
    }
  }

  func testEmojiSearchMatchesCatalogNamesAndGlyphsInOriginalOrder() {
    let emojis = ["❤️", "📌", "📝", "🌟"]
    XCTAssertEqual(PanelEmojiPicker.matches(emojis, query: "  "), emojis)
    XCTAssertEqual(PanelEmojiPicker.matches(emojis, query: "  pUsh PIN "), ["📌"])
    XCTAssertEqual(PanelEmojiPicker.matches(emojis, query: "爱心"), ["❤️"])
    XCTAssertEqual(PanelEmojiPicker.matches(emojis, query: "📝"), ["📝"])
    XCTAssertEqual(PanelEmojiPicker.matches(emojis, query: "no results"), [])
  }

  func testFocusLossNeverDismissesAnOpenEditor() {
    XCTAssertFalse(PanelTabEditorWindow.allowsParentBlur(editorOpen: true, applicationActive: false, parentKey: false))
    XCTAssertFalse(PanelTabEditorWindow.allowsParentBlur(editorOpen: true, applicationActive: true, parentKey: false))
    XCTAssertTrue(PanelTabEditorWindow.allowsParentBlur(editorOpen: false, applicationActive: false, parentKey: true))
    XCTAssertTrue(PanelTabEditorWindow.allowsParentBlur(editorOpen: false, applicationActive: true, parentKey: false))
    XCTAssertFalse(PanelTabEditorWindow.allowsParentBlur(editorOpen: false, applicationActive: true, parentKey: true))
  }

  func testFilterDefaultsAndRecordPayload() throws {
    let filter = try decode(#"{"kind":"filter","name":""}"#)
    let draft = try filter.payload(name: "  ", filter: nil, chinese: false)
    XCTAssertEqual(draft["name"] as? String, "Add Tab")
    XCTAssertEqual(draft["filter"] as? NSDictionary, [
      "itemType": "", "appSources": [], "favorite": "any", "relativeAmount": "", "relativeUnit": "day",
    ] as NSDictionary)

    let record = try decode(#"{"kind":"record","name":"Last week"}"#)
    XCTAssertThrowsError(try record.payload(name: " \n ", filter: nil, chinese: false))
    let recordDraft = try record.payload(name: "  Research  ", filter: nil, chinese: false)
    XCTAssertEqual(recordDraft["name"] as? String, "Research")
    XCTAssertNil(recordDraft["filter"])
  }

  func testFallbackPrecedenceAndLocalization() throws {
    let data = try decode(#"{"kind":"filter","name":""}"#)
    let filters: [(PanelTabEditorData.Filter, String, String)] = [
      (.init(itemType: "Text", appSources: ["An application with a long name"], favorite: "yes",
        relativeAmount: "2", relativeUnit: "week"), "An application with a long name", "An application with a long name"),
      (.init(itemType: "Text", appSources: ["Safari", "Mail"], favorite: "yes",
        relativeAmount: "2", relativeUnit: "week"), "2 apps selected", "已选择 2 个应用"),
      (.init(itemType: "Text", appSources: [], favorite: "yes", relativeAmount: "2", relativeUnit: "week"),
        "Text", "文本"),
      (.init(itemType: "", appSources: [], favorite: "no", relativeAmount: "2", relativeUnit: "week"),
        "Not favorite", "未收藏"),
      (.init(itemType: "", appSources: [], favorite: "any", relativeAmount: "2", relativeUnit: "week"),
        "Recent 2 Weeks", "最近2周"),
    ]
    for (filter, english, chinese) in filters {
      XCTAssertEqual(try data.payload(name: "", filter: filter, chinese: false)["name"] as? String, english)
      XCTAssertEqual(try data.payload(name: "", filter: filter, chinese: true)["name"] as? String, chinese)
    }
  }

  func testLegacyNameAndRelativeAmountCanBePreservedButEditsAreValidated() throws {
    let original = String(repeating: "a", count: 30)
    let data = try decode("""
      {"kind":"filter","name":"\(original)","filter":{"itemType":"","appSources":[],"favorite":"any",
      "relativeAmount":"1.5","relativeUnit":"day"}}
      """)
    XCTAssertEqual(try data.payload(name: original, filter: nil, chinese: false)["name"] as? String, original)
    XCTAssertNoThrow(try data.payload(name: String(repeating: "😀", count: 10), filter: nil, chinese: false))
    XCTAssertThrowsError(try data.payload(name: String(repeating: "😀", count: 11), filter: nil, chinese: false))
    for amount in ["0", "-2", "1.25", "1e3", "18446744073709551616"] {
      XCTAssertThrowsError(try data.payload(name: original, filter: relative(amount), chinese: false))
    }
    for amount in ["", "2", "1.5"] {
      let draft = try data.payload(name: original, filter: relative(amount), chinese: false)
      XCTAssertEqual((draft["filter"] as? [String: Any])?["relativeAmount"] as? String, amount)
    }
  }

  func testSourceChoicesAndCatalogPrefixes() throws {
    let data = try decode("""
      {"kind":"filter","name":"❤️ Notes","filter":{"itemType":"","appSources":["Old App","Safari"],
      "favorite":"any","relativeAmount":"","relativeUnit":"day"},"sourcesUnavailable":true,
      "sources":[{"source":"Safari","icon_path":"/tmp/safari.png"},{"source":"Mail","icon_path":""}],
      "emojis":["❤","❤️","📌"]}
      """)
    XCTAssertEqual(data.sourceChoices, ["Safari", "Mail", "Old App"])
    XCTAssertEqual(data.sources?.first?.icon_path, "/tmp/safari.png")
    XCTAssertEqual(data.sourcesUnavailable, true)
    XCTAssertEqual(data.selectedEmoji(in: data.name), "❤️")
    XCTAssertEqual(data.applyingEmoji("📌", to: data.name), "📌 Notes")
    XCTAssertEqual(data.applyingEmoji("", to: data.name), "Notes")
    XCTAssertEqual(data.applyingEmoji("❌", to: data.name), data.name)
    XCTAssertEqual(data.applyingEmoji("📌", to: "📚 Notes"), "📌 📚 Notes")
  }

  func testSourceIdentityAndEmojiMatchingAreExact() throws {
    let data = try decode("""
      {"kind":"filter","name":"","sources":[{"source":"Café"},{"source":"Cafe\u{301}"}],
      "emojis":["❤️","📌"]}
      """)
    XCTAssertEqual(data.sourceChoices.map { Array($0.utf8) }, [Array("Café".utf8), Array("Cafe\u{301}".utf8)])
    XCTAssertEqual(data.selectedEmoji(in: "❤️‍🔥 Notes"), "")
    XCTAssertEqual(data.applyingEmoji("", to: "❤️‍🔥 Notes"), "❤️‍🔥 Notes")
  }

  func testNewRelativeAmountDoesNotSendArbitrarilyLongZeroPadding() throws {
    let data = try decode(#"{"kind":"filter","name":""}"#)
    let draft = try data.payload(name: "Example", filter: relative(String(repeating: "0", count: 65_536) + "2"), chinese: false)
    XCTAssertEqual((draft["filter"] as? [String: Any])?["relativeAmount"] as? String, "2")
  }

  func testShortcutPolicyLeavesCompositionAndPlainReturnAlone() {
    XCTAssertEqual(PanelTabEditorWindow.shortcut(keyCode: 53, modifiers: [], composing: false), .cancel)
    XCTAssertEqual(PanelTabEditorWindow.shortcut(keyCode: 36, modifiers: .command, composing: false), .save)
    XCTAssertEqual(PanelTabEditorWindow.shortcut(keyCode: 76, modifiers: .control, composing: false), .save)
    XCTAssertNil(PanelTabEditorWindow.shortcut(keyCode: 36, modifiers: [], composing: false))
    XCTAssertNil(PanelTabEditorWindow.shortcut(keyCode: 53, modifiers: [], composing: true))
    XCTAssertNil(PanelTabEditorWindow.shortcut(keyCode: 36, modifiers: .command, composing: true))
  }

  func testAnchoringStaysOnScreenAndFlipsAtBottom() {
    let visible = NSRect(x: -900, y: 100, width: 900, height: 700)
    let size = NSSize(width: 300, height: 250)
    let below = PanelTabEditorWindow.anchoredFrame(size: size, at: NSPoint(x: -400, y: 500), in: visible)
    XCTAssertEqual(below.minX, -400)
    XCTAssertLessThan(below.maxY, 500)
    let above = PanelTabEditorWindow.anchoredFrame(size: size, at: NSPoint(x: -20, y: 120), in: visible)
    XCTAssertGreaterThan(above.minY, 120)
    XCTAssertTrue(visible.contains(above))
    let small = NSRect(x: -640, y: 75, width: 640, height: 405)
    XCTAssertTrue(small.contains(PanelTabEditorWindow.anchoredFrame(
      size: NSSize(width: 316, height: 490), at: NSPoint(x: -100, y: 200), in: small)))
  }

  func testPanelOwnsFocusRetainsDraftOnErrorAndClosesWithoutCallingCancel() throws {
    _ = NSApplication.shared
    let screen = try XCTUnwrap(NSScreen.main)
    let parent = NSWindow(contentRect: NSRect(x: 40, y: 80, width: 300, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    parent.isReleasedWhenClosed = false
    parent.orderFront(nil)
    defer { parent.close() }
    var drafts: [[String: Any]] = []
    var cancellationCount = 0
    let editor = PanelTabEditor(data: try decode(#"{"kind":"record","name":"Original"}"#),
      chinese: false, onSave: { drafts.append($0) }, onCancel: { cancellationCount += 1 })
    defer { editor.close() }
    editor.show(parent: parent, anchor: NSPoint(x: screen.visibleFrame.midX, y: screen.visibleFrame.midY))
    let child = try XCTUnwrap(parent.childWindows?.first as? NSPanel)
    XCTAssertTrue(screen.visibleFrame.contains(child.frame))
    let views = descendants(try XCTUnwrap(child.contentView))
    let name = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.isEditable })
    let save = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Save" })
    let cancel = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Cancel" })
    XCTAssertTrue(child.firstResponder === name.currentEditor())
    let fieldEditor = try XCTUnwrap(name.currentEditor() as? NSTextView)
    fieldEditor.string = "Updated"
    child.sendEvent(try keyEvent(36, flags: [], in: child))
    child.sendEvent(try keyEvent(36, flags: .command, in: child))
    XCTAssertEqual(drafts.count, 1)
    XCTAssertEqual(drafts.first?["name"] as? String, "Updated")
    XCTAssertFalse(save.isEnabled)
    child.sendEvent(try keyEvent(53, flags: [], in: child))
    XCTAssertEqual(cancellationCount, 0)

    editor.reportError("Please retry")
    XCTAssertTrue(save.isEnabled)
    XCTAssertEqual(name.stringValue, "Updated")
    save.performClick(nil)
    XCTAssertEqual(drafts.count, 2)
    editor.reportError("Please retry")
    child.sendEvent(try keyEvent(53, flags: [], in: child))
    cancel.performClick(nil)
    XCTAssertEqual(cancellationCount, 1)
    editor.close()
    XCTAssertEqual(cancellationCount, 1)
    XCTAssertTrue(parent.childWindows?.isEmpty ?? true)
    XCTAssertFalse(editor.isKeyWindow)
  }

  func testWindowDoesNotSubmitOrCancelFromMarkedText() throws {
    _ = NSApplication.shared
    let parent = NSWindow(contentRect: NSRect(x: 40, y: 80, width: 300, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    parent.isReleasedWhenClosed = false
    defer { parent.close() }
    var eventCount = 0
    let editor = PanelTabEditor(data: try decode(#"{"kind":"record","name":"Original"}"#),
      chinese: false, onSave: { _ in eventCount += 1 }, onCancel: { eventCount += 1 })
    defer { editor.close() }
    editor.show(parent: parent, anchor: .zero)
    let child = try XCTUnwrap(parent.childWindows?.first)
    let input = try XCTUnwrap(child.firstResponder as? NSTextView)
    for (keyCode, modifiers): (UInt16, NSEvent.ModifierFlags) in [(53, []), (36, .command), (36, .control)] {
      input.setMarkedText("仮", selectedRange: NSRange(location: 0, length: 1),
        replacementRange: NSRange(location: NSNotFound, length: 0))
      XCTAssertTrue(input.hasMarkedText())
      child.sendEvent(try keyEvent(keyCode, flags: modifiers, in: child))
      XCTAssertEqual(eventCount, 0)
      input.unmarkText()
    }
  }

  func testFilterControlsSubmitEditedEmojiAndKeepUnchangedLegacySources() throws {
    _ = NSApplication.shared
    let screen = try XCTUnwrap(NSScreen.main)
    let parent = NSWindow(contentRect: NSRect(x: 40, y: 80, width: 300, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    parent.isReleasedWhenClosed = false
    defer { parent.close() }
    let data = try decode("""
      {"kind":"filter","name":"❤️ Notes","filter":{"itemType":"","appSources":["Old App"],
      "favorite":"yes","relativeAmount":"1.5","relativeUnit":"day"},"sourcesUnavailable":true,
      "sources":[{"source":"Safari"},{"source":"Mail"},{"source":"Notes"},{"source":"Finder"},{"source":"Music"}],
      "emojis":["❤️","📌"]}
      """)
    var draft: [String: Any]?
    let editor = PanelTabEditor(data: data, chinese: false, onSave: { draft = $0 }, onCancel: {})
    // Tests drive each action synchronously; production uses system animation.
    editor.sourcePopover.animates = false
    editor.emojiPopover.animates = false
    defer { editor.close() }
    editor.show(parent: parent, anchor: NSPoint(x: screen.visibleFrame.midX, y: screen.visibleFrame.midY))
    let child = try XCTUnwrap(parent.childWindows?.first as? NSPanel)
    let content = try XCTUnwrap(child.contentView)
    content.layoutSubtreeIfNeeded()
    let views = descendants(content)
    XCTAssertFalse(views.contains { $0 is NSScrollView }, "The source list must not expand the form")
    let pickers = views.compactMap { $0 as? NSPopUpButton }
    let type = try XCTUnwrap(pickers.first { $0.accessibilityLabel() == "Type" })
    let favorite = try XCTUnwrap(pickers.first { $0.accessibilityLabel() == "Favorite State" })
    XCTAssertEqual(type.convert(type.bounds, to: content).midY,
      favorite.convert(favorite.bounds, to: content).midY, accuracy: 1)
    XCTAssertLessThan(type.convert(type.bounds, to: content).maxX,
      favorite.convert(favorite.bounds, to: content).minX)
    let sourceButton = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.accessibilityLabel() == "Source app" })
    XCTAssertEqual(sourceButton.title, "Old App")
    sourceButton.performClick(nil)
    let sourcePicker = try XCTUnwrap(editor.sourcePopover.contentViewController)
    let sourceSearch = try XCTUnwrap(descendants(sourcePicker.view).compactMap { $0 as? NSSearchField }.first)
    let sourceInput = try XCTUnwrap(sourceSearch.currentEditor() as? NSTextView)
    func sourceRow(_ title: String) -> NSButton? {
      descendants(sourcePicker.view).compactMap { $0 as? NSButton }.first { $0.title == title }
    }
    XCTAssertEqual(sourceRow("Old App (Not recent)")?.state, .on)
    try XCTUnwrap(sourceRow("Any app")).performClick(nil)
    XCTAssertEqual(sourceButton.title, "Any")
    XCTAssertEqual(sourceRow("Any app")?.state, .on)
    XCTAssertEqual(sourceRow("Old App (Not recent)")?.state, .off)
    try XCTUnwrap(sourceRow("Old App (Not recent)")).performClick(nil)
    sourceInput.insertText("sAfArI", replacementRange: NSRange(location: 0, length: 0))
    XCTAssertNil(sourceRow("Mail"))
    try XCTUnwrap(sourceRow("Safari")).performClick(nil)
    XCTAssertEqual(sourceButton.title, "2 apps selected")
    XCTAssertTrue(editor.sourcePopover.isShown)
    let sourceWindow = try XCTUnwrap(sourceSearch.window)
    sourceWindow.sendEvent(try keyEvent(53, flags: [], in: sourceWindow))
    XCTAssertFalse(editor.sourcePopover.isShown)
    XCTAssertTrue(child.isVisible)
    let emoji = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.accessibilityLabel() == "Emoji prefix" })
    XCTAssertFalse(emoji is NSPopUpButton)
    XCTAssertEqual(emoji.title, "❤️")
    let nameField = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Name" })
    XCTAssertEqual(nameField.stringValue, "Notes", "The picker button is the only place showing the prefix")
    emoji.performClick(nil)
    XCTAssertTrue(editor.emojiPopover.isShown)
    let picker = try XCTUnwrap(editor.emojiPopover.contentViewController)
    let pickerViews = descendants(picker.view)
    let search = try XCTUnwrap(pickerViews.compactMap { $0 as? NSSearchField }.first)
    let searchWindow = try XCTUnwrap(search.window)
    let fieldEditor = try XCTUnwrap(search.currentEditor() as? NSTextView)
    XCTAssertTrue(searchWindow.firstResponder === fieldEditor)
    let pickerDelegate = try XCTUnwrap(search.delegate)
    let icons = pickerViews.compactMap { $0 as? NSButton }
    let clear = try XCTUnwrap(icons.first { $0.title == "No emoji" })
    XCTAssertEqual(pickerDelegate.control?(search, textView: fieldEditor, doCommandBy: #selector(NSResponder.insertTab(_:))), true)
    XCTAssertTrue(searchWindow.firstResponder === clear)
    XCTAssertTrue(searchWindow.makeFirstResponder(search))
    let focusedEditor = try XCTUnwrap(search.currentEditor() as? NSTextView)
    XCTAssertEqual(pickerDelegate.control?(search, textView: focusedEditor, doCommandBy: #selector(NSResponder.insertBacktab(_:))), true)
    XCTAssertTrue(searchWindow.firstResponder === icons.last)
    XCTAssertTrue(searchWindow.makeFirstResponder(search))
    XCTAssertEqual(icons.first { $0.title == "❤️" }?.state, .on)
    XCTAssertNotNil(icons.first { $0.title == "📌" })
    let input = try XCTUnwrap(search.currentEditor() as? NSTextView)
    input.insertText("图钉", replacementRange: NSRange(location: 0, length: 0))
    let matches = descendants(picker.view).compactMap { $0 as? NSButton }
    XCTAssertNil(matches.first { $0.title == "❤️" })
    try XCTUnwrap(matches.first { $0.title == "📌" }).performClick(nil)
    XCTAssertFalse(editor.emojiPopover.isShown)
    XCTAssertEqual(emoji.title, "📌")
    emoji.performClick(nil)
    let reopened = try XCTUnwrap(editor.emojiPopover.contentViewController)
    let nextSearch = try XCTUnwrap(descendants(reopened.view).compactMap { $0 as? NSSearchField }.first)
    let nextInput = try XCTUnwrap(nextSearch.currentEditor() as? NSTextView)
    XCTAssertEqual(nextInput.string, "")
    let pickerWindow = try XCTUnwrap(nextSearch.window)
    pickerWindow.sendEvent(try keyEvent(53, flags: [], in: pickerWindow))
    XCTAssertFalse(editor.emojiPopover.isShown)
    XCTAssertTrue(child.isVisible)
    XCTAssertEqual(emoji.title, "📌")
    let save = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Save" })
    XCTAssertTrue(content.bounds.contains(save.convert(save.bounds, to: content)))
    save.performClick(nil)
    XCTAssertEqual(draft?["name"] as? String, "📌 Notes")
    XCTAssertEqual(draft?["filter"] as? NSDictionary, [
      "itemType": "", "appSources": ["Old App", "Safari"], "favorite": "yes", "relativeAmount": "1.5", "relativeUnit": "day",
    ] as NSDictionary)
  }

  func testSourceIconsInRowsAndSelectedSummary() throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let icon = directory.appendingPathComponent("icon.png")
    let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 16,
      pixelsHigh: 16, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
    for y in 0..<16 {
      for x in 0..<16 { bitmap.setColor(.magenta, atX: x, y: y) }
    }
    try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: icon)
    let parent = NSWindow(contentRect: NSRect(x: 40, y: 80, width: 300, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    parent.isReleasedWhenClosed = false
    defer { parent.close() }
    let filter = PanelTabEditorData.Filter(itemType: "", appSources: ["Safari", "Mail", "Notes"],
      favorite: "any", relativeAmount: "", relativeUnit: "day")
    let data = PanelTabEditorData(kind: .filter, name: "Apps", filter: filter, sources: [
      .init(source: "Safari", icon_path: icon.path), .init(source: "Mail", icon_path: icon.path),
      .init(source: "Notes", icon_path: icon.path), .init(source: "Missing", icon_path: icon.path + ".missing"),
    ], emojis: nil, sourcesUnavailable: nil)
    let editor = PanelTabEditor(data: data, chinese: false, onSave: { _ in }, onCancel: {})
    editor.sourcePopover.animates = false
    defer { editor.close() }
    editor.show(parent: parent, anchor: NSPoint(x: 200, y: 400))
    let child = try XCTUnwrap(parent.childWindows?.first)
    let trigger = try XCTUnwrap(descendants(try XCTUnwrap(child.contentView)).compactMap { $0 as? NSButton }
      .first { $0.accessibilityLabel() == "Source app" })
    trigger.performClick(nil)
    let pickerView = try XCTUnwrap(editor.sourcePopover.contentViewController).view
    let choices = descendants(pickerView).compactMap { $0 as? NSButton }
    let row = try XCTUnwrap(choices.first { $0.accessibilityLabel() == "Safari" })
    let missing = try XCTUnwrap(choices.first { $0.title == "Missing" })
    func iconViews(_ button: NSButton) -> [NSImageView] {
      button.subviews.compactMap { $0 as? PanelSourceIconLabel }
        .flatMap { $0.arrangedSubviews.compactMap { $0 as? NSImageView } }
    }
    let deadline = Date().addingTimeInterval(2)
    while (iconViews(trigger).count < 2 || iconViews(row).count == 0) && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    XCTAssertEqual(iconViews(trigger).count, 2)
    XCTAssertEqual(iconViews(row).count, 1)
    XCTAssertEqual(iconViews(missing).count, 0)
    for button in [row, trigger] {
      button.layoutSubtreeIfNeeded()
      for icon in iconViews(button) {
        XCTAssertNotNil(icon.image)
        XCTAssertFalse(icon.bounds.isEmpty)
        XCTAssertTrue(button.bounds.contains(icon.convert(icon.bounds, to: button)))
      }
    }
    XCTAssertEqual(missing.title, "Missing")
    XCTAssertEqual(row.state, .on)
    try XCTUnwrap(choices.first { $0.title == "Any app" }).performClick(nil)
    XCTAssertEqual(iconViews(trigger).count, 0)
    XCTAssertEqual(trigger.title, "Any")
  }

  private func keyEvent(_ keyCode: UInt16, flags: NSEvent.ModifierFlags, in child: NSWindow) throws -> NSEvent {
    let characters = keyCode == 53 ? "\u{1b}" : "\r"
    return try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
      modifierFlags: flags, timestamp: 0, windowNumber: child.windowNumber, context: nil,
      characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode))
  }

  private func descendants(_ view: NSView) -> [NSView] {
    [view] + view.subviews.flatMap(descendants)
  }

  private func decode(_ json: String) throws -> PanelTabEditorData {
    try JSONDecoder().decode(PanelTabEditorData.self, from: Data(json.utf8))
  }

  private func relative(_ amount: String) -> PanelTabEditorData.Filter {
    .init(itemType: "", appSources: [], favorite: "any", relativeAmount: amount, relativeUnit: "day")
  }
}
