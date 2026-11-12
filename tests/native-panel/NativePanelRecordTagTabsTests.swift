import AppKit
import XCTest

// Record tags appear as tabs after the fixed filters and query history the
// same way as the WebView (src/clipboard/Clipboard.tsx record-tag label).
@MainActor
final class NativePanelRecordTagTabsTests: XCTestCase {
  private let tabs = [
    PanelTab(id: "tab-1", name: "📝 Text", label: "__filter:{\"mode\":\"custom\"}", record: false),
    PanelTab(id: "record:9", name: "Home", label: "__filter:{\"mode\":\"record-tag\"}", record: true),
  ]

  func testDynamicTabChoicesShowTheStoredNameWithWebViewMinimumWidths() {
    let record = PanelFilterChoice(title: "A", emoji: "", symbol: "", record: true)
    let filter = PanelFilterChoice(title: "A", emoji: "", symbol: "")
    XCTAssertFalse(record.isFixed)
    XCTAssertEqual(record.label, "A")
    for scale: CGFloat in [0.8, 1] {
      XCTAssertEqual(record.width(scale: scale), 74 * scale, accuracy: 0.01)
      XCTAssertEqual(filter.width(scale: scale), 58 * scale, accuracy: 0.01)
    }
  }

  func testFilterQueryUsesTheFixedTabsThenEachDynamicTabsLabel() {
    XCTAssertEqual(PanelFilterQuery.label(index: 0, tabs: tabs), "")
    XCTAssertEqual(PanelFilterQuery.label(index: 1, tabs: tabs), "__favorite")
    XCTAssertEqual(PanelFilterQuery.label(index: 2, tabs: tabs), tabs[0].label)
    XCTAssertEqual(PanelFilterQuery.label(index: 3, tabs: tabs), tabs[1].label)
    XCTAssertNil(PanelFilterQuery.label(index: 4, tabs: tabs))
    XCTAssertNil(PanelFilterQuery.label(index: -1, tabs: tabs))
    XCTAssertEqual(PanelFilterQuery.count(tabs: tabs), 4)
    XCTAssertEqual(PanelFilterQuery.count(tabs: []), 2)
  }

  func testToolbarShowsOnlyAllAndFavoritesUntilDynamicTabsArrive() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    XCTAssertEqual(state.choices.map(\.title), ["All", "Favorites"])
    state.setTabs(tabs)
    XCTAssertEqual(state.choices.map(\.label), ["All", "Favorites", "📝 Text", "Home"])
    XCTAssertEqual(state.choices.map(\.record), [false, false, false, true])
    state.setTabs([tabs[1]])
    XCTAssertEqual(state.choices.map(\.title), ["All", "Favorites", "Home"])
  }

  func testFallbackToolbarRebuildsItsDynamicTabs() {
    let toolbar = PanelLegacyToolbar(frame: NSRect(x: 0, y: 0, width: 900, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    XCTAssertEqual(toolbar.tabTitles, ["All", "Favorites"])
    toolbar.setTabs(tabs)
    XCTAssertEqual(toolbar.tabTitles, ["All", "Favorites", "📝 Text", "Home"])
    var chosen: [Int] = []
    toolbar.onFilter = { chosen.append($0) }
    toolbar.chooseTab(3)
    XCTAssertEqual(chosen, [3])
    toolbar.setTabs([])
    XCTAssertEqual(toolbar.tabTitles, ["All", "Favorites"])
  }

  func testCreatedTabIsSelectedByIdentityAfterTabsAreRefreshed() {
    XCTAssertEqual(PanelFilterQuery.index(id: "record:9", tabs: tabs), 3)
    XCTAssertEqual(PanelFilterQuery.index(id: "record:9", tabs: Array(tabs.reversed())), 2)
    XCTAssertNil(PanelFilterQuery.index(id: "removed", tabs: tabs))
  }

  func testAddButtonReportsThroughTheToolbarUntilClosed() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 900, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    var requests = 0
    toolbar.onAddTab = { requests += 1 }
    let host = try XCTUnwrap(toolbar.subviews.first as? PanelSwiftUIToolbarHost)
    host.onAddTab?()
    XCTAssertEqual(requests, 1)
    toolbar.releaseContent()
    XCTAssertNil(toolbar.onAddTab)
    XCTAssertNil(host.onAddTab)
  }

  func testFilterStripReservesRoomForTheAddButton() {
    let choices = [PanelFilterChoice(title: "All", emoji: "", symbol: "square.grid.3x3.fill")]
    for scale: CGFloat in [0.8, 1] {
      // One 78px tab, then the WebView's 1px margin and 36px add button.
      XCTAssertEqual(
        PanelFilterIndicatorLayout.extent(choices: choices, selected: 0, scale: scale),
        (78 + 1 + 36) * scale, accuracy: 0.01)
    }
  }

  func testAddButtonOffersTheWebViewsTwoTagKinds() throws {
    var chosen: [Bool] = []
    let handler = PanelTabKindHandler { chosen.append($0) }
    let menu = PanelContextMenu.tabKindMenu(chinese: true, handler: handler)
    XCTAssertEqual(menu.items.map { $0.attributedTitle?.string }, [
      "筛选型标签\n按筛选条件自动归类", "记录型标签\n手动添加到粘贴项",
    ])
    let english = PanelContextMenu.tabKindMenu(chinese: false, handler: handler)
    XCTAssertEqual(english.items.map { $0.attributedTitle?.string }, [
      "Filter Tag\nAuto-grouped by filters", "Record Tag\nManually added to items",
    ])
    handler.select(menu.items[0])
    handler.select(menu.items[1])
    XCTAssertEqual(chosen, [false, true])
  }

  func testEditorAnchorUsesTopLeftScreenCoordinates() {
    // AppKit's origin is the primary screen's bottom-left; Tauri's is its top-left.
    XCTAssertEqual(
      PanelContextMenu.editorAnchor(mouse: NSPoint(x: 300, y: 250), primaryHeight: 900),
      [300, 650])
  }
}
