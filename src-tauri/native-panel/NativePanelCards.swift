import AppKit
import QuartzCore

final class PanelListLayout: NSCollectionViewFlowLayout {
  override init() {
    super.init()
    // NSCollectionView uses the flow direction to permit horizontal resizing.
    scrollDirection = .horizontal
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  var cardWidth: CGFloat = 220
  var gap: CGFloat = 16
  var inset: CGFloat = 16
  var itemCount = 0
  var viewportSize = NSSize(width: 1, height: 240)
  var verticalInset: CGFloat = 12
  var maximumCardHeight: CGFloat = 230
  var cardHeight: CGFloat {
    min(maximumCardHeight, max(100, viewportSize.height - verticalInset * 2))
  }
  override var collectionViewContentSize: NSSize {
    NSSize(
      width: max(
        viewportSize.width,
        CGFloat(itemCount) * (cardWidth + gap) + inset * 2
          - gap),
      height: viewportSize.height)
  }
  override func layoutAttributesForItem(at indexPath: IndexPath)
    -> NSCollectionViewLayoutAttributes?
  {
    guard indexPath.item >= 0, indexPath.item < itemCount else { return nil }
    let value = NSCollectionViewLayoutAttributes(forItemWith: indexPath)
    value.frame = NSRect(
      x: inset + CGFloat(indexPath.item) * (cardWidth + gap), y: verticalInset,
      width: cardWidth, height: cardHeight)
    return value
  }
  override func layoutAttributesForElements(in rect: NSRect) -> [NSCollectionViewLayoutAttributes] {
    let count = itemCount
    let first = min(count, max(0, Int(floor((rect.minX - inset) / (cardWidth + gap)))))
    let last = min(count, max(first, Int(ceil((rect.maxX - inset) / (cardWidth + gap))) + 1))
    return (first..<last).compactMap {
      layoutAttributesForItem(at: IndexPath(item: $0, section: 0))
    }
  }
  override func shouldInvalidateLayout(forBoundsChange newBounds: NSRect) -> Bool {
    newBounds.size != collectionView?.bounds.size
  }
}
final class PanelList: NSCollectionView {
  var keyHandler: ((NSEvent) -> Bool)?
  override func keyDown(with event: NSEvent) {
    if keyHandler?(event) != true { super.keyDown(with: event) }
  }
  override var acceptsFirstResponder: Bool { true }
}
final class PanelScroll: NSScrollView {
  // NSCollectionView updates these again during layout, after documentView's
  // setter returns. Reject that automatic opt-in while retaining the document's
  // full horizontal extent for wheel/keyboard scrolling.
  override var hasHorizontalScroller: Bool {
    get { super.hasHorizontalScroller }
    set { super.hasHorizontalScroller = false }
  }
  override var hasVerticalScroller: Bool {
    get { super.hasVerticalScroller }
    set { super.hasVerticalScroller = false }
  }
  override init(frame: NSRect) {
    super.init(frame: frame)
    hasHorizontalScroller = false
    hasVerticalScroller = false
    horizontalScrollElasticity = .none
    verticalScrollElasticity = .none
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // Use the dominant axis, as the main panel does. A mostly vertical trackpad
  // gesture often contains a small X delta; it must still browse the row.
  static func targetOffset(
    current: CGFloat, maximum: CGFloat, deltaX: CGFloat, deltaY: CGFloat, precise: Bool
  ) -> CGFloat {
    let delta = abs(deltaY) > abs(deltaX) ? deltaY : deltaX
    return max(0, min(max(0, maximum), current - delta * (precise ? 1 : 12)))
  }
  override func scrollWheel(with event: NSEvent) {
    var point = contentView.bounds.origin
    point.x = Self.targetOffset(
      current: point.x, maximum: (documentView?.bounds.width ?? 0) - contentView.bounds.width,
      deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY,
      precise: event.hasPreciseScrollingDeltas)
    point.y = 0
    contentView.scroll(to: point)
    reflectScrolledClipView(contentView)
  }
}

@MainActor
final class PanelCardItem: NSCollectionViewItem {
  var cardView: PanelCardView { view as! PanelCardView }
  override func loadView() { view = PanelCardView(frame: .zero) }
  override func prepareForReuse() {
    super.prepareForReuse()
    cardView.releaseContent()
  }
}

@MainActor
final class PanelCardView: NSView, NSDraggingSource {
  override var isFlipped: Bool { true }
  private let title = NSTextField(labelWithString: "")
  private let age = NSTextField(labelWithString: "")
  private let icon = NSImageView()
  private let image = NSImageView()
  private let dimensions = NSTextField(labelWithString: "")
  private let text = NSTextView()
  private let textScroll = NSScrollView()
  private let formatTag = NSTextField(labelWithString: "")
  private let favoriteMark = NSTextField(labelWithString: "★")
  private let iconCrop = NSView()
  private let kindIcon = NSImageView()
  private let fileFormat = NSTextField(labelWithString: "")
  private let detailTitle = NSTextField(labelWithString: "")
  private let detailSubtitle = NSTextField(labelWithString: "")
  private var tagBadges: [NSTextField] = []
  private let selectionOutline = CAShapeLayer()
  private var headerGradientEnd: NSColor?
  private var richDark = false
  private var tracking: NSTrackingArea?
  private var hoverTimer: Timer?
  private let gif = PanelGIF()
  private var down: NSEvent?
  private var dragging = false
  private var tint = NSColor.systemGreen
  private var scale: CGFloat = 1
  private var chinese = false
  private var query = ""
  private(set) var card: PanelCard?
  var select: (() -> Void)?
  var activate: (() -> Void)?
  var menuAction: ((String) -> Void)?
  var prepareDrag: ((@escaping ([String: Any]) -> Void) -> Void)?
  var dragEnded: (() -> Void)?
  var singleClick = false
  var selected = false {
    didSet {
      if oldValue != selected {
        needsDisplay = true
        selectionOutline.isHidden = !selected
        updateAnimation()
      }
    }
  }
  private var media: PanelMedia?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = PanelStyle.cardRadius
    layer?.masksToBounds = false
    selectionOutline.fillColor = NSColor.clear.cgColor
    selectionOutline.isHidden = true
    layer?.addSublayer(selectionOutline)
    title.textColor = .white
    title.font = .boldSystemFont(ofSize: 16)
    age.textColor = .white
    age.font = .systemFont(ofSize: 12)
    dimensions.font = .systemFont(ofSize: 12)
    dimensions.alignment = .center
    dimensions.textColor = .secondaryLabelColor
    icon.imageScaling = .scaleProportionallyUpOrDown
    image.imageScaling = .scaleProportionallyDown
    text.isEditable = false
    text.isSelectable = false
    text.drawsBackground = false
    text.textContainerInset = NSSize(width: 0, height: 4)
    text.textContainer?.lineFragmentPadding = 0
    text.isVerticallyResizable = true
    text.isHorizontallyResizable = false
    text.autoresizingMask = [.width]
    textScroll.drawsBackground = false
    textScroll.hasVerticalScroller = false
    textScroll.documentView = text
    iconCrop.wantsLayer = true
    iconCrop.layer?.masksToBounds = true
    iconCrop.addSubview(icon)
    for view in [
      title, age, iconCrop, textScroll, image, dimensions, formatTag, favoriteMark, kindIcon,
      fileFormat, detailTitle, detailSubtitle,
    ] { addSubview(view) }
    for field in [formatTag, favoriteMark, dimensions, fileFormat] {
      field.alignment = .center
      field.wantsLayer = true
      field.layer?.masksToBounds = true
    }
    title.lineBreakMode = .byTruncatingTail
    age.lineBreakMode = .byTruncatingTail
    detailTitle.lineBreakMode = .byTruncatingMiddle
    detailSubtitle.lineBreakMode = .byTruncatingMiddle
    kindIcon.imageScaling = .scaleProportionallyUpOrDown
    textScroll.wantsLayer = true
    textScroll.layer?.cornerRadius = 7
    textScroll.layer?.masksToBounds = true
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func hitTest(_ point: NSPoint) -> NSView? {
    bounds.contains(convert(point, from: superview)) ? self : nil
  }
  private var bodyRect: NSRect {
    NSRect(
      x: 8 * scale, y: 56 * scale, width: bounds.width - 16 * scale,
      height: max(1, bounds.height - 64 * scale))
  }
  private var mediaRect: NSRect {
    var rect = bodyRect
    if card?.itemType == "Link" { rect.size.height = max(1, rect.height - 46 * scale) }
    if card?.itemType == "File" { rect.size.height = max(1, rect.height - 24 * scale) }
    return rect
  }
  override func layout() {
    super.layout()
    let radius = PanelStyle.cardRadius * scale
    layer?.cornerRadius = radius
    layer?.shadowColor = NSColor.black.cgColor
    layer?.shadowOpacity = PanelStyle.dark(self) ? 0.18 : 0.06
    layer?.shadowRadius = 3 * scale
    layer?.shadowOffset = NSSize(width: 0, height: -2 * scale)
    layer?.shadowPath = CGPath(
      roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
    selectionOutline.frame = bounds
    selectionOutline.path = CGPath(
      roundedRect: bounds.insetBy(dx: -3 * scale, dy: -3 * scale), cornerWidth: radius + 3 * scale,
      cornerHeight: radius + 3 * scale, transform: nil)
    selectionOutline.lineWidth = 2 * scale
    selectionOutline.strokeColor =
      (PanelStyle.dark(self) ? PanelStyle.accent(self) : PanelStyle.rgb(0x1976d2)).cgColor
    selectionOutline.isHidden = !selected
    let hasIcon = card.map { !$0.sourceIcon.isEmpty || $0.remote } ?? false
    let available =
      bounds.width - 24 * scale - (hasIcon ? 48 * scale : 0)
      - (card?.favorite == true ? 20 * scale : 0)
    let titleWidth = min(
      max(20 * scale, available),
      (title.stringValue as NSString).size(withAttributes: [.font: title.font!]).width + 6 * scale)
    title.frame = NSRect(x: 12 * scale, y: 7 * scale, width: titleWidth, height: 18 * scale)
    age.frame = NSRect(x: 12 * scale, y: 25 * scale, width: max(1, available), height: 16 * scale)
    formatTag.frame = NSRect(
      x: title.frame.maxX + 5 * scale, y: 8 * scale,
      width: min(
        56 * scale,
        (formatTag.stringValue as NSString).size(withAttributes: [.font: formatTag.font!]).width
          + 14 * scale, max(0, available - titleWidth - 5 * scale)), height: 16 * scale)
    iconCrop.frame = NSRect(
      x: bounds.width - 56 * scale, y: 0, width: 56 * scale, height: 48 * scale)
    let mask = CAShapeLayer()
    mask.path = CGPath(
      roundedRect: NSRect(
        x: -iconCrop.frame.minX, y: 0, width: bounds.width, height: bounds.height),
      cornerWidth: radius, cornerHeight: radius, transform: nil)
    iconCrop.layer?.mask = mask
    icon.frame = NSRect(x: -5 * scale, y: -12 * scale, width: 72 * scale, height: 72 * scale)
    favoriteMark.frame = NSRect(
      x: bounds.width - (hasIcon ? 76 : 28) * scale, y: 16 * scale, width: 18 * scale,
      height: 18 * scale)
    image.frame = mediaRect
    if let card, card.mediaWidth > 0, card.mediaHeight > 0 {
      let width = CGFloat(card.mediaWidth) * scale
      let height = CGFloat(card.mediaHeight) * scale
      let factor = min(1, mediaRect.width / width, mediaRect.height / height)
      image.frame = NSRect(
        x: mediaRect.midX - width * factor / 2, y: mediaRect.midY - height * factor / 2,
        width: width * factor, height: height * factor)
    }
    textScroll.frame = bodyRect
    text.frame = NSRect(origin: .zero, size: bodyRect.size)
    text.textContainer?.containerSize = NSSize(
      width: bodyRect.width - (card?.rich.isEmpty == false ? 16 * scale : 0),
      height: .greatestFiniteMagnitude)
    let dimensionWidth = min(
      bodyRect.width - 16 * scale,
      (dimensions.stringValue as NSString).size(withAttributes: [.font: dimensions.font!]).width
        + 14 * scale)
    dimensions.frame = NSRect(
      x: (bounds.width - dimensionWidth) / 2, y: mediaRect.maxY - 26 * scale, width: dimensionWidth,
      height: 18 * scale)
    let link = card?.itemType == "Link"
    let kindSize: CGFloat = (link ? 42 : 54) * scale
    kindIcon.frame = NSRect(
      x: (bounds.width - kindSize) / 2,
      y: mediaRect.midY - kindSize / 2, width: kindSize,
      height: kindSize)
    detailTitle.frame = NSRect(
      x: 12 * scale, y: link ? mediaRect.maxY + 8 * scale : bodyRect.midY + 10 * scale,
      width: bounds.width - 24 * scale, height: 20 * scale)
    detailSubtitle.frame = detailTitle.frame.offsetBy(dx: 0, dy: 21 * scale)
    if card?.itemType == "File" {
      detailSubtitle.frame = NSRect(
        x: 10 * scale, y: bodyRect.maxY - 18 * scale, width: bounds.width - 20 * scale,
        height: 18 * scale)
    }
    fileFormat.frame = NSRect(
      x: bounds.midX - 18 * scale, y: kindIcon.frame.maxY + 4 * scale, width: 36 * scale,
      height: 16 * scale)
    if card?.itemType == "Color" {
      detailTitle.frame = bodyRect.insetBy(dx: 8 * scale, dy: bodyRect.height / 2 - 12 * scale)
    }
    var tagX: CGFloat = 10 * scale
    for badge in tagBadges {
      let width = min(
        76 * scale,
        (badge.stringValue as NSString).size(withAttributes: [.font: badge.font!]).width + 14
          * scale)
      badge.frame = NSRect(x: tagX, y: 38 * scale, width: width, height: 19 * scale)
      badge.isHidden = badge.frame.maxX > bounds.width - 10 * scale
      tagX += width + 4 * scale
    }
  }
  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    // Preserve the experiment's existing card alpha as well as the page glass.
    let background = NSColor(
      calibratedWhite: PanelStyle.dark(self) ? 0.13 : 1, alpha: PanelStyle.dark(self) ? 0.95 : 0.88)
    let rounded = NSBezierPath(roundedRect: bounds, xRadius: 14 * scale, yRadius: 14 * scale)
    NSGraphicsContext.saveGraphicsState()
    rounded.addClip()
    background.setFill()
    bounds.fill()
    let header = NSRect(x: 0, y: 0, width: bounds.width, height: 48 * scale)
    if let end = headerGradientEnd {
      NSGradient(starting: tint, ending: end)?.draw(in: header, angle: -45)
    } else {
      tint.setFill()
      header.fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    if card?.itemType == "Color", let color = panelColor(card?.text ?? "") {
      color.setFill()
      NSBezierPath(roundedRect: bodyRect, xRadius: 6 * scale, yRadius: 6 * scale).fill()
    } else if card?.itemType == "File", card?.assetPath.isEmpty == true {
      (PanelStyle.dark(self) ? PanelStyle.rgb(0x0f1217, 0.72) : NSColor.white).setFill()
      NSBezierPath(roundedRect: mediaRect, xRadius: 8 * scale, yRadius: 8 * scale).fill()
      if let card, let tile = fileTile(card.fileFormat) {
        let rect = kindIcon.frame.insetBy(dx: 3 * scale, dy: 3 * scale)
        PanelStyle.rgb(tile.0).setFill()
        rect.fill()
        let label = tile.1 as NSString
        let font = NSFont.systemFont(ofSize: (label.length > 2 ? 16 : 24) * scale, weight: .bold)
        label.draw(
          in: NSRect(
            x: rect.minX + 3 * scale, y: rect.midY - 2 * scale, width: rect.width - 6 * scale,
            height: rect.height / 2 + 2 * scale),
          withAttributes: [
            .font: font, .foregroundColor: card.fileFormat == "JS" ? NSColor.black : NSColor.white,
          ])
      }
    } else if card?.itemType == "Link" {
      let color = PanelStyle.accent(self).withAlphaComponent(0.12)
      NSGradient(
        starting: color,
        ending: PanelStyle.dark(self)
          ? PanelStyle.rgb(0x1c2026, 0.88) : .white.withAlphaComponent(0.94))?.draw(
          in: NSBezierPath(roundedRect: mediaRect, xRadius: 8 * scale, yRadius: 8 * scale),
          angle: -45)
    }
  }
  private func fileTile(_ format: String) -> (UInt32, String)? {
    switch format {
    case "TS", "TSX": return (0x0288d1, "TS")
    case "JS", "JSX": return (0xf7df1e, "JS")
    case "JSON": return (0xf5a623, "{}")
    case "PDF": return (0xe53935, "PDF")
    case "DOC", "DOCX": return (0x2b579a, "W")
    case "XLS", "XLSX": return (0x217346, "X")
    case "PPT", "PPTX": return (0xd24726, "P")
    default: return nil
    }
  }
  func configure(
    _ card: PanelCard?, placeholder: String, media: PanelMedia, scale: CGFloat,
    chinese: Bool, query: String, selected: Bool
  ) {
    let previous = self.card?.hash
    if previous != card?.hash { releaseContent() }
    self.card = card
    self.scale = scale
    self.chinese = chinese
    self.media = media
    self.query = query
    layer?.cornerRadius = 14 * scale
    title.font = .systemFont(ofSize: 13 * scale, weight: .bold)
    age.font = .systemFont(ofSize: 11 * scale, weight: .medium)
    formatTag.font = .systemFont(ofSize: 10 * scale, weight: .semibold)
    formatTag.layer?.cornerRadius = 8 * scale
    formatTag.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.82).cgColor
    favoriteMark.font = .systemFont(ofSize: 12 * scale, weight: .bold)
    favoriteMark.textColor = PanelStyle.rgb(0x7b5400)
    favoriteMark.layer?.cornerRadius = 9 * scale
    favoriteMark.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.88).cgColor
    dimensions.font = .systemFont(ofSize: 11 * scale)
    dimensions.textColor =
      PanelStyle.dark(self) ? PanelStyle.rgb(0xdce7f7) : PanelStyle.rgb(0x1e2228, 0.88)
    dimensions.layer?.cornerRadius = 8 * scale
    dimensions.layer?.masksToBounds = false
    dimensions.layer?.shadowColor = NSColor.black.cgColor
    dimensions.layer?.shadowOpacity = 0.08
    dimensions.layer?.shadowRadius = scale
    dimensions.layer?.shadowOffset = NSSize(width: 0, height: -scale)
    dimensions.layer?.backgroundColor =
      (PanelStyle.dark(self) ? PanelStyle.rgb(0x0c0e12, 0.72) : PanelStyle.rgb(0xf8fafc, 0.68))
      .cgColor
    detailTitle.font = .systemFont(ofSize: 13 * scale, weight: .semibold)
    detailSubtitle.font = .systemFont(ofSize: 11 * scale)
    detailTitle.textColor = PanelStyle.text(self)
    detailSubtitle.textColor = PanelStyle.secondary(self)
    detailTitle.alignment = card?.itemType == "Link" ? .left : .center
    detailSubtitle.alignment = detailTitle.alignment
    fileFormat.font = .systemFont(ofSize: 10 * scale)
    fileFormat.textColor = PanelStyle.secondary(self)
    fileFormat.layer?.cornerRadius = 8 * scale
    fileFormat.layer?.backgroundColor =
      (PanelStyle.dark(self) ? PanelStyle.rgb(0x0c0e12, 0.72) : PanelStyle.rgb(0xf8fafc, 0.68))
      .cgColor
    for badge in tagBadges { badge.removeFromSuperview() }
    tagBadges.removeAll()
    self.selected = selected
    guard let card else {
      title.stringValue = placeholder
      age.stringValue = ""
      tint = .systemGray
      text.string = ""
      image.image = nil
      icon.image = nil
      dimensions.stringValue = ""
      for view in [
        formatTag, favoriteMark, kindIcon, fileFormat, detailTitle, detailSubtitle, dimensions,
      ] { view.isHidden = true }
      headerGradientEnd = nil
      needsDisplay = true
      return
    }
    let visualType = card.itemType == "File" && !card.assetPath.isEmpty ? "Image" : card.itemType
    let names = [
      "Text": "文本", "TextFile": "文本", "Image": "图片", "File": "文件", "Link": "链接", "Color": "颜色",
    ]
    title.stringValue =
      (chinese
        ? names[visualType] ?? visualType
        : (visualType == "TextFile" ? "Text" : visualType))
    formatTag.stringValue = !card.rich.isEmpty ? "Rich" : card.isGif ? "GIF" : ""
    formatTag.isHidden = formatTag.stringValue.isEmpty
    favoriteMark.isHidden = !card.favorite
    let date = Date(
      timeIntervalSince1970: Double(card.time) / (card.time > 100_000_000_000 ? 1000 : 1))
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: chinese ? "zh_CN" : "en_US")
    formatter.unitsStyle = .abbreviated
    age.stringValue = formatter.localizedString(for: date, relativeTo: Date())
    let defaults: [String: UInt32] = [
      "Image": 0xff9800, "Text": 0x4caf50, "TextFile": 0x4caf50, "Link": 0x2f6fed, "File": 0x00bcd4,
      "Color": 0x2196f3,
    ]
    headerGradientEnd = nil
    let hasSourceIcon = !card.sourceIcon.isEmpty || card.remote
    if let color = panelColor(card.color) {
      tint = PanelStyle.headerContrast(color)
    } else if hasSourceIcon {
      tint = PanelStyle.rgb(0x747c87)
      headerGradientEnd = PanelStyle.rgb(0x565e68)
    } else {
      tint = PanelStyle.headerContrast(PanelStyle.rgb(defaults[card.itemType] ?? 0x4caf50))
      if card.itemType == "Link" {
        headerGradientEnd = PanelStyle.headerContrast(PanelStyle.rgb(0x66c2ff))
      }
    }
    formatTag.textColor = tint
    dimensions.stringValue = card.dimensions
    dimensions.isHidden = card.dimensions.isEmpty || card.itemType == "Link"
    kindIcon.image = NSImage(
      systemSymbolName: card.displaySymbol.isEmpty ? "doc.fill" : card.displaySymbol,
      accessibilityDescription: nil)
    kindIcon.contentTintColor =
      card.itemType == "Link"
      ? PanelStyle.accent(self)
      : (PanelStyle.dark(self) ? PanelStyle.rgb(0xd7deea) : PanelStyle.rgb(0x7b8794))
    kindIcon.isHidden =
      !["File", "Link"].contains(card.itemType) || !card.assetPath.isEmpty
      || (card.itemType == "File" && fileTile(card.fileFormat) != nil)
    detailTitle.stringValue = card.displayTitle
    detailSubtitle.stringValue = card.displaySubtitle
    detailSubtitle.lineBreakMode = card.itemType == "File" ? .byTruncatingHead : .byTruncatingTail
    detailTitle.lineBreakMode = .byTruncatingTail
    detailTitle.isHidden = !["Link", "Color"].contains(card.itemType)
    detailSubtitle.isHidden = !["File", "Link"].contains(card.itemType)
    fileFormat.stringValue = card.fileFormat
    fileFormat.isHidden =
      card.itemType != "File" || !card.assetPath.isEmpty || card.fileFormat.isEmpty
    if card.itemType == "Color", let color = panelColor(card.text) {
      detailTitle.stringValue = card.text
      detailTitle.textColor = PanelStyle.luminance(color) > 0.4 ? .black : .white
    }
    let tagNames =
      Array(card.tags.prefix(2)).map(\.name)
      + (card.tags.count > 2 ? ["+\(card.tags.count-2)"] : [])
    for name in tagNames {
      let badge = NSTextField(labelWithString: name)
      badge.font = .systemFont(ofSize: 11 * scale, weight: .semibold)
      badge.textColor = PanelStyle.rgb(0x114f9e)
      badge.alignment = .center
      badge.lineBreakMode = .byTruncatingTail
      badge.wantsLayer = true
      badge.layer?.cornerRadius = 9 * scale
      badge.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.9).cgColor
      badge.toolTip = card.tags.map(\.name).joined(separator: ", ")
      addSubview(badge)
      tagBadges.append(badge)
    }
    toolTip = card.source.isEmpty ? nil : card.source
    setAccessibilityLabel("\(title.stringValue), \(card.source), \(String(card.text.prefix(180)))")
    let hash = card.hash
    icon.image =
      card.remote
      ? NSImage(
        systemSymbolName: "laptopcomputer.and.iphone", accessibilityDescription: "Remote clipboard")
      : nil
    if !card.sourceIcon.isEmpty {
      media.load(card.sourceIcon, pixels: 96) { [weak self] value in
        guard self?.card?.hash == hash else { return }
        if let value { self?.icon.image = value }
      }
    }
    image.isHidden = card.assetPath.isEmpty
    textScroll.isHidden =
      !card.assetPath.isEmpty || ["Color", "File", "Link"].contains(card.itemType)
    let runs = card.rich.flatMap { $0.runs + $0.rows.flatMap { $0.flatMap { $0 } } }
    richDark = runs.contains { run in
      (!run.color.isEmpty && run.background.isEmpty
        && panelColor(run.color).map { PanelStyle.luminance($0) > 0.65 } == true)
        || (run.color.isEmpty
          && panelColor(run.background).map { PanelStyle.luminance($0) < 0.15 } == true)
    }
    textScroll.layer?.backgroundColor =
      card.rich.isEmpty ? NSColor.clear.cgColor : PanelStyle.previewCanvas(richDark).cgColor
    text.textContainerInset =
      card.rich.isEmpty ? .zero : NSSize(width: 8 * scale, height: 8 * scale)
    if !card.assetPath.isEmpty {
      media.load(card.assetPath, pixels: 720) { [weak self] value in
        guard self?.card?.hash == hash else { return }
        self?.image.image = value
      }
    } else {
      text.textStorage?.setAttributedString(attributed(card, media: media))
    }
    needsLayout = true
    needsDisplay = true
    updateAnimation()
  }
  private func attributed(_ card: PanelCard, media: PanelMedia) -> NSAttributedString {
    let result = NSMutableAttributedString(string: "")
    let append: ([PanelRun], NSParagraphStyle?) -> Void = { [weak self] runs, paragraph in
      guard let self else { return }
      for run in runs {
        let size = CGFloat(run.size > 0 ? run.size : 13) * self.scale
        var font =
          run.mono
          ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
          : NSFont.systemFont(ofSize: size)
        if run.bold { font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
        if run.italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
        var attributes: [NSAttributedString.Key: Any] = [
          .font: font,
          .foregroundColor: panelColor(run.color)
            ?? (self.richDark
              || panelColor(run.background).map { PanelStyle.luminance($0) < 0.15 } == true
              ? NSColor.white : PanelStyle.rgb(0x222222))
            ,
        ]
        if run.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if let bg = panelColor(run.background) { attributes[.backgroundColor] = bg }
        if let paragraph { attributes[.paragraphStyle] = paragraph }
        if !run.image.isEmpty {
          let attachment = NSTextAttachment()
          attachment.bounds = NSRect(x: 0, y: 0, width: 160 * self.scale, height: 100 * self.scale)
          let string = NSMutableAttributedString(attachment: attachment)
          string.addAttributes(attributes, range: NSRange(location: 0, length: string.length))
          result.append(string)
          media.load(run.image, pixels: 480) { [weak self, weak attachment] image in
            guard let self, self.card?.hash == card.hash, let attachment else { return }
            attachment.image = image
            self.text.layoutManager?.invalidateDisplay(
              forCharacterRange: NSRange(location: 0, length: self.text.textStorage?.length ?? 0))
          }
        } else {
          result.append(NSAttributedString(string: run.text, attributes: attributes))
        }
      }
    }
    if card.rich.isEmpty {
      result.append(
        NSAttributedString(
          string: card.text,
          attributes: [
            .font: NSFont.systemFont(ofSize: 13 * scale), .foregroundColor: PanelStyle.text(self),
            .paragraphStyle: {
              let style = NSMutableParagraphStyle()
              style.minimumLineHeight = 19.5 * scale
              style.maximumLineHeight = 19.5 * scale
              return style
            }(),
          ]))
    } else {
      for block in card.rich {
        append(block.runs, nil)
        if !block.rows.isEmpty {
          let table = NSTextTable()
          table.numberOfColumns = block.rows.map(\.count).max() ?? 1
          table.collapsesBorders = true
          for (rowIndex, row) in block.rows.enumerated() {
            for (colIndex, runs) in row.enumerated() {
              let cell = NSTextTableBlock(
                table: table, startingRow: rowIndex, rowSpan: 1, startingColumn: colIndex,
                columnSpan: 1)
              cell.setWidth(0.5, type: .absoluteValueType, for: .border)
              cell.setBorderColor(.separatorColor)
              cell.setWidth(5, type: .absoluteValueType, for: .padding)
              let paragraph = NSMutableParagraphStyle()
              paragraph.textBlocks = [cell]
              append(runs, paragraph)
              result.append(
                NSAttributedString(string: "\n", attributes: [.paragraphStyle: paragraph]))
            }
          }
        }
      }
    }
    if !query.isEmpty {
      let plain = result.string as NSString
      var range = NSRange(location: 0, length: plain.length)
      while range.length > 0 {
        let hit = plain.range(
          of: query, options: [.caseInsensitive, .diacriticInsensitive], range: range)
        if hit.location == NSNotFound || hit.length == 0 { break }
        result.addAttribute(
          .backgroundColor, value: NSColor.systemYellow.withAlphaComponent(0.4), range: hit)
        range = NSRange(location: NSMaxRange(hit), length: plain.length - NSMaxRange(hit))
      }
    }
    return result
  }
  private func updateAnimation() {
    gif.stop()
    guard selected, let card, !card.animationPath.isEmpty else { return }
    let hash = card.hash
    gif.start(path: card.animationPath, pixels: 480) { [weak self] value in
      guard self?.card?.hash == hash else { return }
      self?.image.image = value
    }
  }
  func releaseContent() {
    gif.stop()
    hoverTimer?.invalidate()
    hoverTimer = nil
    card = nil
    image.image = nil
    icon.image = nil
    text.string = ""
    dimensions.stringValue = ""
    for badge in tagBadges { badge.removeFromSuperview() }
    tagBadges.removeAll()
    for view in [
      formatTag, favoriteMark, kindIcon, fileFormat, detailTitle, detailSubtitle, dimensions,
    ] { view.isHidden = true }
    media = nil
    textScroll.contentView.scroll(to: .zero)
    down = nil
  }
  override func updateTrackingAreas() {
    if let tracking { removeTrackingArea(tracking) }
    tracking = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect],
      owner: self)
    addTrackingArea(tracking!)
    super.updateTrackingAreas()
  }
  override func mouseMoved(with event: NSEvent) { select?() }
  override func mouseEntered(with event: NSEvent) {
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, !self.textScroll.isHidden, let layout = self.text.layoutManager,
          let container = self.text.textContainer
        else { return }
        layout.ensureLayout(for: container)
        let height = layout.usedRect(for: container).height + 8
        self.text.setFrameSize(
          NSSize(
            width: self.textScroll.bounds.width, height: max(height, self.textScroll.bounds.height))
        )
        let maxY = max(0, height - self.textScroll.contentView.bounds.height)
        let y = min(maxY, self.textScroll.contentView.bounds.minY + 0.7)
        self.textScroll.contentView.scroll(to: NSPoint(x: 0, y: y))
      }
    }
  }
  override func mouseExited(with event: NSEvent) {
    hoverTimer?.invalidate()
    hoverTimer = nil
    textScroll.contentView.scroll(to: .zero)
  }
  override func mouseDown(with event: NSEvent) {
    down = event
    dragging = false
    select?()
  }
  override func mouseUp(with event: NSEvent) {
    guard !dragging, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
    if singleClick || event.clickCount >= 2 { activate?() }
  }
  override func rightMouseDown(with event: NSEvent) {
    select?()
    guard let card else { return }
    let menu = NSMenu()
    let options: [(String, String)] = [
      (chinese ? "粘贴" : "Paste", "paste"), (chinese ? "复制" : "Copy", "copy"),
      (chinese ? "复制纯文本" : "Copy plain text", "plain"),
      (chinese ? "预览" : "Preview", "preview"),
      (
        card.favorite ? (chinese ? "取消收藏" : "Remove favorite") : (chinese ? "收藏" : "Favorite"),
        "favorite"
      ),
      (chinese ? "编辑文本" : "Edit text", "edit"), (chinese ? "识别图片文字" : "Recognize text", "ocr"),
      (chinese ? "删除" : "Delete", "delete"),
    ]
    for (name, action) in options {
      if action == "edit" && !["Text", "TextFile"].contains(card.itemType) { continue }
      if action == "ocr" && card.itemType != "Image" { continue }
      let item = NSMenuItem(title: name, action: #selector(menuSelected(_:)), keyEquivalent: "")
      item.representedObject = action
      item.target = self
      menu.addItem(item)
    }
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }
  @objc private func menuSelected(_ item: NSMenuItem) {
    if let action = item.representedObject as? String { menuAction?(action) }
  }
  override func mouseDragged(with event: NSEvent) {
    guard !dragging, let down,
      hypot(
        event.locationInWindow.x - down.locationInWindow.x,
        event.locationInWindow.y - down.locationInWindow.y) > 5
    else { return }
    dragging = true
    prepareDrag? { [weak self] payload in
      guard let self else { return }
      guard self.window != nil, NSEvent.pressedMouseButtons & 1 != 0 else {
        self.dragging = false
        self.dragEnded?()
        return
      }
      var items: [NSDraggingItem] = []
      for path in payload["paths"] as? [String] ?? [] {
        items.append(NSDraggingItem(pasteboardWriter: NSURL(fileURLWithPath: path)))
      }
      if items.isEmpty {
        let item = NSPasteboardItem()
        item.setString(payload["text"] as? String ?? "", forType: .string)
        if let html = payload["html"] as? String, !html.isEmpty {
          item.setString(html, forType: .html)
        }
        items.append(NSDraggingItem(pasteboardWriter: item))
      }
      for item in items {
        item.setDraggingFrame(
          NSRect(x: 12, y: 12, width: 80, height: 64),
          contents: self.image.image ?? self.icon.image
            ?? NSImage(size: NSSize(width: 80, height: 64)))
      }
      self.beginDraggingSession(with: items, event: down, source: self)
    }
  }
  func draggingSession(
    _ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext
  ) -> NSDragOperation { .copy }
  func draggingSession(
    _ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation
  ) {
    dragging = false
    down = nil
    dragEnded?()
  }
}
