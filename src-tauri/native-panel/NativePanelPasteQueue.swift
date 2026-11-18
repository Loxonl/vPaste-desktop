import AppKit

// A floating action row using Liquid Glass where available. It does not
// resize the list or keep any history/card objects alive.
@MainActor
final class PanelPasteQueueBar: NSView {
  override var isFlipped: Bool { true }
  var onAdd: (() -> Void)?
  private let content = NSView()
  private let row = NSStackView()
  private var glass: NSView!
  private let prompt = NSTextField(labelWithString: "")
  private let countLabel = NSTextField(labelWithString: "0")
  private let add = PanelPointerButton()
  private let scale: CGFloat
  private let chinese: Bool
  init(scale: CGFloat, chinese: Bool) {
    self.scale = scale
    self.chinese = chinese
    super.init(frame: .zero)
    wantsLayer = true
    content.autoresizingMask = [.width, .height]
    glass = makeGlass()
    addSubview(glass)
    prompt.stringValue = chinese ? "选择要加入队列的项目" : "Select items to add to the queue"
    prompt.font = .systemFont(ofSize: 12 * scale, weight: .semibold)
    countLabel.font = .systemFont(ofSize: 11 * scale)
    countLabel.alignment = .center
    add.font = .systemFont(ofSize: 11.5 * scale, weight: .semibold)
    add.isBordered = true
    add.bezelStyle = .rounded
    add.refusesFirstResponder = true
    add.focusRingType = .none
    add.target = self
    add.action = #selector(submit)
    row.orientation = .horizontal
    row.distribution = .fill
    row.alignment = .centerY
    row.spacing = 9 * scale
    row.translatesAutoresizingMaskIntoConstraints = false
    for view in [prompt, countLabel, add] {
      view.setContentCompressionResistancePriority(.required, for: .horizontal)
      view.setContentHuggingPriority(.defaultHigh, for: .horizontal)
      row.addArrangedSubview(view)
    }
    content.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20 * scale),
      row.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20 * scale),
      row.topAnchor.constraint(equalTo: content.topAnchor, constant: 6 * scale),
      row.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -6 * scale),
      countLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 24 * scale),
      add.heightAnchor.constraint(greaterThanOrEqualToConstant: 30 * scale),
    ])
    update(count: 0, busy: false)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  private func makeGlass() -> NSView {
    #if VPASTE_LIQUID_GLASS_SDK
      if #available(macOS 26.0, *) {
        let glass = NSGlassEffectView()
        glass.style = .regular
        glass.cornerRadius = 12 * scale
        glass.contentView = content
        return glass
      }
    #endif
    let glass = NSVisualEffectView()
    glass.material = .popover
    glass.blendingMode = .withinWindow
    glass.state = .active
    glass.wantsLayer = true
    glass.layer?.cornerRadius = 12 * scale
    glass.layer?.masksToBounds = true
    glass.addSubview(content)
    return glass
  }
  func update(count: Int, busy: Bool) {
    countLabel.stringValue = String(count)
    add.title = chinese ? "加入 \(count) 项" : "Add \(count) items"
    add.setAccessibilityLabel(add.title)
    add.isEnabled = count > 0 && !busy
    add.attributedTitle = NSAttributedString(string: add.title, attributes: [
      .font: add.font!, .foregroundColor: add.isEnabled ? NSColor.white : .disabledControlTextColor,
    ])
    setAccessibilityLabel(prompt.stringValue)
    invalidateIntrinsicContentSize()
    needsLayout = true
  }
  override var intrinsicContentSize: NSSize {
    let size = row.fittingSize
    return NSSize(width: ceil(size.width) + 40 * scale,
      height: max(42 * scale, ceil(size.height) + 12 * scale))
  }
  override func layout() {
    super.layout()
    glass.frame = bounds
    content.frame = bounds
    #if VPASTE_LIQUID_GLASS_SDK
      if #available(macOS 26.0, *), let glass = glass as? NSGlassEffectView {
        glass.tintColor = PanelStyle.dark(self) ? nil : NSColor.white.withAlphaComponent(0.18)
      }
    #endif
    layer?.cornerRadius = 12 * scale
    layer?.shadowColor = NSColor.black.cgColor
    layer?.shadowOpacity = PanelStyle.dark(self) ? 0.28 : 0.12
    layer?.shadowRadius = 10 * scale
    layer?.shadowOffset = NSSize(width: 0, height: -3 * scale)
    prompt.textColor = PanelStyle.text(self)
    countLabel.textColor = PanelStyle.secondary(self)
    add.bezelColor = PanelStyle.accent(self)
    add.contentTintColor = .white
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsLayout = true
  }
  @objc private func submit() { onAdd?() }
  func releaseContent() { onAdd = nil; add.target = nil }
}
