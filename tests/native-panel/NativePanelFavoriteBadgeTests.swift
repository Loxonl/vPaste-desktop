import AppKit
import XCTest

// Pins the native favorite mark to the WebView `.favorite-icon` tokens in
// src/ui/tokens.css (--ui-clipboard-favorite-* and the dark pill overrides).
@MainActor
final class NativePanelFavoriteBadgeTests: XCTestCase {
  private func components(_ color: CGColor?) -> [CGFloat] {
    let converted = color.flatMap {
      $0.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)
    }
    return (converted?.components ?? []).map { ($0 * 1000).rounded() / 1000 }
  }

  private func badge(_ appearance: NSAppearance.Name, scale: CGFloat = 1) -> PanelFavoriteBadge {
    let badge = PanelFavoriteBadge()
    badge.appearance = NSAppearance(named: appearance)
    badge.scale = scale
    badge.frame = NSRect(x: 0, y: 0, width: 18 * scale, height: 18 * scale)
    badge.layoutSubtreeIfNeeded()
    badge.layout()
    return badge
  }

  func testLightBadgeMatchesWebViewTokens() throws {
    let badge = badge(.aqua)
    let layer = try XCTUnwrap(badge.layer)
    XCTAssertFalse(layer.masksToBounds, "The drop shadow must not be clipped")
    XCTAssertEqual(layer.cornerRadius, 9)
    XCTAssertEqual(components(layer.backgroundColor), [1, 1, 1, 0.88])
    XCTAssertEqual(layer.borderWidth, 1)
    XCTAssertEqual(components(layer.borderColor), [1, 0.804, 0.294, 0.38])
    XCTAssertEqual(layer.shadowOpacity, 0.16, accuracy: 0.001)
    XCTAssertEqual(layer.shadowRadius, 3.5)
    XCTAssertEqual(layer.shadowOffset.height, -2)
    XCTAssertNotNil(layer.shadowPath)
    XCTAssertEqual(components(badge.starColor.cgColor), [0.482, 0.329, 0, 1])
    XCTAssertEqual(badge.starFont.pointSize, 11)
  }

  func testDarkBadgeUsesDarkPillTokens() throws {
    let badge = badge(.darkAqua)
    let layer = try XCTUnwrap(badge.layer)
    XCTAssertEqual(components(layer.backgroundColor), [0.047, 0.055, 0.071, 0.72])
    XCTAssertEqual(components(layer.borderColor), [1, 1, 1, 0.14])
    XCTAssertEqual(layer.shadowOpacity, 0.36, accuracy: 0.001)
    XCTAssertEqual(layer.shadowRadius, 11)
    XCTAssertEqual(layer.shadowOffset.height, -8)
    XCTAssertEqual(components(badge.starColor.cgColor), [0.969, 0.973, 0.98, 1])
  }

  func testStarIsCenteredAndScalesWithPanelZoom() {
    for scale: CGFloat in [1, 1.25] {
      let badge = badge(.aqua, scale: scale)
      let rect = badge.starRect
      XCTAssertEqual(rect.midX, badge.bounds.midX, accuracy: 0.01)
      XCTAssertEqual(rect.midY, badge.bounds.midY, accuracy: 0.01)
      XCTAssertEqual(badge.starFont.pointSize, 11 * scale, accuracy: 0.001)
      XCTAssertEqual(badge.layer?.cornerRadius ?? 0, 9 * scale, accuracy: 0.001)
      XCTAssertEqual(badge.layer?.borderWidth ?? 0, scale, accuracy: 0.001)
    }
  }
}
