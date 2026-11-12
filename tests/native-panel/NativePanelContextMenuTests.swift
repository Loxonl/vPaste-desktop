import AppKit
import XCTest

// Mirrors tests/unit/clipboard/clipboardContextMenu.test.ts: the native card
// menu must offer the same entries, order and conditions as the WebView.
@MainActor
final class NativePanelContextMenuTests: XCTestCase {
  private let types = ["Text", "TextFile", "Color", "Image", "Link", "File"]

  private func card(
    _ type: String, favorite: Bool = false, tags: [PanelTag] = [], exportImage: Bool = false
  ) -> PanelCard {
    PanelCard(
      hash: "hash-\(type)", itemType: type, text: "", source: "", sourceIcon: "", remote: false,
      time: 0, color: "", favorite: favorite, tags: tags, assetPath: "", animationPath: "",
      dimensions: "", mediaWidth: 0, mediaHeight: 0, displayTitle: "", displaySubtitle: "",
      displaySymbol: "", fileFormat: "", isGif: false, rich: [], exportImage: exportImage)
  }

  private func options(
    _ card: PanelCard, tags: [PanelTag] = [], colors: [PanelColorOption] = [], chinese: Bool = false
  ) -> [PanelMenuOption] {
    PanelContextMenu.options(card: card, tags: tags, colors: colors, chinese: chinese)
  }

  func testOffersImageTextOnlyForImagesAsTheSecondEntry() {
    for type in types {
      let menu = options(card(type))
      let index = menu.firstIndex { $0.action == .viewImageText }
      XCTAssertEqual(index, type == "Image" ? 1 : nil, type)
    }
  }

  func testKeepsBaseFavoriteTextAndDeleteActionsInWebViewOrder() {
    let menu = options(card("Text", favorite: true))
    XCTAssertEqual(menu.map(\.title), [
      "Preview", "Edit text", "Remove from Favorites", "Add Record Tag", "Paste as Plain Text",
      "Delete Record",
    ])
    XCTAssertEqual(menu.map(\.action), [
      .preview, .editText, .toggleFavorite, .createTag, .pastePlainText, .delete,
    ])
    XCTAssertFalse(menu.map(\.title).contains("Paste"))
    XCTAssertFalse(menu.map(\.title).contains("Copy"))
  }

  func testUsesWebViewChineseLabels() {
    let menu = options(card("Text"), chinese: true)
    XCTAssertEqual(menu.map(\.title), [
      "预览", "编辑文字", "加入收藏", "添加记录标签", "粘贴为纯文本", "删除记录",
    ])
    XCTAssertEqual(options(card("Image"), chinese: true)[1].title, "查看图片文字")
  }

  func testOffersEditingOnlyForTextBackedItems() {
    for type in types {
      XCTAssertEqual(
        options(card(type)).contains { $0.action == .editText },
        ["Text", "TextFile", "Link", "Color"].contains(type), type)
    }
  }

  func testOffersPlainTextPasteOnlyForTextLikeItems() {
    for type in types {
      XCTAssertEqual(
        options(card(type)).contains { $0.action == .pastePlainText },
        ["Text", "TextFile", "Link"].contains(type), type)
    }
  }

  func testShowsOnlyAssignableAndCurrentlyValidAssignedTags() throws {
    let assigned = PanelTag(id: 1, name: "Assigned")
    let stale = PanelTag(id: 99, name: "Stale")
    let available = PanelTag(id: 2, name: "Available")
    let menu = options(card("Text", tags: [assigned, stale]), tags: [assigned, available])
    let add = try XCTUnwrap(menu.first { $0.title == "Add Record Tag" })
    XCTAssertNil(add.action)
    XCTAssertEqual(add.children.map(\.title), ["Create Record Tag", "Available"])
    XCTAssertEqual(add.children.map(\.action), [.createTag, .assignTag(available)])
    let remove = try XCTUnwrap(menu.first { $0.title == "Remove Record Tag" })
    XCTAssertEqual(remove.children.map(\.title), ["Remove All Record Tags", "Assigned"])
    XCTAssertEqual(remove.children.map(\.action), [.removeAllTags, .removeTag(assigned)])
    XCTAssertTrue(remove.children[0].danger)
    XCTAssertFalse(remove.children[1].danger)
  }

  func testShowsDisabledPlaceholderWhenEveryTagIsAssigned() throws {
    let tag = PanelTag(id: 1, name: "Only")
    let add = try XCTUnwrap(
      options(card("Text", tags: [tag]), tags: [tag]).first { $0.title == "Add Record Tag" })
    XCTAssertEqual(add.children.map(\.title), ["Create Record Tag", "No record tags to add"])
    XCTAssertNil(add.children[1].action)
  }

  func testAddsExportAndFolderActionsForASingleImageFile() {
    XCTAssertEqual(options(card("File", exportImage: true)).map(\.action), [
      .preview, .toggleFavorite, .createTag, .exportImage, .openFolder, .copyFolder, .delete,
    ])
    XCTAssertFalse(options(card("File")).contains { $0.action == .exportImage })
    XCTAssertTrue(options(card("Image", exportImage: true)).contains { $0.action == .exportImage })
  }

  func testBuildsColorConversionChildren() throws {
    let menu = options(card("Color"), colors: [
      PanelColorOption(format: "HEX", value: "#3366FF"),
      PanelColorOption(format: "RGB", value: "rgb(51, 102, 255)"),
    ])
    let conversions = try XCTUnwrap(menu.first { $0.title == "Copy Color As" }).children
    XCTAssertEqual(conversions.map(\.title), ["HEX #3366FF", "RGB rgb(51, 102, 255)"])
    XCTAssertEqual(conversions[1].action, .copyColor("rgb(51, 102, 255)"))
  }

  func testShowsUnsupportedColorEntryWhenConversionsAreUnavailable() throws {
    let conversions = try XCTUnwrap(
      options(card("Color")).first { $0.title == "Copy Color As" }).children
    XCTAssertEqual(conversions.map(\.title), ["This color format cannot be converted yet"])
    XCTAssertNil(conversions[0].action)
  }

  func testNSMenuKeepsSubmenusDangerAndDisabledPlaceholders() throws {
    var chosen: [PanelMenuAction] = []
    let handler = PanelMenuHandler { chosen.append($0) }
    let tag = PanelTag(id: 1, name: "Only")
    let menu = PanelContextMenu.menu(
      options(card("Text", tags: [tag]), tags: [tag]), handler: handler)
    let add = try XCTUnwrap(menu.items.first { $0.title == "Add Record Tag" })
    XCTAssertNotNil(add.submenu)
    XCTAssertNil(add.representedObject, "A submenu parent must not run an action")
    XCTAssertFalse(add.target === handler)
    let placeholder = try XCTUnwrap(add.submenu?.items.last)
    XCTAssertFalse(placeholder.isEnabled)
    let removeAll = try XCTUnwrap(
      menu.items.first { $0.title == "Remove Record Tag" }?.submenu?.items.first)
    let color = removeAll.attributedTitle?.attribute(.foregroundColor, at: 0, effectiveRange: nil)
    XCTAssertEqual(color as? NSColor, .systemRed)
    let delete = try XCTUnwrap(menu.items.last)
    XCTAssertTrue(menu.autoenablesItems == false)
    handler.select(delete)
    XCTAssertEqual(chosen, [.delete])
  }
}
