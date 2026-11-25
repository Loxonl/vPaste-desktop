import AppKit

// AppKit owns the checkbox, bezel, focus ring and disclosure glyph. The
// content overlay is decorative and passes mouse events to the host button.
@MainActor
final class PanelSourceIconLabel: NSStackView {
  private let text = NSTextField(labelWithString: "")

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  static func update(_ button: NSButton, title: String, icons: [NSImage?],
    leading: CGFloat, trailing: CGFloat) {
    button.subviews.compactMap { $0 as? PanelSourceIconLabel }.forEach { $0.removeFromSuperview() }
    let images = icons.compactMap { $0 }
    guard !images.isEmpty else { button.title = title; return }
    button.title = ""
    let label = PanelSourceIconLabel()
    label.configure(title, images: images, for: button)
    button.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: leading),
      label.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -trailing),
      label.centerYAnchor.constraint(equalTo: button.centerYAnchor),
    ])
  }

  private func configure(_ title: String, images: [NSImage], for button: NSButton) {
    translatesAutoresizingMaskIntoConstraints = false
    orientation = .horizontal
    alignment = .centerY
    spacing = 4
    setAccessibilityElement(false)
    setAccessibilityChildren([])
    for image in images {
      let icon = NSImageView(image: image)
      icon.imageScaling = .scaleProportionallyUpOrDown
      icon.setAccessibilityElement(false)
      addArrangedSubview(icon)
      NSLayoutConstraint.activate([
        icon.widthAnchor.constraint(equalToConstant: 16),
        icon.heightAnchor.constraint(equalToConstant: 16),
      ])
    }
    text.stringValue = title
    text.font = button.font
    text.textColor = button.isEnabled ? .controlTextColor : .disabledControlTextColor
    text.lineBreakMode = .byTruncatingTail
    text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    text.setAccessibilityElement(false)
    addArrangedSubview(text)
  }
}

@MainActor
final class PanelSourcePicker: NSViewController, NSSearchFieldDelegate {
  struct Option {
    let source: String
    let name: String
    let recent: Bool
    let iconPath: String
  }

  private let options: [Option]
  private let iconMedia: PanelMedia
  private let unavailable: Bool
  private let chinese: Bool
  private let onChange: ([String]) -> Void
  private let onDismiss: () -> Void
  private var selected: [String]
  private let search = NSSearchField()
  private let any = Choice()
  private let scroll = NSScrollView()
  private let document = FlippedView()
  private let empty = NSTextField(labelWithString: "")
  private var rows: [(Option, Choice)] = []

  init(options: [Option], selected: [String], iconMedia: PanelMedia, unavailable: Bool, chinese: Bool,
    onChange: @escaping ([String]) -> Void, onDismiss: @escaping () -> Void) {
    self.options = options
    self.iconMedia = iconMedia
    self.selected = selected
    self.unavailable = unavailable
    self.chinese = chinese
    self.onChange = onChange
    self.onDismiss = onDismiss
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func loadView() {
    let listHeight = CGFloat(min(7, max(2, options.count))) * 27
    let root = PickerSurface(frame: NSRect(x: 0, y: 0, width: 300, height: listHeight + 78))
    view = root
    search.frame = NSRect(x: 12, y: listHeight + 42, width: 276, height: 24)
    let searchLabel = local("Find source apps", "搜索来源应用")
    search.placeholderString = searchLabel
    search.setAccessibilityLabel(searchLabel)
    search.delegate = self
    root.addSubview(search)

    any.frame = NSRect(x: 13, y: listHeight + 14, width: 274, height: 23)
    any.setButtonType(.switch)
    any.title = local("Any app", "不限应用")
    any.target = self
    any.action = #selector(clearSelection)
    root.addSubview(any)

    scroll.frame = NSRect(x: 12, y: 9, width: 276, height: listHeight)
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay
    scroll.documentView = document
    root.addSubview(scroll)
    empty.frame = NSRect(x: 15, y: listHeight - 15, width: 270, height: 20)
    empty.textColor = .secondaryLabelColor
    empty.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    root.addSubview(empty)
    applySearch("")
  }

  override func viewDidAppear() {
    super.viewDidAppear()
    view.window?.makeFirstResponder(search)
  }
  override func cancelOperation(_ sender: Any?) { onDismiss() }

  func controlTextDidChange(_ notification: Notification) {
    guard notification.object as? NSSearchField === search else { return }
    applySearch(search.currentEditor()?.string ?? search.stringValue)
  }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
    guard !textView.hasMarkedText() else { return false }
    switch command {
    case #selector(cancelOperation(_:)): onDismiss()
    case #selector(insertTab(_:)): view.window?.makeFirstResponder(any)
    case #selector(insertBacktab(_:)): view.window?.makeFirstResponder(rows.last?.1 ?? any)
    default: return false
    }
    return true
  }

  private func applySearch(_ input: String) {
    let query = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let matches = options.filter { option in
      query.isEmpty || [option.name, option.source].contains {
        $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
      }
    }
    document.subviews.forEach { $0.removeFromSuperview() }
    rows = matches.enumerated().map { index, option in (option, makeRow(option, index: index)) }
    document.frame = NSRect(x: 0, y: 0, width: scroll.bounds.width, height: CGFloat(rows.count) * 27)
    rows.forEach { document.addSubview($0.1) }
    let keyViews: [NSView] = [search, any] + rows.map(\.1)
    for (index, current) in keyViews.enumerated() {
      current.nextKeyView = keyViews[(index + 1) % keyViews.count]
      (current as? Choice)?.previous = keyViews[(index + keyViews.count - 1) % keyViews.count]
    }
    empty.isHidden = !rows.isEmpty
    empty.stringValue = emptyMessage(searching: !query.isEmpty)
    scroll.contentView.scroll(to: .zero)
    scroll.reflectScrolledClipView(scroll.contentView)
    updateChecks()
  }

  private func makeRow(_ option: Option, index: Int) -> Choice {
    let button = Choice(frame: NSRect(x: 1, y: CGFloat(index) * 27 + 1, width: 263, height: 25))
    button.setButtonType(.switch)
    let title = option.recent ? option.name : local("\(option.name) (Not recent)", "\(option.name)（非近期）")
    button.title = title
    button.lineBreakMode = .byTruncatingTail
    button.toolTip = title
    button.setAccessibilityLabel(title)
    if !option.iconPath.isEmpty {
      iconMedia.load(option.iconPath, pixels: 48) { [weak button] icon in
        guard let button, let icon else { return }
        PanelSourceIconLabel.update(button, title: title, icons: [icon], leading: 24, trailing: 2)
      }
    }
    button.target = self
    button.action = #selector(toggle(_:))
    button.tag = index
    return button
  }
  private func emptyMessage(searching: Bool) -> String {
    if searching { return local("No matching apps", "没有匹配的应用") }
    return unavailable ? local("Recent apps couldn’t be loaded", "无法加载近期应用")
      : local("No recent source apps", "没有近期来源应用")
  }
  private func updateChecks() {
    any.state = selected.isEmpty ? .on : .off
    for (option, row) in rows {
      row.state = selected.contains { $0.utf8.elementsEqual(option.source.utf8) } ? .on : .off
    }
  }
  @objc private func clearSelection() {
    selected = []
    updateChecks()
    onChange(selected)
  }
  @objc private func toggle(_ button: NSButton) {
    guard rows.indices.contains(button.tag) else { return }
    let source = rows[button.tag].0.source
    selected = button.state == .on ? selected + [source]
      : selected.filter { !$0.utf8.elementsEqual(source.utf8) }
    updateChecks()
    onChange(selected)
  }
  private func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }

  private final class PickerSurface: NSView {
    override func draw(_ dirtyRect: NSRect) {
      NSColor.windowBackgroundColor.setFill()
      dirtyRect.fill()
    }
  }

  private final class FlippedView: NSView { override var isFlipped: Bool { true } }
  private final class Choice: NSButton {
    weak var previous: NSView?
    override var acceptsFirstResponder: Bool { isEnabled }
    override func becomeFirstResponder() -> Bool {
      guard super.becomeFirstResponder() else { return false }
      scrollToVisible(bounds)
      return true
    }
    override func keyDown(with event: NSEvent) {
      let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])
      if event.keyCode == 48 && (modifiers.isEmpty || modifiers == .shift) {
        window?.makeFirstResponder(modifiers == .shift ? previous : nextKeyView)
      } else { super.keyDown(with: event) }
    }
  }
}
