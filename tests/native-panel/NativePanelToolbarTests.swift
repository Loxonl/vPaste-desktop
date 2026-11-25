import AppKit
import CoreText
import XCTest

@MainActor
final class NativePanelToolbarTests: XCTestCase {
  func testDeveloperToolsKeepMacTutorialAndExistingDiagnostics() {
    let tools = PanelDeveloperTools(scale: 1, chinese: false)
    XCTAssertEqual(Set(tools.actions.map { $0.id }), Set([
      "tutorial-mac", "language", "theme", "test-room", "memory",
      "native-panel", "ui-lab", "refresh", "diagnostics",
    ]))
    var received: [String] = []
    tools.onAction = { received.append($0) }
    tools.perform("memory")
    tools.perform("unknown")
    tools.perform("tutorial-windows")
    XCTAssertEqual(received, ["memory"])
    tools.releaseContent()
    tools.perform("test-room")
    XCTAssertEqual(received, ["memory"], "Closing the panel releases action callbacks")
  }

  func testDeveloperToolsCollapseAndOverflowLeaveSpaceForSearchAndTabs() {
    let tools = PanelDeveloperTools(scale: 1, chinese: false)
    tools.expanded = true
    XCTAssertEqual(tools.width(toolbarWidth: 1440, searching: true), PanelDeveloperTools.fullWidth)
    XCTAssertEqual(tools.width(toolbarWidth: 720, searching: true), PanelDeveloperTools.menuWidth)
    tools.expanded = false
    XCTAssertEqual(tools.width(toolbarWidth: 1440, searching: false), 28)
    tools.expanded = true
    let view = PanelDeveloperToolbar(tools: tools)
    view.frame = NSRect(x: 0, y: 0, width: PanelDeveloperTools.fullWidth, height: 32)
    view.layoutSubtreeIfNeeded()
    let buttons = view.subviews.flatMap { [$0] + $0.subviews }.compactMap { $0 as? NSButton }
    XCTAssertEqual(buttons.count, 11)
    XCTAssertTrue(buttons.allSatisfy { !$0.acceptsFirstResponder }, "DEV buttons must not join Tab focus navigation")
  }

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

  func testFullyClippedCursorRegionDoesNotRegisterAnInfiniteRectangle() {
    let region = RecordingCursorRegion(cursor: .pointingHand)
    region.frame = NSRect(x: 0, y: 0, width: 28, height: 28)
    region.clippedRect = NSRect(x: 100, y: 100, width: 28, height: 28)
    region.resetCursorRects()
    XCTAssertTrue(region.registered.isEmpty)
    region.updateTrackingAreas()
    XCTAssertTrue(region.trackingAreas.isEmpty)
  }

  func testClippedNativeButtonsDoNotRegisterPointerRegionsOutsideTheirBounds() {
    let button = RecordingPointerButton(frame: NSRect(x: 0, y: 0, width: 80, height: 28))
    button.clippedRect = NSRect(x: 100, y: 0, width: 80, height: 28)
    button.resetCursorRects()
    XCTAssertTrue(button.registered.isEmpty)
    button.clippedRect = NSRect(x: 50, y: 0, width: 80, height: 28)
    button.registered.removeAll()
    button.resetCursorRects()
    XCTAssertEqual(button.registered.first?.0, NSRect(x: 50, y: 0, width: 30, height: 28))
  }

  private final class RecordingCursor: NSCursor {
    private(set) var setCount = 0
    override func set() { setCount += 1 }
  }
  private final class RecordingCursorRegion: PanelCursorRegion {
    var registered: [(NSRect, NSCursor)] = []
    var clippedRect: NSRect?
    override var visibleRect: NSRect { clippedRect ?? super.visibleRect }
    override func addCursorRect(_ rect: NSRect, cursor: NSCursor) { registered.append((rect, cursor)) }
  }
  private final class RecordingPointerButton: PanelPointerButton {
    var registered: [(NSRect, NSCursor)] = []
    var clippedRect: NSRect?
    override var visibleRect: NSRect { clippedRect ?? super.visibleRect }
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

  func testFiltersUseNativeToggleButtonsOnOneSharedGlassSurface() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1000, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    toolbar.setTabs([
      PanelTab(id: "text", name: "📝 Text", label: "Text", record: false),
      PanelTab(id: "record:9", name: "Home", label: "record", record: true),
    ])
    defer { toolbar.releaseContent() }
    toolbar.layoutSubtreeIfNeeded()
    let control = try XCTUnwrap(descendants(of: toolbar).compactMap { $0 as? PanelFilterControl }.first)
    XCTAssertEqual(tabTitles(in: control), ["All", "Favorites", "📝 Text", "Home"])
    XCTAssertEqual(selectedIndices(in: control), [0])
    #if VPASTE_LIQUID_GLASS_SDK
      if #available(macOS 26.0, *) {
        let glass = try XCTUnwrap(control.subviews.first as? NSGlassEffectView)
        XCTAssertEqual(glass.style, .regular)
        let row = try XCTUnwrap(glass.contentView)
        XCTAssertEqual(control.buttons.count, 4)
        for button in control.buttons {
          XCTAssertTrue(button.superview === row)
          XCTAssertEqual(button.bezelStyle, .accessoryBar)
          XCTAssertTrue(button.showsBorderOnlyWhileMouseInside)
          XCTAssertEqual(button.tintProminence, .none)
        }
        XCTAssertEqual(try XCTUnwrap(control.buttons.first).bezelColor, NSColor(white: 0.5, alpha: 0.4))
        return
      }
    #endif
    XCTAssertEqual(control.buttons.count, 4)
  }

  @available(macOS 12.0, *)
  func testNativeAccessibilityExposesOneRadioPerCategory() throws {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    state.setTabs([PanelTab(id: "a", name: "📝 Text", label: "Text", record: false)])
    let control = PanelFilterControl(state: state)
    let window = NSWindow(contentRect: control.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = control
    defer { control.releaseContent(); state.close(); window.contentView = nil }
    func checkSelection(_ selected: Int) throws {
      XCTAssertEqual(control.accessibilityRole(), .radioGroup)
      XCTAssertEqual(control.accessibilityLabel(), "History filters")
      let children = try XCTUnwrap(control.accessibilityChildren())
      XCTAssertEqual(children.count, 3)
      for (index, child) in children.enumerated() {
        let element = try XCTUnwrap(child as? NSAccessibilityProtocol)
        XCTAssertEqual(element.accessibilityRole(), .radioButton)
        XCTAssertEqual(element.accessibilityLabel(), state.choices[index].title)
        XCTAssertEqual((element.accessibilityValue() as? NSNumber)?.intValue, index == selected ? 1 : 0)
        XCTAssertFalse((element.accessibilityChildren() ?? []).contains {
          ($0 as? NSAccessibilityProtocol)?.accessibilityRole() == .radioButton
        }, "Each category must be exposed only once")
      }
    }
    try checkSelection(0)
    sendFilterAction(2, in: control)
    try checkSelection(2)
  }

  func testToolbarGlassStaysOutsideTheBackdropMaterialOnTheSameAnimationSurface() throws {
    _ = NSApplication.shared
    for scale in [0.8, 0.9, 1.0] {
      let config = try JSONDecoder().decode(PanelConfiguration.self, from: Data("""
        {"session":1,"sizePreview":false,"language":"English","theme":"light","scale":\(scale),
         "mousePasteMode":"double","hoverPreviewEnabled":false,"tabQuickSelectEnabled":true,
         "panelHeight":302,"horizontalBleed":0,"showDuration":0.15,"hideDuration":0.2,
         "showCurve":[0.2,0.8,0.2,1],"hideCurve":[0.2,0.8,0.2,1]}
        """.utf8))
      let callbacks = VPastePanelCallbacks(abi_version: 1, request: { _, _ in }, set_key: { _ in })
      let controller = NativePanelController(callbacks: callbacks, config: config)
      defer { controller.dismiss(animated: false) }
      let window = try XCTUnwrap(NSApp.windows.first { $0.delegate === controller })
      let root = try XCTUnwrap(window.contentView)
      root.layoutSubtreeIfNeeded()
      let backdrop = try XCTUnwrap(descendants(of: root).compactMap { $0 as? PanelBackdrop }.first)
      let toolbar = try XCTUnwrap(descendants(of: root).compactMap { $0 as? PanelToolbar }.first)
      XCTAssertTrue(toolbar.superview === backdrop,
        "Native control glass must not be flattened inside the window's glass contentView")
      XCTAssertFalse(toolbar.isDescendant(of: backdrop.contentView))
      let height = (48 * scale * window.backingScaleFactor).rounded() / window.backingScaleFactor
      XCTAssertEqual(toolbar.frame.height, height, accuracy: 0.01)
      XCTAssertEqual(toolbar.convert(toolbar.bounds, to: backdrop).maxY, backdrop.bounds.maxY, accuracy: 0.01)
      XCTAssertEqual(toolbar.frame.width, backdrop.bounds.width, accuracy: 0.01)
      let material = try XCTUnwrap(backdrop.subviews.first)
      XCTAssertEqual(material.frame, backdrop.bounds,
        "The shared page background must remain intact beneath the toolbar")
      XCTAssertEqual(backdrop.contentView.convert(backdrop.contentView.bounds, to: backdrop), backdrop.bounds,
        "Removing a toolbar backplate must not crop the main page tint")
    }
  }

  @available(macOS 12.0, *)
  func testGlassToolbarLeavesItsEmptyNavigationAreaTransparent() throws {
    guard PanelToolbarMaterial.liquidGlass else { throw XCTSkip("The older toolbar retains its fallback background") }
    _ = NSApplication.shared
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1920, height: 48))
    let window = NSWindow(contentRect: toolbar.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.contentView = toolbar
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    defer { toolbar.releaseContent(); window.contentView = nil }
    toolbar.layoutSubtreeIfNeeded()
    let bitmap = try XCTUnwrap(toolbar.bitmapImageRepForCachingDisplay(in: toolbar.bounds))
    toolbar.cacheDisplay(in: toolbar.bounds, to: bitmap)
    let emptyArea = try XCTUnwrap(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2))
    XCTAssertEqual(emptyArea.alphaComponent, 0, accuracy: 0.01,
      "With only the fixed tabs, the empty navigation area must not paint a separate backplate")
  }

  @available(macOS 12.0, *)
  func testGlassTabViewportFadesWithoutExtendingTheInputArea() throws {
    guard PanelToolbarMaterial.liquidGlass else { throw XCTSkip("The older toolbar uses native clipping") }
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1240, height: 48))
    let window = NSWindow(contentRect: toolbar.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = toolbar
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    toolbar.setTabs((1...12).map {
      PanelTab(id: "\($0)", name: "📌 Long category \($0)", label: "Text", record: false)
    })
    defer { toolbar.releaseContent(); window.contentView = nil }
    toolbar.layoutSubtreeIfNeeded()
    let scroll = try XCTUnwrap(filterScroll(in: toolbar))
    let surface = try XCTUnwrap(scroll.documentView as? PanelTabDragSurface)
    let control = try XCTUnwrap(descendants(of: surface).compactMap { $0 as? PanelFilterControl }.first)
    XCTAssertFalse(scroll.contentView.clipsToBounds, "Hard clipping cuts the native glass shadow at the viewport")
    let mask = try XCTUnwrap(scroll.layer?.mask as? CAGradientLayer)
    XCTAssertEqual(mask.frame.width, scroll.bounds.width)
    XCTAssertGreaterThan(mask.frame.height, scroll.bounds.height, "Leave room for native shadows above and below")

    let clippedButton = control.buttons[2]
    let tabRect = control.convert(control.tabFrames[2], to: surface)
    scroll.contentView.scroll(to: NSPoint(x: tabRect.midX.rounded(), y: 0))
    scroll.reflectScrolledClipView(scroll.contentView)
    let viewport = scroll.documentVisibleRect
    XCTAssertGreaterThan(viewport.minX, tabRect.minX)
    XCTAssertLessThan(viewport.minX, tabRect.maxX)
    XCTAssertEqual(surface.visibleRect, viewport, "Drag targets and edge scrolling must use the logical viewport")
    XCTAssertTrue(control.buttons[0].visibleRect.isEmpty)
    XCTAssertEqual(clippedButton.visibleRect,
      clippedButton.bounds.intersection(clippedButton.convert(viewport, from: surface)))
    let outside = NSPoint(x: viewport.minX - 2, y: tabRect.midY)
    let inside = NSPoint(x: viewport.minX + 12, y: tabRect.midY)
    XCTAssertNil(surface.hitTest(surface.convert(outside, to: scroll.contentView)))
    let hit = surface.hitTest(surface.convert(inside, to: scroll.contentView))
    XCTAssertEqual(hit, clippedButton)
  }

  func testBackdropReadsNavigationFirstAndIncludesNewHistoryAccessibilityChildren() {
    let backdrop = PanelBackdrop(scale: 1)
    let history = NSButton(title: "History", target: nil, action: nil)
    let navigation = NSButton(title: "Navigation", target: nil, action: nil)
    backdrop.contentView.addSubview(history)
    backdrop.addSubview(navigation)
    let labels = {
      (backdrop.accessibilityChildren() ?? []).compactMap { ($0 as? NSAccessibilityProtocol)?.accessibilityLabel() }
    }
    XCTAssertEqual(labels().first, "Navigation")
    XCTAssertTrue(labels().contains("History"))
    let added = NSButton(title: "New history", target: nil, action: nil)
    backdrop.contentView.addSubview(added)
    XCTAssertTrue(labels().contains("New history"),
      "The ordering must not cache a snapshot of history or queue accessibility elements")
  }

  func testLegacyFilterWidthsUseWebViewFontAndPaddingAtEveryPanelSize() {
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

  @available(macOS 12.0, *)
  func testNativeHoverDoesNotSelectOrRequestHistory() throws {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    let control = PanelFilterControl(state: state)
    defer { control.releaseContent(); state.close() }
    var calls: [Int] = []
    state.onFilter = { calls.append($0) }
    let event = try XCTUnwrap(NSEvent.mouseEvent(with: .mouseMoved, location: .zero,
      modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
      eventNumber: 0, clickCount: 0, pressure: 0))
    let target = control.buttons[1]
    target.mouseEntered(with: event)
    target.mouseMoved(with: event)
    target.mouseExited(with: event)
    XCTAssertEqual(state.selected, 0)
    XCTAssertEqual(selectedIndices(in: control), [0])
    XCTAssertTrue(calls.isEmpty)
  }

  @available(macOS 12.0, *)
  func testNativeSelectionAndDynamicRefreshUseOneIdentityAndCallback() {
    let state = PanelToolbarState(scale: 1, chinese: true, search: NSSearchField())
    let a = PanelTab(id: "a", name: "🧪 A very long filter 标签", label: "a-query", record: false)
    let b = PanelTab(id: "record:2", name: "📌 收藏项目", label: "b-query", record: true)
    state.setTabs([a, b])
    let control = PanelFilterControl(state: state)
    defer { control.releaseContent(); state.close() }
    var calls: [Int] = []
    state.onFilter = { calls.append($0) }
    sendFilterAction(3, in: control)
    XCTAssertEqual(state.selected, 3)
    XCTAssertEqual(calls, [3])
    XCTAssertEqual(selectedIndices(in: control), [3])
    sendFilterAction(3, in: control)
    XCTAssertEqual(selectedIndices(in: control), [3], "Clicking the selected toggle must not deselect it")
    XCTAssertEqual(calls, [3, 3])
    let stale = control.buttons[3]
    state.setTabs([b, a]); control.update()
    assertReleased(stale)
    XCTAssertEqual(selectedIndices(in: control), [2])
    XCTAssertEqual(tabTitles(in: control)[2], b.name)
    XCTAssertEqual(state.choices[state.selected].id, b.id)
    state.select(1); control.update()
    XCTAssertEqual(selectedIndices(in: control), [1])
    XCTAssertEqual(calls, [3, 3], "Shortcut-driven state restoration must not issue a second query")
    state.select(2); state.setTabs([a]); control.update()
    XCTAssertEqual(control.tabFrames.count, 3)
    XCTAssertEqual(selectedIndices(in: control), [0], "Removing the selected tag falls back to All")
  }

  @available(macOS 12.0, *)
  func testNativeLockDragAndCloseBlockActionsAndReleaseCallbacks() {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    state.setTabs([PanelTab(id: "custom", name: "📝 中文", label: "filter", record: false)])
    let control = PanelFilterControl(state: state)
    var actions = 0
    var cancelled = 0
    state.onFilter = { _ in actions += 1 }
    state.onAddTab = { actions += 1 }
    state.onTabContextMenu = { _, _ in actions += 1 }
    state.cancelTabDrag = { _ in cancelled += 1 }
    state.setNavigationLocked(true); control.update()
    XCTAssertTrue(control.buttons.allSatisfy { !$0.isEnabled })
    sendFilterAction(1, in: control)
    state.addTab(); state.contextMenu(id: "custom", at: .zero)
    XCTAssertEqual(selectedIndices(in: control), [0])
    XCTAssertEqual(actions, 0)
    XCTAssertEqual(cancelled, 1)
    state.setNavigationLocked(false); control.update()
    XCTAssertTrue(control.buttons.allSatisfy(\.isEnabled))
    state.dragging("custom")
    sendFilterAction(1, in: control)
    XCTAssertEqual(selectedIndices(in: control), [0])
    XCTAssertEqual(actions, 0)
    state.cancelInteraction()
    XCTAssertEqual(state.draggingTabID, "")
    let released = control.buttons
    state.releaseTabDrag = { control.releaseContent() }
    state.close()
    XCTAssertTrue(control.tabFrames.isEmpty)
    released.forEach { assertReleased($0) }
    state.choose(1); state.addTab()
    XCTAssertEqual(actions, 0)
  }

  @available(macOS 12.0, *)
  func testNativeTabBoundsDriveHitTestingDragAndScrollAtEveryScale() throws {
    for scale: CGFloat in [0.8, 0.9, 1] {
      let state = PanelToolbarState(scale: scale, chinese: false, search: NSSearchField())
      state.setTabs([
        PanelTab(id: "a", name: "🧪 Long 中文 filter that uses native sizing", label: "Text", record: false),
        PanelTab(id: "record:2", name: "📌 Home", label: "record", record: true),
      ])
      let control = PanelFilterControl(state: state)
      let surface = PanelTabDragSurface()
      surface.frame = NSRect(x: 0, y: 0, width: control.frame.width + 4 * scale, height: 48 * scale)
      surface.addSubview(control)
      surface.tabViews = { [weak control] in control?.draggableTabs ?? [] }
      control.setFrameOrigin(NSPoint(x: 2 * scale, y: (surface.bounds.height - control.frame.height) / 2))
      let scroll = PanelScroll(frame: NSRect(x: 0, y: 0, width: 240 * scale, height: 48 * scale))
      scroll.documentView = surface
      let window = NSWindow(contentRect: scroll.frame, styleMask: .borderless, backing: .buffered, defer: false)
      window.contentView = scroll
      defer { control.releaseContent(); surface.releaseContent(); state.close(); window.contentView = nil }
      control.layoutSubtreeIfNeeded()
      let frames = control.tabFrames
      XCTAssertEqual(frames.count, state.choices.count)
      let children = try XCTUnwrap(control.accessibilityChildren())
      XCTAssertEqual(children.count, frames.count)
      for index in frames.indices {
        let point = control.convert(NSPoint(x: frames[index].midX, y: frames[index].midY), to: surface)
        let hit = control.hitTest(point)
        let target = control.buttons[index]
        XCTAssertTrue(hit === target || hit?.isDescendant(of: target) == true)
        let radio = try XCTUnwrap(children[index] as? NSAccessibilityProtocol)
        let frame = window.convertToScreen(control.convert(frames[index], to: nil))
        XCTAssertEqual(radio.accessibilityFrame().midX, frame.midX, accuracy: 1.5)
        // AppKit can extend a button's accessibility frame by one point per side.
        XCTAssertEqual(radio.accessibilityFrame().width, frame.width, accuracy: 2.1)
        XCTAssertTrue(control.bounds.contains(frames[index]))
      }
      let dragFrames = surface.tabFrames
      XCTAssertEqual(dragFrames.map(\.id), ["a", "record:2"])
      for (dragged, frame) in zip(dragFrames, frames.dropFirst(2)) {
        let expected = control.convert(frame, to: surface)
        XCTAssertEqual(dragged.frame.minX, expected.minX, accuracy: 0.01)
        XCTAssertEqual(dragged.frame.minY, expected.minY, accuracy: 0.01)
        XCTAssertEqual(dragged.frame.width, expected.width, accuracy: 0.01)
        XCTAssertEqual(dragged.frame.height, expected.height, accuracy: 0.01)
      }
      XCTAssertGreaterThan(frames[2].width, frames[0].width, "Native sizing must accommodate the long label")
      state.select(3); control.update(); control.revealSelection()
      let selected = control.convert(control.tabFrames[3], to: surface)
      XCTAssertTrue(scroll.documentVisibleRect.insetBy(dx: -1, dy: -1).contains(selected))
    }
  }

  @available(macOS 12.0, *)
  func testNativeContextClicksKeepSelectionAndUseTheCurrentTabIdentity() throws {
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    let a = PanelTab(id: "a", name: "📝 Text", label: "text", record: false)
    let b = PanelTab(id: "record:9", name: "Home", label: "record", record: true)
    state.setTabs([a, b])
    let control = PanelFilterControl(state: state)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 48),
      styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView?.addSubview(control)
    defer { control.releaseContent(); state.close(); control.removeFromSuperview() }
    var requests: [String] = []
    var queries = 0
    state.onTabContextMenu = { id, _ in requests.append(id) }
    state.onFilter = { _ in queries += 1 }
    func contextClick(_ index: Int, controlClick: Bool = false) throws {
      let rect = control.tabFrames[index]
      let point = control.convert(NSPoint(x: rect.midX, y: rect.midY), to: nil)
      let event = try XCTUnwrap(NSEvent.mouseEvent(with: controlClick ? .leftMouseDown : .rightMouseDown,
        location: point, modifierFlags: controlClick ? .control : [], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
      let target = control.buttons[index]
      if controlClick { target.mouseDown(with: event) }
      else { target.rightMouseDown(with: event) }
    }
    try contextClick(0)
    try contextClick(3)
    try contextClick(2, controlClick: true)
    state.setTabs([b, a]); control.update()
    try contextClick(2, controlClick: true)
    XCTAssertEqual(requests, [b.id, a.id, b.id])
    XCTAssertEqual(selectedIndices(in: control), [0])
    XCTAssertEqual(queries, 0)
    state.setNavigationLocked(true); control.update()
    try contextClick(2)
    XCTAssertEqual(requests.count, 3)
  }

  @available(macOS 12.0, *)
  func testTabViewportFitsNativeTabsUntilTheAddButtonReachesItsLimit() throws {
    _ = NSApplication.shared
    for scale: CGFloat in [0.8, 0.9, 1] {
      for chinese in [false, true] {
        let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 1920, height: 48 * scale))
        let window = NSWindow(contentRect: toolbar.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = toolbar
        toolbar.configure(scale: scale, chinese: chinese, search: NSSearchField())
        defer { toolbar.releaseContent(); window.contentView = nil }
        func settle() {
          toolbar.layoutSubtreeIfNeeded()
          RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
          toolbar.layoutSubtreeIfNeeded()
        }
        settle()
        let scroll = try XCTUnwrap(filterScroll(in: toolbar))
        let control = try XCTUnwrap(descendants(of: toolbar).compactMap { $0 as? PanelFilterControl }.first)
        let developer = try XCTUnwrap(descendants(of: toolbar).compactMap { $0 as? PanelDeveloperToolbar }.first)
        func naturalWidth() -> CGFloat { control.frame.width + 4 * scale }
        func limit() -> CGFloat {
          developer.convert(developer.bounds, to: toolbar).minX
            - scroll.convert(scroll.bounds, to: toolbar).minX - 54 * scale
        }
        XCTAssertEqual(scroll.frame.width, naturalWidth(), accuracy: 0.5,
          "With few tabs, Add must follow the actual native tab extent")
        let fixedWidth = scroll.frame.width
        toolbar.setTabs([PanelTab(id: "a", name: "📝 Text", label: "Text", record: false)])
        settle()
        XCTAssertGreaterThan(scroll.frame.width, fixedWidth)
        XCTAssertEqual(scroll.frame.width, naturalWidth(), accuracy: 0.5)
        let shortWidth = scroll.frame.width
        toolbar.setTabs([PanelTab(id: "a", name: "📝 很长的标签 A much longer category", label: "Text", record: false)])
        settle()
        XCTAssertGreaterThan(scroll.frame.width, shortWidth, "Renaming must move Add using native fitting size")
        XCTAssertEqual(scroll.frame.width, naturalWidth(), accuracy: 0.5)
        toolbar.setTabs((0..<24).map {
          PanelTab(id: "overflow-\($0)", name: "📌 标签 Overflow \($0)", label: "Text", record: false)
        })
        toolbar.setSelection(25)
        settle()
        XCTAssertEqual(scroll.frame.width, limit(), accuracy: 0.5, "Overflow must stop Add at its existing right limit")
        XCTAssertGreaterThan(naturalWidth(), scroll.frame.width)
        toolbar.beginSearch()
        settle()
        XCTAssertEqual(scroll.frame.width, limit(), accuracy: 0.5, "Search must preserve the right limit")
        let selected = control.convert(try XCTUnwrap(control.tabFrames.last), to: scroll.documentView)
        XCTAssertTrue(scroll.documentVisibleRect.insetBy(dx: -1, dy: -1).contains(selected))
        toolbar.endEmptySearch()
        toolbar.setTabs([])
        settle()
        XCTAssertEqual(scroll.frame.width, fixedWidth, accuracy: 0.5, "Removing tabs must return Add to the last fixed tab")
        XCTAssertEqual(scroll.documentVisibleRect.minX, 0, accuracy: 0.5, "Shrinking must clear the old overflow offset")
      }
    }
  }

  @available(macOS 12.0, *)
  func testSearchResizeKeepsTheLastNativeTabVisible() throws {
    for scale: CGFloat in [0.8, 0.9, 1] {
      let state = PanelToolbarState(scale: scale, chinese: false, search: NSSearchField())
      state.setTabs((0..<22).map {
        PanelTab(id: "overflow-\($0)", name: "🧪 Overflow \($0) 中文", label: "Text", record: false)
      })
      state.select(state.choices.count - 1)
      let host = PanelToolbarHostingView(rootView: PanelToolbarView(state: state, tools: state.developer))
      host.frame = NSRect(x: 0, y: 0, width: 1920, height: 48 * scale)
      let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
      window.contentView = host
      defer { state.close(); window.contentView = nil }
      host.layoutSubtreeIfNeeded()
      let scroll = try XCTUnwrap(filterScroll(in: host))
      state.beginSearch()
      host.rootView = PanelToolbarView(state: state, tools: state.developer)
      host.layoutSubtreeIfNeeded()
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
      let control = try XCTUnwrap(descendants(of: host).compactMap { $0 as? PanelFilterControl }.first)
      control.requestReveal()
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
      let selected = control.convert(try XCTUnwrap(control.tabFrames.last), to: scroll.documentView)
      XCTAssertTrue(scroll.documentVisibleRect.insetBy(dx: -1, dy: -1).contains(selected),
        "Search at scale \(scale): selected \(selected), viewport \(scroll.documentVisibleRect)")
    }
  }

  @available(macOS 12.0, *)
  private func selectedIndices(in control: PanelFilterControl) -> [Int] {
    control.buttons.indices.filter { control.buttons[$0].state == .on }
  }

  @available(macOS 12.0, *)
  private func tabTitles(in control: PanelFilterControl) -> [String] {
    control.buttons.map(\.title)
  }

  @available(macOS 12.0, *)
  private func sendFilterAction(_ index: Int, in control: PanelFilterControl) {
    let button = control.buttons[index]
    button.state = button.state == .on ? .off : .on
    if let action = button.action { button.sendAction(action, to: button.target) }
  }

  @available(macOS 12.0, *)
  private func assertReleased(_ target: PanelFilterButton, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertFalse(target.isEnabled, file: file, line: line)
    XCTAssertNil(target.target, file: file, line: line)
    XCTAssertNil(target.action, file: file, line: line)
    XCTAssertNil(target.onContextMenu, file: file, line: line)
  }

  private func filterScroll(in view: NSView) -> PanelScroll? {
    if let scroll = view as? PanelScroll { return scroll }
    return view.subviews.lazy.compactMap { self.filterScroll(in: $0) }.first
  }

  func testCJKFallbackUsesTheWebViewBaseWeight() {
    // PingFang ignores the CT variation axis, so the base weight decides the
    // CJK face: 590 must not fall back to PingFang Semibold.
    XCTAssertEqual(PanelToolbarTypography.baseWeight(for: 450), .regular)
    XCTAssertEqual(PanelToolbarTypography.baseWeight(for: 590), .medium)
    XCTAssertEqual(PanelToolbarTypography.baseWeight(for: 740), .bold)
  }

  func testLegacyToolbarFontsKeepWebViewPointSizesAndVariableWeights() throws {
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

  @available(macOS 12.0, *)
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
      if view is PanelIconButton || view is PanelTabButton || view is PanelFilterButton || view is PanelFilterControl {
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
    // All and Favorites are fixed; the remaining tabs come from the user's data.
    state.setTabs(["a", "b"].map { PanelTab(id: $0, name: $0, label: $0, record: false) })
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
