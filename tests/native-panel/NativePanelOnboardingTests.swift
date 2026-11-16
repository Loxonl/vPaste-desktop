import AppKit
import XCTest

@MainActor
final class NativePanelOnboardingTests: XCTestCase {
  func testOlderSessionUpdatesCannotRestartAnAdvancedStep() {
    let model = PanelOnboardingModel(state: state(step: 2, revision: 4), chinese: false, scale: 1)
    model.apply(state(step: 1, revision: 3))
    XCTAssertEqual(model.state.step, 2)
    XCTAssertEqual(model.state.revision, 4)
    model.apply(state(step: 3, revision: 5))
    XCTAssertEqual(model.state.step, 3)
    model.close()
    model.apply(state(step: 1, revision: 6))
    XCTAssertEqual(model.state.step, 3)
  }

  func testClosingCancelsScheduledAnimationAndRequestCallbacks() {
    let model = PanelOnboardingModel(state: state(step: 0), chinese: true, scale: 1)
    var requests = 0
    model.onAction = { _, _ in requests += 1 }
    model.play(reduced: false)
    model.close()
    XCTAssertEqual(model.scheduledCount, 0)
    model.perform("next")
    XCTAssertEqual(requests, 0)
  }

  func testPausingForWindowHidingKeepsActionsAvailableOnReturn() {
    let model = PanelOnboardingModel(state: state(step: 2), chinese: false, scale: 1)
    var requests = 0
    model.onAction = { _, _ in requests += 1 }
    model.play(reduced: false)
    model.pause()
    XCTAssertEqual(model.scheduledCount, 0)
    model.perform("toggle", ["start": 4, "enabled": true])
    XCTAssertEqual(requests, 1)
    model.close()
  }

  func testShortcutPressTimingAndReducedMotionPreserveTheFiniteSequence() {
    let motion = PanelOnboardingMotion.standard
    XCTAssertEqual(motion.welcomeDuration, 1.5, accuracy: 0.0001)
    XCTAssertEqual(motion.shortcutDuration, 1.14, accuracy: 0.0001)
    let model = PanelOnboardingModel(state: state(step: 3), chinese: false, scale: 1)
    model.play(reduced: true)
    XCTAssertTrue(model.entered)
    XCTAssertEqual(model.keyScale, 1)
    XCTAssertEqual(model.pulseOpacity, 0)
    XCTAssertEqual(model.scheduledCount, 0)
    model.close()
  }

  private func state(step: Int, revision: UInt64 = 1) -> PanelOnboardingState {
    PanelOnboardingState(id: 7, revision: revision, step: step,
      filters: [true, true, true, true, false], shortcut: "Alt+V", assets: [:],
      permissions: PanelOnboardingPermissions(background: .init(done: false), paste: .init(done: false)),
      motion: .standard)
  }
}
