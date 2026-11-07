import AppKit

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
