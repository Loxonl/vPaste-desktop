import AppKit

struct PanelTabEditorData: Decodable {
  enum Kind: String, Decodable { case filter, record }

  struct Filter: Decodable {
    let itemType: String
    let appSources: [String]
    let favorite: String
    let relativeAmount: String
    let relativeUnit: String

    static let defaults = Self(itemType: "", appSources: [], favorite: "any", relativeAmount: "", relativeUnit: "day")

    var fields: [String: Any] {
      ["itemType": itemType, "appSources": appSources, "favorite": favorite,
        "relativeAmount": relativeAmount, "relativeUnit": relativeUnit]
    }
  }

  struct Source: Decodable {
    let source: String
    let icon_path: String?
  }

  let kind: Kind
  let name: String
  let filter: Filter?
  let sources: [Source]?
  let emojis: [String]?
  let sourcesUnavailable: Bool?

  var initialFilter: Filter { filter ?? .defaults }
  var emojiChoices: [String] { Self.unique(emojis ?? []) }
  var sourceChoices: [String] { Self.unique((sources ?? []).map(\.source) + initialFilter.appSources) }

  fileprivate static func unique(_ strings: [String]) -> [String] {
    var seen = Set<Data>()
    return strings.map(\.trimmed).filter { !$0.isEmpty && seen.insert($0.identifier).inserted }
  }

  func selectedEmoji(in name: String) -> String {
    emojiChoices.filter { name.prefix($0.count).utf8.elementsEqual($0.utf8) }
      .max { $0.utf16.count < $1.utf16.count } ?? ""
  }

  func applyingEmoji(_ emoji: String, to name: String) -> String {
    guard emoji.isEmpty || emojiChoices.contains(emoji) else { return name }
    let current = selectedEmoji(in: name)
    guard current != emoji else { return name }
    let suffix = String(name.dropFirst(current.count))
    let text = current.isEmpty ? suffix : String(suffix.drop(while: \.isWhitespace))
    return emoji.isEmpty ? text : emoji + (text.isEmpty ? "" : " " + text)
  }

  enum Validation: Error { case emptyName, invalidName, invalidAmount }

  func payload(name draftName: String, filter draft: Filter?, chinese: Bool) throws -> [String: Any] {
    let name = draftName.trimmed
    if name.contains("\0") || (name.identifier != self.name.trimmed.identifier && name.utf16.count > 20) {
      throw Validation.invalidName
    }
    if kind == .record {
      guard !name.isEmpty else { throw Validation.emptyName }
      return ["name": name]
    }
    let filter = draft ?? initialFilter
    let amount = filter.relativeAmount.trimmed
    let savedAmount: String
    if !amount.isEmpty && (amount != initialFilter.relativeAmount.trimmed || filter.relativeUnit != initialFilter.relativeUnit) {
      guard amount.utf8.allSatisfy({ (48...57).contains($0) }),
        let value = UInt64(amount), (1...9_007_199_254_740_991).contains(value)
      else { throw Validation.invalidAmount }
      savedAmount = String(value)
    } else {
      savedAmount = amount
    }
    let cleaned = Filter(itemType: filter.itemType, appSources: Self.unique(filter.appSources),
      favorite: filter.favorite, relativeAmount: savedAmount, relativeUnit: filter.relativeUnit)
    let labels = PanelTabEditorLabels(chinese: chinese)
    return ["name": name.isEmpty ? labels.fallbackName(cleaned) : name, "filter": cleaned.fields]
  }
}

private extension String {
  var identifier: Data { Data(utf8) }
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

private struct PanelTabEditorLabels {
  let chinese: Bool
  func text(_ english: String, _ chinese: String) -> String { self.chinese ? chinese : english }
  var any: String { text("Any", "不限") }
  var add: String { text("Add Tab", "添加标签") }
  var recent: String { text("Recent", "最近") }
  var types: [(String, String)] {
    [("", any), ("Text", text("Text", "文本")), ("Image", text("Image", "图片")),
      ("File", text("File", "文件")), ("Link", text("Link", "链接")), ("Color", text("Color", "颜色"))]
  }
  var favorites: [(String, String)] {
    [("any", any), ("yes", text("Favorites only", "仅收藏")), ("no", text("Not favorite", "未收藏"))]
  }
  var units: [(String, String)] {
    [("minute", text("Minutes", "分钟")), ("hour", text("Hours", "小时")), ("day", text("Days", "天")),
      ("week", text("Weeks", "周")), ("month", text("Months", "月"))]
  }
  func sourceName(_ source: String) -> String {
    source.lowercased().hasSuffix(".exe") ? String(source.dropLast(4)) : source
  }
  func sourceSummary(_ sources: [String]) -> String {
    if sources.isEmpty { return any }
    if sources.count == 1 { return sourceName(sources[0]) }
    return text("\(sources.count) apps selected", "已选择 \(sources.count) 个应用")
  }
  func fallbackName(_ filter: PanelTabEditorData.Filter) -> String {
    if !filter.appSources.isEmpty { return sourceSummary(filter.appSources) }
    if !filter.itemType.isEmpty { return types.first { $0.0 == filter.itemType }?.1 ?? filter.itemType }
    if let favorite = favorites.dropFirst().first(where: { $0.0 == filter.favorite }) { return favorite.1 }
    if !filter.relativeAmount.isEmpty {
      let unit = units.first { $0.0 == filter.relativeUnit }?.1 ?? filter.relativeUnit
      return text("\(recent) \(filter.relativeAmount) \(unit)", "\(recent)\(filter.relativeAmount)\(unit)")
    }
    return add
  }
  func title(kind: PanelTabEditorData.Kind, new: Bool) -> String {
    switch (kind, new) {
    case (.filter, true): return add
    case (.filter, false): return text("Edit Tab", "编辑标签")
    case (.record, true): return text("Add Record Tag", "添加记录型标签")
    case (.record, false): return text("Edit Record Tag", "编辑记录型标签")
    }
  }
}

final class PanelTabEditorWindow: NSPanel {
  enum Shortcut { case cancel, save }
  var onShortcut: ((Shortcut) -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  static func allowsParentBlur(editorOpen: Bool, applicationActive: Bool, parentKey: Bool) -> Bool {
    !editorOpen && (!parentKey || !applicationActive)
  }

  static func shortcut(keyCode: UInt16, modifiers: NSEvent.ModifierFlags, composing: Bool) -> Shortcut? {
    guard !composing else { return nil }
    let keys = modifiers.intersection([.command, .control, .option, .shift])
    if keyCode == 53 && keys.isEmpty { return .cancel }
    if (keyCode == 36 || keyCode == 76) && (keys == .command || keys == .control) { return .save }
    return nil
  }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let onShortcut,
      let shortcut = Self.shortcut(keyCode: event.keyCode, modifiers: event.modifierFlags,
        composing: (firstResponder as? NSTextInputClient)?.hasMarkedText() == true) {
      if !event.isARepeat { onShortcut(shortcut) }
      return
    }
    super.sendEvent(event)
  }

  static func anchoredFrame(size preferredSize: NSSize, at anchor: NSPoint, in visible: NSRect) -> NSRect {
    let size = NSSize(width: min(preferredSize.width, visible.width), height: min(preferredSize.height, visible.height))
    let gap: CGFloat = 6
    let x = max(visible.minX, min(anchor.x, visible.maxX - size.width))
    let below = anchor.y - gap - size.height
    let preferred = below >= visible.minY ? below : anchor.y + gap
    let y = max(visible.minY, min(preferred, visible.maxY - size.height))
    return NSRect(origin: NSPoint(x: x, y: y), size: size)
  }
}

@MainActor
final class PanelTabEditor: NSObject, NSTextFieldDelegate {
  private let data: PanelTabEditorData
  private let labels: PanelTabEditorLabels
  private let onSave: ([String: Any]) -> Void
  private let onCancel: () -> Void
  private let panel: PanelTabEditorWindow
  private let formView = FlippedView()
  private let form = NSStackView()
  private var visibleFrame: NSRect?
  private static let contentWidth: CGFloat = 316
  private var formSize = NSSize.zero
  private let name = NSTextField()
  private let emoji = NSButton()
  let emojiPopover = NSPopover()
  private let type = NSPopUpButton()
  private let favorite = NSPopUpButton()
  private let unit = NSPopUpButton()
  private let amount = NSTextField()
  private let sourceButton = NSButton()
  let sourcePopover = NSPopover()
  private let status = NSTextField(wrappingLabelWithString: "")
  private let save = NSButton()
  private let cancel = NSButton()
  private var selectedSources: [String]
  private let originalPrefix: String
  private let originalNameBody: String
  private var prefix: String
  private var active = false
  private var busy = false

  init(data: PanelTabEditorData, chinese: Bool, onSave: @escaping ([String: Any]) -> Void,
    onCancel: @escaping () -> Void) {
    self.data = data
    self.labels = PanelTabEditorLabels(chinese: chinese)
    self.onSave = onSave
    self.onCancel = onCancel
    self.selectedSources = PanelTabEditorData.unique(data.initialFilter.appSources)
    let originalPrefix = data.selectedEmoji(in: data.name)
    self.originalPrefix = originalPrefix
    self.originalNameBody = data.applyingEmoji("", to: data.name)
    self.prefix = originalPrefix
    panel = PanelTabEditorWindow(contentRect: NSRect(x: 0, y: 0, width: 316, height: 100),
      styleMask: [.titled, .utilityWindow], backing: .buffered, defer: false)
    super.init()
    panel.isReleasedWhenClosed = false
    panel.isMovable = false
    panel.hidesOnDeactivate = false
    panel.animationBehavior = .none
    panel.title = labels.title(kind: data.kind, new: data.name.isEmpty)
    panel.onShortcut = { [weak self] shortcut in
      guard let self else { return }
      if self.emojiPopover.isShown || self.sourcePopover.isShown {
        if shortcut == .cancel { self.closePopovers() }
        return
      }
      switch shortcut {
      case .cancel: self.cancelDraft()
      case .save: self.submit()
      }
    }
    buildForm()
  }

  var isKeyWindow: Bool {
    panel.isKeyWindow || emojiPopover.contentViewController?.view.window?.isKeyWindow == true
      || sourcePopover.contentViewController?.view.window?.isKeyWindow == true
  }

  func show(parent: NSWindow, anchor: NSPoint) {
    guard !active else { activate(); return }
    active = true
    panel.level = parent.level
    panel.appearance = parent.appearance
    if let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) ?? parent.screen ?? NSScreen.main {
      visibleFrame = screen.visibleFrame
      let size = panel.frameRect(forContentRect: NSRect(origin: .zero, size: formSize)).size
      let frame = PanelTabEditorWindow.anchoredFrame(size: size, at: anchor, in: screen.visibleFrame)
      fitForm(in: panel.contentRect(forFrameRect: frame).size)
      panel.setFrame(frame, display: false)
    }
    parent.addChildWindow(panel, ordered: .above)
    panel.initialFirstResponder = name
    activate()
    panel.makeFirstResponder(name)
  }

  func activate() {
    guard active, !isKeyWindow else { return }
    panel.makeKeyAndOrderFront(nil)
  }

  func close() {
    guard active else { return }
    active = false
    closePopovers()
    panel.parent?.removeChildWindow(panel)
    panel.close()
  }

  func reportError(_ text: String) {
    guard active else { return }
    setBusy(false)
    setStatus(text.isEmpty ? labels.text("Couldn’t save the tag. Try again.", "无法保存标签，请重试。") : text, error: true)
  }

  private func fitForm(in available: NSSize) {
    if available.width >= formSize.width && available.height >= formSize.height {
      if let scroll = panel.contentView as? NSScrollView { scroll.documentView = nil }
      panel.contentView = formView
      return
    }
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = available.width < formSize.width
    scroll.autohidesScrollers = true
    panel.contentView = scroll
    formView.frame = NSRect(origin: .zero, size: formSize)
    scroll.documentView = formView
  }

  private func buildForm() {
    let root = formView
    form.translatesAutoresizingMaskIntoConstraints = false
    form.orientation = .vertical
    form.alignment = .leading
    form.spacing = 9
    let nameTitle = labels.text("Name", "名称")
    setupField(name, value: originalNameBody, label: nameTitle)
    configureEmoji()
    let nameRow = labeled(nameTitle, stack([emoji, name], spacing: 8))
    form.addArrangedSubview(nameRow)
    nameRow.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
    if data.kind == .filter {
      for row in filterRows() {
        form.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
      }
    } else {
      let hint = NSTextField(wrappingLabelWithString: labels.text(
        "After creating the tag, right-click a record to add it.", "创建后，右键记录即可添加此标签。"))
      hint.textColor = .secondaryLabelColor
      form.addArrangedSubview(hint)
      hint.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
    }
    configureFooter(form)
    root.addSubview(form)
    NSLayoutConstraint.activate([
      form.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
      form.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
      form.widthAnchor.constraint(equalToConstant: Self.contentWidth - 28),
    ])
    panel.contentView = root
    measureForm()
    panel.setContentSize(formSize)
    let controls: [NSControl] = [emoji, name] + (data.kind == .filter
      ? [type, favorite, amount, unit, sourceButton] : []) + [cancel, save]
    for (current, next) in zip(controls, Array(controls.dropFirst()) + [emoji]) {
      current.nextKeyView = next
    }
  }

  private func measureForm() {
    formView.layoutSubtreeIfNeeded()
    formSize = NSSize(width: Self.contentWidth, height: ceil(form.fittingSize.height) + 28)
  }

  private func resizeForStatus() {
    let previous = formSize
    measureForm()
    guard previous != formSize, active, let visibleFrame else { return }
    let old = panel.frame
    let preferred = panel.frameRect(forContentRect: NSRect(origin: .zero, size: formSize)).size
    let height = min(preferred.height, visibleFrame.height)
    let frame = NSRect(x: old.minX, y: max(visibleFrame.minY, old.maxY - height),
      width: old.width, height: height)
    let available = panel.contentRect(forFrameRect: frame).size
    if panel.contentView is NSScrollView || available.width < formSize.width || available.height < formSize.height {
      fitForm(in: available)
    }
    panel.setFrame(frame, display: true)
  }

  private func configureFooter(_ form: NSStackView) {
    status.textColor = .secondaryLabelColor
    status.maximumNumberOfLines = 2
    status.isHidden = true
    form.addArrangedSubview(status)
    status.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
    let divider = NSBox()
    divider.boxType = .separator
    form.addArrangedSubview(divider)
    divider.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
    setupButton(cancel, title: labels.text("Cancel", "取消"), action: #selector(cancelDraft))
    setupButton(save, title: labels.text("Save", "保存"), action: #selector(submit))
    save.bezelColor = .controlAccentColor
    let actions = stack([cancel, save], spacing: 8)
    let footer = NSView()
    footer.addSubview(actions)
    form.addArrangedSubview(footer)
    NSLayoutConstraint.activate([
      footer.widthAnchor.constraint(equalTo: form.widthAnchor),
      actions.topAnchor.constraint(equalTo: footer.topAnchor),
      actions.bottomAnchor.constraint(equalTo: footer.bottomAnchor),
      actions.trailingAnchor.constraint(equalTo: footer.trailingAnchor),
    ])
  }

  private func configureEmoji() {
    let title = labels.text("Emoji prefix", "表情前缀")
    setupButton(emoji, title: "", action: #selector(openEmojiPicker))
    emoji.widthAnchor.constraint(equalToConstant: 44).isActive = true
    emoji.setAccessibilityLabel(title)
    emoji.toolTip = title
    emoji.isEnabled = !data.emojiChoices.isEmpty
    emojiPopover.behavior = .transient
    emojiPopover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    updateEmojiButton()
  }

  private func filterRows() -> [NSView] {
    let filter = data.initialFilter
    let typeTitle = labels.text("Type", "类型")
    let favoriteTitle = labels.text("Favorite State", "收藏状态")
    let unitTitle = labels.text("Unit", "单位")
    populate(type, choices: labels.types, current: filter.itemType, label: typeTitle)
    populate(favorite, choices: labels.favorites, current: filter.favorite, label: favoriteTitle)
    populate(unit, choices: labels.units, current: filter.relativeUnit, label: unitTitle)
    setupField(amount, value: filter.relativeAmount, label: labels.recent)
    amount.placeholderString = labels.any
    let title = labels.text("Source app", "来源应用")
    setupButton(sourceButton, title: "", action: #selector(openSourcePicker))
    sourceButton.alignment = .left
    sourceButton.lineBreakMode = .byTruncatingTail
    sourceButton.setAccessibilityLabel(title)
    sourceButton.image = NSImage(systemSymbolName: "chevron.up.chevron.down", accessibilityDescription: nil)
    sourceButton.imagePosition = .imageTrailing
    sourceButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    sourcePopover.behavior = .transient
    sourcePopover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    updateSources()
    return [paired(labeled(typeTitle, type), labeled(favoriteTitle, favorite)),
      paired(labeled(labels.recent, amount), labeled(unitTitle, unit)), labeled(title, sourceButton)]
  }

  private func paired(_ leading: NSView, _ trailing: NSView) -> NSStackView {
    let pair = stack([leading, trailing], spacing: 12)
    pair.alignment = .top
    pair.distribution = .fillEqually
    return pair
  }

  private final class FlippedView: NSView { override var isFlipped: Bool { true } }

  private func labeled(_ title: String, _ control: NSView) -> NSStackView {
    let label = NSTextField(labelWithString: title)
    label.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
    let column = stack([label, control], vertical: true, spacing: 4)
    control.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
    return column
  }

  private func stack(_ views: [NSView] = [], vertical: Bool = false, spacing: CGFloat) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = vertical ? .vertical : .horizontal
    stack.alignment = vertical ? .leading : .centerY
    stack.spacing = spacing
    return stack
  }

  private func setupField(_ field: NSTextField, value: String, label: String) {
    field.stringValue = value
    field.delegate = self
    field.usesSingleLineMode = true
    field.setAccessibilityLabel(label)
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
  }

  private func setupButton(_ button: NSButton, title: String, action: Selector) {
    button.title = title
    button.bezelStyle = .rounded
    button.target = self
    button.action = action
    button.setContentHuggingPriority(.required, for: .horizontal)
  }

  private func populate(_ popup: NSPopUpButton, choices: [(String, String)], current: String, label: String) {
    popup.setAccessibilityLabel(label)
    let options = choices.contains { $0.0 == current } ? choices : choices + [(current, current)]
    for (value, title) in options {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.representedObject = value
      popup.menu?.addItem(item)
      if value == current { popup.select(item) }
    }
    popup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
  }

  private func value(_ popup: NSPopUpButton, fallback: String) -> String {
    popup.selectedItem?.representedObject as? String ?? fallback
  }

  private func liveValue(_ field: NSTextField) -> String { field.currentEditor()?.string ?? field.stringValue }

  private func nameWithPrefix() -> String {
    let body = liveValue(name)
    if prefix.identifier == originalPrefix.identifier && body.identifier == originalNameBody.identifier {
      return data.name
    }
    if prefix.isEmpty { return body }
    return body.trimmed.isEmpty ? prefix : "\(prefix) \(body.trimmed)"
  }

  private func updateEmojiButton() {
    emoji.title = prefix.isEmpty ? "＋" : prefix
    emoji.setAccessibilityValue(prefix.isEmpty ? labels.text("No emoji", "不使用图标") : prefix)
  }

  @objc private func openEmojiPicker() {
    guard active, !busy, !data.emojiChoices.isEmpty else { return }
    if emojiPopover.isShown { emojiPopover.close(); return }
    guard (panel.firstResponder as? NSTextInputClient)?.hasMarkedText() != true else { return }
    sourcePopover.close()
    let picker = PanelEmojiPicker(emojis: data.emojiChoices, selected: data.selectedEmoji(in: nameWithPrefix()),
      chinese: labels.chinese, choose: { [weak self] in self?.chooseEmoji($0) },
      dismiss: { [weak self] in self?.emojiPopover.close() })
    emojiPopover.contentViewController = picker
    emojiPopover.show(relativeTo: emoji.bounds, of: emoji, preferredEdge: emoji.isFlipped ? .minY : .maxY)
  }

  private func chooseEmoji(_ choice: String) {
    let raw = nameWithPrefix()
    let body = data.applyingEmoji("", to: raw)
    emojiPopover.close()
    if let fieldEditor = name.currentEditor() as? NSTextView {
      fieldEditor.string = body
    } else {
      name.stringValue = body
    }
    prefix = choice
    updateEmojiButton()
    panel.makeFirstResponder(name)
  }

  @objc private func openSourcePicker() {
    guard active, !busy, data.kind == .filter else { return }
    if sourcePopover.isShown { sourcePopover.close(); return }
    guard (panel.firstResponder as? NSTextInputClient)?.hasMarkedText() != true else { return }
    emojiPopover.close()
    let recent = Set((data.sources ?? []).map { $0.source.trimmed.identifier })
    let options = data.sourceChoices.map { source in
      PanelSourcePicker.Option(source: source, name: labels.sourceName(source),
        recent: recent.contains(source.identifier))
    }
    let picker = PanelSourcePicker(options: options, selected: selectedSources,
      unavailable: data.sourcesUnavailable == true, chinese: labels.chinese, onChange: { [weak self] selected in
        self?.selectedSources = selected
        self?.updateSources()
      }, onDismiss: { [weak self] in self?.sourcePopover.close() })
    sourcePopover.contentViewController = picker
    sourcePopover.show(relativeTo: sourceButton.bounds, of: sourceButton,
      preferredEdge: sourceButton.isFlipped ? .minY : .maxY)
  }

  private func updateSources() {
    let summary = labels.sourceSummary(selectedSources)
    sourceButton.title = summary
    sourceButton.toolTip = summary
    sourceButton.setAccessibilityValue(summary)
  }

  private func closePopovers() {
    emojiPopover.close()
    sourcePopover.close()
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
    guard command == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText() else { return false }
    submit()
    return true
  }

  @objc private func submit() {
    guard active, !busy, !emojiPopover.isShown, !sourcePopover.isShown,
      (panel.firstResponder as? NSTextInputClient)?.hasMarkedText() != true else { return }
    let initial = data.initialFilter
    let draft = PanelTabEditorData.Filter(itemType: value(type, fallback: initial.itemType), appSources: selectedSources,
      favorite: value(favorite, fallback: initial.favorite), relativeAmount: liveValue(amount),
      relativeUnit: value(unit, fallback: initial.relativeUnit))
    do {
      let payload = try data.payload(name: nameWithPrefix(), filter: draft, chinese: labels.chinese)
      panel.makeFirstResponder(nil)
      setBusy(true)
      setStatus(labels.text("Saving…", "正在保存…"), error: false)
      onSave(payload)
    } catch PanelTabEditorData.Validation.invalidAmount {
      panel.makeFirstResponder(amount)
      setStatus(labels.text("Enter a positive whole number for the time range.", "时间范围请输入正整数。"), error: true)
    } catch PanelTabEditorData.Validation.emptyName {
      panel.makeFirstResponder(name)
      setStatus(labels.text("Enter a tag name.", "请输入标签名称。"), error: true)
    } catch {
      panel.makeFirstResponder(name)
      setStatus(labels.text("Enter a name of at most 20 UTF-16 units.", "名称最多可含 20 个 UTF-16 代码单元。"), error: true)
    }
  }

  @objc private func cancelDraft() {
    guard active, !busy else { return }
    close()
    onCancel()
  }

  private func setBusy(_ busy: Bool) {
    self.busy = busy
    let controls: [NSControl] = [name, type, favorite, amount, unit, sourceButton, cancel, save]
    controls.forEach { $0.isEnabled = !busy }
    emoji.isEnabled = !busy && !data.emojiChoices.isEmpty
    updateSources()
  }

  private func setStatus(_ message: String, error: Bool) {
    status.stringValue = message
    status.isHidden = message.isEmpty
    resizeForStatus()
    status.toolTip = error ? message : nil
    status.textColor = error ? .systemRed : .secondaryLabelColor
    if error, let app = NSApp {
      NSAccessibility.post(element: app, notification: .announcementRequested,
        userInfo: [.announcement: message, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }
  }
}
