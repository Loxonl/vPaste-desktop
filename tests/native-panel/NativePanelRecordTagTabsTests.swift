import AppKit
import XCTest

// Record tags appear as tabs after the fixed filters and query history the
// same way as the WebView (src/clipboard/Clipboard.tsx record-tag label).
@MainActor
final class NativePanelRecordTagTabsTests: XCTestCase {
  private func payload(_ label: String) throws -> [String: Any] {
    let json = try XCTUnwrap(label.hasPrefix("__filter:") ? label.dropFirst(9) : nil)
    return try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  func testRecordTagChoiceShowsOnlyItsNameWithTheWebViewMinimumWidth() {
    let tag = PanelFilterChoice(title: "A", emoji: "", symbol: "")
    XCTAssertFalse(tag.isFixed)
    XCTAssertEqual(tag.label, "A")
    for scale: CGFloat in [0.8, 1] {
      XCTAssertEqual(tag.width(scale: scale), 74 * scale, accuracy: 0.01)
    }
  }

  func testFilterQueryKeepsFixedFiltersAndAddsRecordTags() throws {
    let tags = [PanelTag(id: 5, name: "Work"), PanelTag(id: 9, name: "Home")]
    XCTAssertEqual(PanelFilterQuery.label(index: 0, tags: tags), "")
    XCTAssertEqual(PanelFilterQuery.label(index: 1, tags: tags), "__favorite")
    let image = try payload(try XCTUnwrap(PanelFilterQuery.label(index: 3, tags: tags)))
    XCTAssertEqual(image["mode"] as? String, "all")
    XCTAssertEqual(image["item_type"] as? String, "Image")
    let home = try payload(try XCTUnwrap(PanelFilterQuery.label(index: 8, tags: tags)))
    XCTAssertEqual(home["mode"] as? String, "record-tag")
    XCTAssertEqual(home["record_tag_ids"] as? [Int], [9])
    XCTAssertNil(PanelFilterQuery.label(index: 9, tags: tags))
    XCTAssertNil(PanelFilterQuery.label(index: -1, tags: tags))
    XCTAssertEqual(PanelFilterQuery.count(tags: tags), 9)
  }

  func testToolbarAppendsRecordTagsAfterTheFixedFilters() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let state = PanelToolbarState(scale: 1, chinese: false, search: NSSearchField())
    XCTAssertEqual(state.choices.count, 7)
    state.setTags(["Work", "Home"])
    XCTAssertEqual(state.choices.map(\.title).suffix(2), ["Work", "Home"])
    XCTAssertEqual(state.choices.count, 9)
    state.setTags(["Home"])
    XCTAssertEqual(state.choices.map(\.title), [
      "All", "Favorites", "Text", "Image", "Link", "Color", "File", "Home",
    ])
  }

  func testAddTagButtonReportsThroughTheToolbarUntilClosed() throws {
    guard #available(macOS 12.0, *) else { throw XCTSkip("SwiftUI toolbar needs macOS 12") }
    let toolbar = PanelToolbar(frame: NSRect(x: 0, y: 0, width: 900, height: 48))
    toolbar.configure(scale: 1, chinese: false, search: NSSearchField())
    var requests = 0
    toolbar.onAddTag = { requests += 1 }
    let host = try XCTUnwrap(toolbar.subviews.first as? PanelSwiftUIToolbarHost)
    host.onAddTag?()
    XCTAssertEqual(requests, 1)
    toolbar.releaseContent()
    XCTAssertNil(toolbar.onAddTag)
    XCTAssertNil(host.onAddTag)
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

  func testTagNameIsTrimmedAndLimitedLikeTheWebViewEditor() {
    XCTAssertEqual(PanelMenuSheets.tagName("  Work \n"), "Work")
    XCTAssertEqual(PanelMenuSheets.tagName(String(repeating: "标", count: 25))?.count, 20)
    XCTAssertNil(PanelMenuSheets.tagName("   "))
  }
}
