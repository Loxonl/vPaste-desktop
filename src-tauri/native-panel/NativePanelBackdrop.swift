import AppKit

// One system glass surface for the panel. Cards and controls stay in contentView,
// the documented embedding point for NSGlassEffectView (not arbitrary subviews).
@MainActor
final class PanelBackdrop: NSView {
  let contentView: NSView = PanelBackdropContent()
  private(set) var materialName = "frosted-glass"

  init(scale: CGFloat) {
    super.init(frame: .zero)
    contentView.autoresizingMask = [.width, .height]
    let effect = makeEffect(scale: scale)
    effect.frame = bounds
    effect.autoresizingMask = [.width, .height]
    addSubview(effect)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func makeEffect(scale: CGFloat) -> NSView {
    // The build flag checks the selected SDK as well as this runtime guard, so
    // development with pre-26 Xcode/SDKs retains the existing frosted fallback.
    #if VPASTE_LIQUID_GLASS_SDK
      if #available(macOS 26.0, *) {
        let glass = NSGlassEffectView()
        glass.style = .clear
        glass.cornerRadius = 18 * scale
        glass.contentView = contentView
        materialName = "liquid-glass (NSGlassEffectView)"
        return glass
      }
    #endif
    let glass = NSVisualEffectView()
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.addSubview(contentView)
    return glass
  }
}

// Tint the content above the system glass, below cards and toolbar. Keep its
// opacity below the toolbar's gradient so the page remains more translucent.
@MainActor
private final class PanelBackdropContent: NSView {
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    let tint = PanelStyle.dark(self)
      ? PanelStyle.rgb(0x161b22, 0.36) : PanelStyle.rgb(0xf2f5f2, 0.30)
    tint.setFill()
    bounds.fill(using: .sourceOver)
  }
}
