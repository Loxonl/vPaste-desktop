import AppKit
import XCTest

@MainActor
final class NativePanelHistoryTests: XCTestCase {
  func testDeltaReusesKnownRefsAcrossPageBoundariesAndDiscardsUnlistedPages() throws {
    let old = (0..<36).map { ref("old-\($0)") }
    let delta = PanelHistoryDelta(token: PanelToken(viewId: "view", revision: 2), baseRevision: 1,
      full: false, pages: [PanelHistoryRefs(pageIndex: 0, hashes: ["new"] + old.prefix(35).map(\.hash)),
        PanelHistoryRefs(pageIndex: 1, hashes: [old[35].hash])], refs: [ref("new")],
      knownCount: 37, hasMore: false, anchorIndex: 0, selectedIndex: 1, offset: 0,
      viewportRevision: 4, invalidated: [], resourcesChanged: false)
    let merged = try delta.merging([0: old, 9: [ref("discard")]], token: PanelToken(viewId: "view", revision: 1))
    XCTAssertEqual(merged[0]?.first?.hash, "new")
    XCTAssertEqual(merged[1]?.first?.hash, "old-35")
    XCTAssertNil(merged[9])
    XCTAssertEqual(merged.values.flatMap { $0 }.count, 37)
  }

  func testDeltaRejectsStaleBaseAndMissingRefsInsteadOfCorruptingTheWindow() {
    let patch = PanelHistoryDelta(token: PanelToken(viewId: "view", revision: 3), baseRevision: 2,
      full: false, pages: [PanelHistoryRefs(pageIndex: 0, hashes: ["missing"])], refs: [],
      knownCount: 1, hasMore: false, anchorIndex: 0, selectedIndex: 0, offset: 0,
      viewportRevision: 1, invalidated: [], resourcesChanged: false)
    XCTAssertThrowsError(try patch.merging([:], token: PanelToken(viewId: "view", revision: 1)))
    XCTAssertThrowsError(try patch.merging([:], token: PanelToken(viewId: "view", revision: 2)))
  }

  func testBackendDeletionRechunksPagesWithoutKeepingTheRemovedRef() throws {
    let old = (0..<72).map { ref("h\($0)") }
    let remaining = old.filter { $0.hash != "h2" }
    let delta = PanelHistoryDelta(token: PanelToken(viewId: "view", revision: 2), baseRevision: 1,
      full: false, pages: [PanelHistoryRefs(pageIndex: 0, hashes: Array(remaining.prefix(36)).map(\.hash)),
        PanelHistoryRefs(pageIndex: 1, hashes: Array(remaining.dropFirst(36)).map(\.hash))], refs: [],
      knownCount: 71, hasMore: false, anchorIndex: 0, selectedIndex: 2, offset: 0,
      viewportRevision: 1, invalidated: [], resourcesChanged: false)
    let merged = try delta.merging([0: Array(old.prefix(36)), 1: Array(old.dropFirst(36))],
      token: PanelToken(viewId: "view", revision: 1))
    XCTAssertEqual(merged[0]?[2].hash, "h3")
    XCTAssertEqual(merged[0]?[35].hash, "h36")
    XCTAssertEqual(merged[1]?.first?.hash, "h37")
    XCTAssertEqual(merged[1]?.count, 35)
  }

  func testLiveEditsUseChangedRowsInsteadOfTheTail() {
    let old = [0: ["a", "b", "c"].map(ref)]
    let head = PanelHistoryEdits(old: old, new: [0: ["new", "a", "b", "c"].map(ref)],
      oldCount: 3, newCount: 4)
    XCTAssertEqual(head.inserted, [IndexPath(item: 0, section: 0)])
    XCTAssertTrue(head.removed.isEmpty)
    let middle = PanelHistoryEdits(old: old, new: [0: ["a", "c"].map(ref)],
      oldCount: 3, newCount: 2)
    XCTAssertEqual(middle.removed, [IndexPath(item: 1, section: 0)])
    XCTAssertTrue(middle.inserted.isEmpty)
    let replacement = PanelHistoryEdits(old: old, new: [0: ["a", "new", "c"].map(ref)],
      oldCount: 3, newCount: 3)
    XCTAssertEqual(replacement.removed, [IndexPath(item: 1, section: 0)])
    XCTAssertEqual(replacement.inserted, replacement.removed)
  }

  func testLoadingAnotherPageDoesNotAnimateUnchangedSlots() {
    let old = [0: (0..<36).map { ref("h\($0)") }]
    let new = [1: (36..<72).map { ref("h\($0)") }]
    let edit = PanelHistoryEdits(old: old, new: new, oldCount: 72, newCount: 72)
    XCTAssertTrue(edit.removed.isEmpty)
    XCTAssertTrue(edit.inserted.isEmpty)
  }

  private func ref(_ hash: String) -> PanelRef {
    PanelRef(hash: hash, itemType: "Text", time: 1, label: 0, appSource: "", titleColor: "")
  }
}
