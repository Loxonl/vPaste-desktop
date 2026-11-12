import AppKit
import UniformTypeIdentifiers

// Native mirror of src/clipboard/clipboardContextMenu.ts. Entries, order,
// conditions and labels (src/lang/locales) must stay identical to the WebView.
enum PanelMenuAction: Equatable {
  case preview, editText, viewImageText, toggleFavorite, createTag
  case assignTag(PanelTag), removeAllTags, removeTag(PanelTag)
  case exportImage, openFolder, copyFolder, copyColor(String), pastePlainText, delete
}

struct PanelMenuOption: Equatable {
  let title: String
  // nil for a submenu parent or an inert placeholder.
  var action: PanelMenuAction?
  var children: [PanelMenuOption] = []
  var danger = false
}

struct PanelColorOption: Decodable, Equatable {
  let format: String
  let value: String
}

enum PanelContextMenu {
  private static let labels: [String: (String, String)] = [
    "preview": ("Preview", "预览"),
    "editText": ("Edit text", "编辑文字"),
    "imageText": ("View image text", "查看图片文字"),
    "addFavorite": ("Add to Favorites", "加入收藏"),
    "removeFavorite": ("Remove from Favorites", "取消收藏"),
    "addRecordTag": ("Add Record Tag", "添加记录标签"),
    "createRecord": ("Create Record Tag", "创建记录标签"),
    "noAssignable": ("No record tags to add", "没有可添加的记录标签"),
    "removeRecordTag": ("Remove Record Tag", "移除记录标签"),
    "removeAllTags": ("Remove All Record Tags", "移除全部记录标签"),
    "exportImage": ("Export as File", "导出为文件"),
    "openFolder": ("Open Containing Folder", "打开所在路径"),
    "copyFolder": ("Copy Containing Folder", "复制所在路径"),
    "convertColor": ("Copy Color As", "复制为颜色格式"),
    "colorUnsupported": ("This color format cannot be converted yet", "当前颜色格式暂不支持转换"),
    "pastePlainText": ("Paste as Plain Text", "粘贴为纯文本"),
    "deleteRecord": ("Delete Record", "删除记录"),
  ]

  static func label(_ key: String, chinese: Bool) -> String {
    guard let pair = labels[key] else { return key }
    return chinese ? pair.1 : pair.0
  }

  static func isTextLike(_ type: String) -> Bool { ["Text", "TextFile", "Link"].contains(type) }
  static func isEditableText(_ type: String) -> Bool { isTextLike(type) || type == "Color" }

  static func options(
    card: PanelCard, tags: [PanelTag], colors: [PanelColorOption], chinese: Bool
  ) -> [PanelMenuOption] {
    func l(_ key: String) -> String { label(key, chinese: chinese) }
    let assignedIds = Set(card.tags.map(\.id))
    let currentIds = Set(tags.map(\.id))
    let assignable = tags.filter { !assignedIds.contains($0.id) }
    let assigned = card.tags.filter { currentIds.contains($0.id) }

    var options = [
      PanelMenuOption(title: l("preview"), action: .preview),
      PanelMenuOption(
        title: l(card.favorite ? "removeFavorite" : "addFavorite"), action: .toggleFavorite),
    ]
    if isEditableText(card.itemType) {
      options.insert(PanelMenuOption(title: l("editText"), action: .editText), at: 1)
    }
    if card.itemType == "Image" {
      options.insert(PanelMenuOption(title: l("imageText"), action: .viewImageText), at: 1)
    }

    if tags.isEmpty {
      options.append(PanelMenuOption(title: l("addRecordTag"), action: .createTag))
    } else {
      options.append(
        PanelMenuOption(
          title: l("addRecordTag"), action: nil,
          children: [PanelMenuOption(title: l("createRecord"), action: .createTag)]
            + (assignable.isEmpty
              ? [PanelMenuOption(title: l("noAssignable"), action: nil)]
              : assignable.map { PanelMenuOption(title: $0.name, action: .assignTag($0)) })))
    }
    if !assigned.isEmpty {
      options.append(
        PanelMenuOption(
          title: l("removeRecordTag"), action: nil,
          children: [PanelMenuOption(title: l("removeAllTags"), action: .removeAllTags, danger: true)]
            + assigned.map { PanelMenuOption(title: $0.name, action: .removeTag($0)) }))
    }
    if card.exportImage {
      options.append(PanelMenuOption(title: l("exportImage"), action: .exportImage))
    }
    if card.itemType == "File" {
      options.append(PanelMenuOption(title: l("openFolder"), action: .openFolder))
      options.append(PanelMenuOption(title: l("copyFolder"), action: .copyFolder))
    }
    if card.itemType == "Color" {
      options.append(
        PanelMenuOption(
          title: l("convertColor"), action: nil,
          children: colors.isEmpty
            ? [PanelMenuOption(title: l("colorUnsupported"), action: nil)]
            : colors.map {
              PanelMenuOption(title: "\($0.format) \($0.value)", action: .copyColor($0.value))
            }))
    }
    if isTextLike(card.itemType) {
      options.append(PanelMenuOption(title: l("pastePlainText"), action: .pastePlainText))
    }
    options.append(PanelMenuOption(title: l("deleteRecord"), action: .delete))
    return options
  }

  @MainActor
  static func menu(_ options: [PanelMenuOption], handler: PanelMenuHandler) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    for option in options {
      let item = NSMenuItem(title: option.title, action: nil, keyEquivalent: "")
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

// Sheets keep the panel's focus-loss dismissal suspended (attachedSheet).
@MainActor
enum PanelMenuSheets {
  static let exportDirectoryKey = "vpaste.imageExportDir.v1"

  static func askTagName(
    window: NSWindow, chinese: Bool, completion: @escaping (String) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = PanelContextMenu.label("createRecord", chinese: chinese)
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
    field.placeholderString = chinese ? "标签名称" : "Tag name"
    alert.accessoryView = field
    alert.addButton(withTitle: chinese ? "保存" : "Save")
    alert.addButton(withTitle: chinese ? "取消" : "Cancel")
    alert.window.initialFirstResponder = field
    alert.beginSheetModal(for: window) { response in
      let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      if response == .alertFirstButtonReturn, !name.isEmpty { completion(name) }
    }
  }

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
