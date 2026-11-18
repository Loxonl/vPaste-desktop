import AppKit
import XCTest

@MainActor
final class NativePanelPreviewTests: XCTestCase {
  private let image = PanelPreviewItem(hash: "image", itemType: "Image")

  func testHoverHonorsConfigurationAndUsesExistingDelays() {
    var requests: [(String, [String: Any])] = []
    var scheduled: [(TimeInterval, DispatchWorkItem)] = []
    let preview = PanelPreviewDriver(hoverEnabled: false,
      send: { requests.append(($0, $1)) }, schedule: { scheduled.append(($0, $1)) })
    preview.enter(image)
    XCTAssertTrue(scheduled.isEmpty)
    preview.hoverEnabled = true
    preview.enter(image)
    XCTAssertEqual(scheduled.first?.0, 0.5)
    scheduled[0].1.perform()
    XCTAssertEqual(requests.last?.0, "preview")
    XCTAssertEqual(requests.last?.1["mode"] as? String, "hover")
    preview.leave(image)
    XCTAssertEqual(scheduled.last?.0, 0.25)
    preview.pointerInPreview(true)
    scheduled.last?.1.perform()
    XCTAssertEqual(requests.last?.0, "preview")
    preview.pointerInPreview(false)
    scheduled.last?.1.perform()
    XCTAssertEqual(requests.last?.0, "hover-dismiss")
    preview.close()
  }

  func testApplicationActivationAndDeactivationAreForwardedOnlyWhilePanelLives() {
    let center = NotificationCenter()
    var activation: [Bool] = []
    let observer = PanelApplicationFocus(center: center) { activation.append($0) }
    center.post(name: NSApplication.didResignActiveNotification, object: nil)
    center.post(name: NSApplication.didBecomeActiveNotification, object: nil)
    XCTAssertEqual(activation, [false, true])
    observer.close()
    center.post(name: NSApplication.didResignActiveNotification, object: nil)
    XCTAssertEqual(activation, [false, true], "Closing the panel must remove application observers")
  }

  func testSpaceTogglesOnlyPreviewAndSelectionKeepsDirection() {
    var requests: [(String, [String: Any])] = []
    let preview = PanelPreviewDriver(hoverEnabled: true, send: { requests.append(($0, $1)) })
    preview.toggle(image)
    XCTAssertEqual(requests.last?.0, "preview-toggle")
    XCTAssertEqual(requests.last?.1["hash"] as? String, "image")
    preview.selection(image, direction: -1)
    XCTAssertEqual(requests.last?.1["mode"] as? String, "selection")
    XCTAssertEqual(requests.last?.1["navigationDirection"] as? Int, -1)
    XCTAssertFalse(requests.contains { $0.0 == "close" })
    preview.close()
  }

  func testLeavingBeforeDelayAndClosingCancelLateHoverRequests() {
    var requests: [String] = []
    var scheduled: [DispatchWorkItem] = []
    let preview = PanelPreviewDriver(hoverEnabled: true,
      send: { op, _ in requests.append(op) }, schedule: { _, work in scheduled.append(work) })
    preview.enter(image)
    let old = scheduled[0]
    preview.leave(image)
    old.perform()
    XCTAssertFalse(requests.contains("preview"))
    preview.enter(image)
    let pending = scheduled.last!
    preview.close()
    pending.perform()
    XCTAssertFalse(requests.contains("preview"))
  }

  func testUnsupportedHoverDoesNotOpenButManualPreviewStillWorks() {
    var requests: [String] = []
    let preview = PanelPreviewDriver(hoverEnabled: true, send: { op, _ in requests.append(op) })
    let file = PanelPreviewItem(hash: "file", itemType: "File")
    preview.enter(file)
    XCTAssertTrue(requests.isEmpty)
    preview.open(file)
    XCTAssertEqual(requests.last, "preview")
    preview.close()
  }
}
