import AppKit
import CoreText

// Match Clipboard.module.css typography in logical points, before panel zoom.
// Apply the CSS variable-font weight directly: AppKit's named weights quantize
// intermediate values (for example, 740 can otherwise become the heavy face).
enum PanelToolbarTypography {
  static let tabSize: CGFloat = 14.5
  static let lineHeight: CGFloat = 18

  // The variation axis below picks the exact weight for SF Pro. CJK glyphs
  // fall back to PingFang, which ignores that axis and follows this base
  // weight, so it must match what WebKit selects for the CSS weight.
  static func baseWeight(for cssWeight: Double) -> NSFont.Weight {
    cssWeight >= 700 ? .bold : cssWeight >= 550 ? .medium : .regular
  }

  static func font(size: CGFloat, cssWeight: Double) -> NSFont {
    let base = NSFont.systemFont(ofSize: size, weight: baseWeight(for: cssWeight))
    let descriptor = CTFontDescriptorCreateWithAttributes([
      kCTFontVariationAttribute: [NSNumber(value: 0x77676874): cssWeight]
    ] as CFDictionary)
    return CTFontCreateCopyWithAttributes(base as CTFont, size, nil, descriptor) as NSFont
  }

  static func tabFont(scale: CGFloat, selected: Bool) -> NSFont {
    font(size: tabSize * scale, cssWeight: selected ? 740 : 590)
  }
}

// Let AppKit own cursor entry/exit and teardown rather than keeping a global
// push/pop stack in SwiftUI onHover callbacks. This view never takes the click.
// Because `hitTest` returns nil, AppKit skips this view when resolving cursor
// rectangles and `cursorUpdate` events; the tracking area's mouse entered/exited
// messages are the path that still fires inside the SwiftUI hosting hierarchy.
@MainActor
class PanelCursorRegion: NSView {
  let cursor: NSCursor
  private var cursorTracking: NSTrackingArea?
  var isEnabled = true {
    didSet { if oldValue != isEnabled { window?.invalidateCursorRects(for: self) } }
  }
  init(cursor: NSCursor) {
    self.cursor = cursor
    super.init(frame: .zero)
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override var acceptsFirstResponder: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let cursorTracking { removeTrackingArea(cursorTracking) }
    let tracking = NSTrackingArea(
      rect: .zero,
      options: [.cursorUpdate, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
      owner: self)
    addTrackingArea(tracking)
    cursorTracking = tracking
  }
  override func mouseEntered(with event: NSEvent) {
    guard isEnabled else { return }
    cursor.set()
  }
  override func mouseExited(with event: NSEvent) {
    // Restore the default cursor even if the region was disabled while hovered.
    NSCursor.arrow.set()
  }
  override func cursorUpdate(with event: NSEvent) {
    guard isEnabled else { return }
    cursor.set()
  }
  override func resetCursorRects() {
    super.resetCursorRects()
    if isEnabled { addCursorRect(visibleRect, cursor: cursor) }
  }
}

// Native counterparts of Clipboard.module.css / src/ui/tokens.css. The page's
// PanelBackdrop tints Clear Liquid Glass; the toolbar uses a denser fill.
@MainActor
enum PanelStyle {
  static let headerHeight: CGFloat = 48
  static let cardWidth: CGFloat = 220
  static let cardHeight: CGFloat = 230
  static let cardGap: CGFloat = 16
  static let cardInset: CGFloat = 24
  static let cardPadding: CGFloat = 12
  static let cardRadius: CGFloat = 14

  static func dark(_ view: NSView) -> Bool {
    view.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  }
  static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(
      srgbRed: CGFloat((hex >> 16) & 255) / 255,
      green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: alpha)
  }
  static func accent(_ view: NSView) -> NSColor { dark(view) ? rgb(0x8ab7ff) : rgb(0x2466d8) }
  static func text(_ view: NSView) -> NSColor { dark(view) ? rgb(0xe5e8ee) : rgb(0x333333) }
  static func secondary(_ view: NSView) -> NSColor {
    dark(view) ? rgb(0xdde2eb, 0.68) : rgb(0x2a3230, 0.62)
  }
  static func control(_ view: NSView, hover: Bool = false) -> NSColor {
    dark(view)
      ? rgb(hover ? 0x2d333c : 0x21262d, hover ? 0.82 : 0.64)
      : rgb(0xffffff, hover ? 0.92 : 0.72)
  }
  static func previewCanvas(_ dark: Bool) -> NSColor { rgb(dark ? 0x181b22 : 0xf7f7f5) }
  // The WebView surface is 0.74 over a flat page; these cards sit on variable
  // Liquid Glass, so stay nearly opaque to protect text contrast.
  static func cardSurface(_ dark: Bool) -> NSColor {
    NSColor(calibratedWhite: dark ? 0.13 : 1, alpha: dark ? 0.99 : 0.98)
  }
  static func luminance(_ color: NSColor) -> CGFloat {
    guard let color = color.usingColorSpace(.sRGB) else { return 0.5 }
    func linear(_ v: CGFloat) -> CGFloat {
      v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }
    return linear(color.redComponent) * 0.2126 + linear(color.greenComponent) * 0.7152 + linear(
      color.blueComponent) * 0.0722
  }
  static func headerContrast(_ color: NSColor) -> NSColor {
    guard let color = color.usingColorSpace(.sRGB), (1.05 / (luminance(color) + 0.05)) < 1.4 else {
      return color
    }
    var low: CGFloat = 0
    var high: CGFloat = 1
    for _ in 0..<16 {
      let factor = (low + high) / 2
      let candidate = NSColor(
        srgbRed: color.redComponent * factor,
        green: color.greenComponent * factor, blue: color.blueComponent * factor, alpha: 1)
      if 1.05 / (luminance(candidate) + 0.05) >= 1.4 { low = factor } else { high = factor }
    }
    return NSColor(
      srgbRed: color.redComponent * low, green: color.greenComponent * low,
      blue: color.blueComponent * low, alpha: 1)
  }
}

// Mirrors the WebView `.favorite-icon`: an 18 pt circle with an inset ring,
// drop shadow and an 11 pt star centered on its 18 pt line box. Light values
// follow --ui-clipboard-favorite-*; dark values follow the dark pill tokens.
@MainActor
final class PanelFavoriteBadge: NSView {
  private static let star = "★" as NSString
  var scale: CGFloat = 1 {
    didSet { if oldValue != scale { needsLayout = true; needsDisplay = true } }
  }
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .onSetNeedsDisplay
    layer?.masksToBounds = false
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  var starFont: NSFont { .systemFont(ofSize: 11 * scale) }
  var starColor: NSColor {
    PanelStyle.dark(self) ? PanelStyle.rgb(0xf7f8fa) : PanelStyle.rgb(0x7b5400)
  }
  var starRect: NSRect {
    let size = Self.star.size(withAttributes: [.font: starFont])
    return NSRect(
      x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2,
      width: size.width, height: size.height)
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsLayout = true
    needsDisplay = true
  }
  override func layout() {
    super.layout()
    guard let layer else { return }
    // AppKit re-enables masking for clipping views (macOS 14+), which would
    // cut off the drop shadow.
    if #available(macOS 14.0, *) { clipsToBounds = false }
    layer.masksToBounds = false
    let dark = PanelStyle.dark(self)
    layer.cornerRadius = bounds.height / 2
    layer.backgroundColor =
      (dark ? PanelStyle.rgb(0x0c0e12, 0.72) : PanelStyle.rgb(0xffffff, 0.88)).cgColor
    layer.borderWidth = scale
    layer.borderColor =
      (dark ? PanelStyle.rgb(0xffffff, 0.14) : PanelStyle.rgb(0xffcd4b, 0.38)).cgColor
    // CSS blur radius is twice the Core Animation shadow radius; negative
    // height moves the shadow down, matching the CSS y offset.
    layer.shadowColor = NSColor.black.cgColor
    layer.shadowOpacity = dark ? 0.36 : 0.16
    layer.shadowRadius = (dark ? 11 : 3.5) * scale
    layer.shadowOffset = NSSize(width: 0, height: -(dark ? 8 : 2) * scale)
    layer.shadowPath = CGPath(ellipseIn: bounds, transform: nil)
  }
  override func draw(_ dirtyRect: NSRect) {
    Self.star.draw(in: starRect, withAttributes: [.font: starFont, .foregroundColor: starColor])
  }
}

@MainActor
final class PanelInfoBar: NSView {
  let label = NSTextField(labelWithString: "")
  var scale: CGFloat = 1
  override init(frame: NSRect) {
    super.init(frame: frame)
    label.font = .systemFont(ofSize: 10)
    label.lineBreakMode = .byTruncatingTail
    addSubview(label)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layout() {
    super.layout()
    label.frame = NSRect(
      x: 24 * scale, y: 5 * scale,
      width: max(0, bounds.width - 48 * scale), height: max(0, bounds.height - 10 * scale))
    label.textColor = PanelStyle.secondary(self)
  }
  override func draw(_ dirtyRect: NSRect) {
    (PanelStyle.dark(self) ? PanelStyle.rgb(0x161b22, 0.90) : PanelStyle.rgb(0xf5f7f6, 0.88))
      .setFill()
    bounds.fill()
  }
}

@MainActor
final class PanelEmptyState: NSView {
  private let symbol = NSImageView()
  private let title = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let progress = NSProgressIndicator()
  var scale: CGFloat = 1
  override init(frame: NSRect) {
    super.init(frame: frame)
    symbol.image = NSImage(systemSymbolName: "tray", accessibilityDescription: nil)
    symbol.imageScaling = .scaleProportionallyUpOrDown
    title.alignment = .center
    detail.alignment = .center
    progress.style = .spinning
    progress.controlSize = .small
    for view in [symbol, title, detail, progress] { addSubview(view) }
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func show(title: String, detail: String, loading: Bool = false) {
    isHidden = false
    self.title.stringValue = title
    self.detail.stringValue = detail
    symbol.isHidden = loading
    progress.isHidden = !loading
    if loading { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
    setAccessibilityLabel(title + ". " + detail)
    needsLayout = true
  }
  func hide() {
    isHidden = true
    progress.stopAnimation(nil)
  }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func layout() {
    super.layout()
    let center = bounds.midX
    let top = bounds.midY - 42 * scale
    symbol.frame = NSRect(x: center - 18 * scale, y: top, width: 36 * scale, height: 36 * scale)
    progress.frame = NSRect(
      x: center - 10 * scale, y: top + 8 * scale, width: 20 * scale, height: 20 * scale)
    title.frame = NSRect(
      x: center - 180 * scale, y: top + 44 * scale, width: 360 * scale, height: 22 * scale)
    detail.frame = NSRect(
      x: center - 220 * scale, y: top + 70 * scale, width: 440 * scale, height: 34 * scale)
    title.font = .systemFont(ofSize: 14 * scale, weight: .semibold)
    detail.font = .systemFont(ofSize: 12 * scale)
    title.textColor = PanelStyle.text(self)
    detail.textColor = PanelStyle.secondary(self)
    symbol.contentTintColor = PanelStyle.accent(self)
  }
  override var isFlipped: Bool { true }
}
