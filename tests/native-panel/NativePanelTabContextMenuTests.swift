import AppKit
import XCTest

@MainActor
final class NativePanelTabContextMenuTests: XCTestCase {
  private let tabs = [
    PanelTab(id: "tab-1", name: "Text", label: "text", record: false),
    PanelTab(id: "record:9", name: "Home", label: "record", record: true),
  ]

  func testTabMenuHasOnlyEditAndDeleteInTheWebViewOrder() {
    var chosen: [PanelTabMenuAction] = []
    let handler = PanelTabMenuHandler { chosen.append($0) }
    let menu = PanelContextMenu.tabMenu(chinese: false, handler: handler)
    XCTAssertEqual(menu.items.map(\.title), ["Edit Tab", "Delete"])
    XCTAssertEqual(PanelContextMenu.tabMenu(chinese: true, handler: handler).items.map(\.title),
      ["编辑标签", "删除"])
    handler.select(menu.items[0])
    handler.select(menu.items[1])
    XCTAssertEqual(chosen, [.edit, .delete])
  }

  func testSwiftUIContextRequestUsesIdentityWithoutSelectingTheTab() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    state.setTabs(tabs)
    state.choose(2)
    var requests: [String] = []
    state.onTabContextMenu = { id, _ in requests.append(id) }
    state.setTabs(Array(tabs.reversed()))
    state.contextMenu(id: "record:9", at: .zero)
    state.contextMenu(id: "", at: .zero)
    state.contextMenu(id: "all", at: .zero)
    state.contextMenu(id: "removed", at: .zero)
    XCTAssertEqual(requests, ["record:9"])
    XCTAssertEqual(state.selected, 2)
    state.close()
    state.contextMenu(id: "record:9", at: .zero)
    XCTAssertEqual(requests, ["record:9"])
    XCTAssertNil(state.onTabContextMenu)
  }

  func testFallbackContextRequestDoesNotSelectAndKeepsIdentityAfterReordering() throws {
    let toolbar = PanelLegacyToolbar(frame: NSRect(x: 0, y: 0, width: 900, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    toolbar.setTabs(tabs)
    var requests: [String] = []
    var selections: [Int] = []
    toolbar.onTabContextMenu = { id, _ in requests.append(id) }
    toolbar.onFilter = { selections.append($0) }
    let strip = try XCTUnwrap(toolbar.subviews.compactMap { $0 as? PanelScroll }.first?.documentView)
    let event = try XCTUnwrap(NSEvent.mouseEvent(with: .rightMouseDown,
      location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
      context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    let buttons = strip.subviews.compactMap { $0 as? PanelTabButton }
    buttons[0].rightMouseDown(with: event)
    buttons[3].rightMouseDown(with: event)
    toolbar.setTabs(Array(tabs.reversed()))
    let reordered = strip.subviews.compactMap { $0 as? PanelTabButton }
    reordered[2].rightMouseDown(with: event)
    XCTAssertEqual(requests, ["record:9", "record:9"])
    XCTAssertTrue(selections.isEmpty)
    toolbar.releaseContent()
    reordered[2].rightMouseDown(with: event)
    XCTAssertEqual(requests, ["record:9", "record:9"])
  }

  func testToolbarForwardsContextRequestsAndClearsThemOnRelease() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 900, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    let host = try XCTUnwrap(toolbar.subviews.first as? PanelSwiftUIToolbarHost)
    var requested: String?
    toolbar.onTabContextMenu = { id, _ in requested = id }
    host.onTabContextMenu?("record:9", .zero)
    XCTAssertEqual(requested, "record:9")
    toolbar.releaseContent()
    XCTAssertNil(host.onTabContextMenu)
    XCTAssertNil(toolbar.onTabContextMenu)
  }
}
