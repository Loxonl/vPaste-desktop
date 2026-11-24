import AppKit
import UniformTypeIdentifiers

enum PanelMenuAction: Equatable {
  case preview, editText, viewImageText, favorite(Bool), createTag, retryTags
  case assignTag(PanelTag), removeAllTags, removeTag(PanelTag)
  case exportImage, openFolder, copyFolder, copyColor(String), pastePlainText, delete
}

enum PanelMenuTags {
  case loading, failed, loaded([PanelTag])
}

struct PanelMenuOption: Equatable {
  let title: String
  // nil for a submenu parent or an inert placeholder.
  var action: PanelMenuAction?
  var children: [PanelMenuOption] = []
  var danger = false
  var checked = false
  var isSeparator = false
  static let separator = Self(title: "", isSeparator: true)
}

struct PanelColorOption: Decodable, Equatable {
  let format: String
  let value: String
}

enum PanelContextMenu {
  private static let labels: [String: (String, String)] = [
    "preview": ("Preview", "预览"),
    "editText": ("Edit text", "编辑文本"),
    "imageText": ("Recognize text in image", "识别图片文字"),
    "addFavorite": ("Add favorite", "收藏"),
    "removeFavorite": ("Remove favorite", "取消收藏"),
    "tags": ("Tags", "标签"),
    "createRecord": ("Create and assign tag…", "新建并添加标签…"),
    "tagsLoading": ("Loading tags… Reopen the menu.", "正在加载标签，请重新打开菜单。"),
    "tagsFailed": ("Tags unavailable", "标签暂不可用"),
    "retryTags": ("Retry loading tags", "重试加载标签"),
    "tagsEmpty": ("No record tags", "没有记录标签"),
    "allAssigned": ("All tags are assigned", "已添加全部标签"),
    "removeAllTags": ("Remove all assigned tags", "移除全部标签"),
    "exportImage": ("Export image…", "导出图片…"),
    "openFolder": ("Open containing folder", "打开所在目录"),
    "copyFolder": ("Copy containing folder", "复制所在目录"),
    "convertColor": ("Copy color as", "复制颜色格式"),
    "colorLoading": ("Loading color formats… Reopen the menu.", "正在加载颜色格式，请重新打开菜单。"),
    "colorUnsupported": ("This color format cannot be converted yet", "当前颜色格式暂不支持转换"),
    "pastePlainText": ("Paste as plain text", "粘贴为纯文本"),
    "deleteRecord": ("Delete record", "删除记录"),
  ]

  static func label(_ key: String, chinese: Bool) -> String {
    guard let pair = labels[key] else { return key }
    return chinese ? pair.1 : pair.0
  }

  static func editorAnchor(mouse: NSPoint, primaryHeight: CGFloat) -> [CGFloat] {
    [mouse.x, primaryHeight - mouse.y]
  }

  @MainActor
  static func tabKindMenu(chinese: Bool, handler: PanelTabKindHandler) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    let choices = chinese
      ? [("筛选型标签", "按筛选条件自动归类"), ("记录型标签", "手动添加到粘贴项")]
      : [("Filter Tag", "Auto-grouped by filters"), ("Record Tag", "Manually added to items")]
    for (index, choice) in choices.enumerated() {
      let title = NSMutableAttributedString(string: choice.0 + "\n",
        attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)])
      title.append(NSAttributedString(string: choice.1,
        attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
      let item = NSMenuItem(title: choice.0, action: #selector(PanelTabKindHandler.select(_:)), keyEquivalent: "")
      item.attributedTitle = title
      item.target = handler
      item.tag = index
      menu.addItem(item)
    }
    return menu
  }

  @MainActor
  static func tabMenu(chinese: Bool, handler: PanelTabMenuHandler) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    let titles = chinese ? ["编辑标签", "删除"] : ["Edit Tab", "Delete"]
    for (index, title) in titles.enumerated() {
      let item = NSMenuItem(title: title, action: #selector(PanelTabMenuHandler.select(_:)), keyEquivalent: "")
      item.target = handler
      item.tag = index
      if index == 1 {
        item.attributedTitle = NSAttributedString(string: title,
          attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuFont(ofSize: 0)])
      }
      menu.addItem(item)
    }
    return menu
  }

  static func isTextLike(_ type: String) -> Bool { ["Text", "TextFile", "Link"].contains(type) }
  static func isEditableText(_ type: String) -> Bool { isTextLike(type) || type == "Color" }

  static func options(
    card: PanelCard, tags: PanelMenuTags, colors: [PanelColorOption]?, chinese: Bool
  ) -> [PanelMenuOption] {
    func l(_ key: String) -> String { label(key, chinese: chinese) }

    var options = [
      PanelMenuOption(title: l("preview"), action: .preview),
      PanelMenuOption(
        title: l(card.favorite ? "removeFavorite" : "addFavorite"), action: .favorite(!card.favorite)),
    ]
    if isEditableText(card.itemType) {
      options.insert(PanelMenuOption(title: l("editText"), action: .editText), at: 1)
    }
    if card.itemType == "Image" {
      options.insert(PanelMenuOption(title: l("imageText"), action: .viewImageText), at: 1)
    }

    let tagOptions: [PanelMenuOption]
    switch tags {
    case .loading:
      tagOptions = [PanelMenuOption(title: l("tagsLoading"))]
    case .failed:
      tagOptions = [PanelMenuOption(title: l("tagsFailed")),
        PanelMenuOption(title: l("retryTags"), action: .retryTags)]
    case .loaded(let available):
      let assigned = Set(card.tags.map(\.id))
      let assignments = available.map { tag in
        let checked = assigned.contains(tag.id)
        return PanelMenuOption(title: tag.name, action: checked ? .removeTag(tag) : .assignTag(tag),
          checked: checked)
      }
      var children = [PanelMenuOption(title: l("createRecord"), action: .createTag)] + assignments
      if assignments.isEmpty { children.append(PanelMenuOption(title: l("tagsEmpty"))) }
      else if assignments.allSatisfy(\.checked) { children.append(PanelMenuOption(title: l("allAssigned"))) }
      if assignments.contains(where: \.checked) {
        children += [.separator, PanelMenuOption(title: l("removeAllTags"), action: .removeAllTags, danger: true)]
      }
      tagOptions = children
    }
    options.append(PanelMenuOption(title: l("tags"), children: tagOptions))
    if card.exportImage {
      options.append(PanelMenuOption(title: l("exportImage"), action: .exportImage))
    }
    if card.itemType == "File" {
      options.append(PanelMenuOption(title: l("openFolder"), action: .openFolder))
      options.append(PanelMenuOption(title: l("copyFolder"), action: .copyFolder))
    }
    if card.itemType == "Color" {
      let entries = colors?.map {
        PanelMenuOption(title: "\($0.format) \($0.value)", action: .copyColor($0.value))
      } ?? []
      options.append(PanelMenuOption(title: l("convertColor"), children: entries.isEmpty
        ? [PanelMenuOption(title: l(colors == nil ? "colorLoading" : "colorUnsupported"))]
        : entries))
    }
    if isTextLike(card.itemType) {
      options.append(PanelMenuOption(title: l("pastePlainText"), action: .pastePlainText))
    }
    options += [.separator, PanelMenuOption(title: l("deleteRecord"), action: .delete, danger: true)]
    return options
  }

  @MainActor
  static func menu(_ options: [PanelMenuOption], handler: PanelMenuHandler) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    for option in options {
      if option.isSeparator { menu.addItem(.separator()); continue }
      let item = NSMenuItem(title: option.title, action: nil, keyEquivalent: "")
      item.state = option.checked ? .on : .off
      if option.danger {
        item.attributedTitle = NSAttributedString(
          string: option.title,
          attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuFont(ofSize: 0)])
      }
      if !option.children.isEmpty {
        item.submenu = Self.menu(option.children, handler: handler)
      } else if let action = option.action {
        item.action = #selector(PanelMenuHandler.select(_:))
        item.target = handler
        item.representedObject = PanelMenuActionBox(action)
      } else {
        item.isEnabled = false
      }
      menu.addItem(item)
    }
    return menu
  }
}

final class PanelMenuActionBox: NSObject {
  let action: PanelMenuAction
  init(_ action: PanelMenuAction) { self.action = action }
}

// NSMenuItem.target is weak; the caller keeps this alive while the menu runs.
@MainActor
final class PanelMenuHandler: NSObject {
  private let chosen: (PanelMenuAction) -> Void
  init(_ chosen: @escaping (PanelMenuAction) -> Void) { self.chosen = chosen }
  @objc func select(_ item: NSMenuItem) {
    if let box = item.representedObject as? PanelMenuActionBox { chosen(box.action) }
  }
}

@MainActor
final class PanelTabKindHandler: NSObject {
  private let chosen: (Bool) -> Void
  init(_ chosen: @escaping (Bool) -> Void) { self.chosen = chosen }
  @objc func select(_ item: NSMenuItem) { chosen(item.tag == 1) }
}

enum PanelTabMenuAction { case edit, delete }

@MainActor
final class PanelTabMenuHandler: NSObject {
  private let chosen: (PanelTabMenuAction) -> Void
  init(_ chosen: @escaping (PanelTabMenuAction) -> Void) { self.chosen = chosen }
  @objc func select(_ item: NSMenuItem) { chosen(item.tag == 0 ? .edit : .delete) }
}

// Sheets keep the panel's focus-loss dismissal suspended (attachedSheet).
@MainActor
enum PanelMenuSheets {
  static let exportDirectoryKey = "vpaste.imageExportDir.v1"

  // Same formats, default name and remembered folder as the WebView export.
  static func chooseExportTarget(window: NSWindow, completion: @escaping (URL) -> Void) {
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.png, .jpeg, .webP, .bmp]
    panel.allowsOtherFileTypes = false
    panel.nameFieldStringValue = "vpaste-image-\(Int(Date().timeIntervalSince1970 * 1000)).png"
    if let saved = UserDefaults.standard.string(forKey: exportDirectoryKey) {
      panel.directoryURL = URL(fileURLWithPath: saved, isDirectory: true)
    } else {
      panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)
        .first
    }
    panel.beginSheetModal(for: window) { response in
      guard response == .OK, let url = panel.url else { return }
      completion(url)
    }
  }
  // Called only after a successful export, as the WebView does.
  static func rememberExportDirectory(of url: URL) {
    UserDefaults.standard.set(url.deletingLastPathComponent().path, forKey: exportDirectoryKey)
  }
}
