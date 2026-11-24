import AppKit
import XCTest

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
    PanelContextMenu.options(card: card, tags: .loaded(tags), colors: colors, chinese: chinese)
  }

  func testOffersImageTextOnlyForImagesAsTheSecondEntry() {
    for type in types {
      let menu = options(card(type))
      let index = menu.firstIndex { $0.action == .viewImageText }
      XCTAssertEqual(index, type == "Image" ? 1 : nil, type)
    }
  }

  func testBaseActionsKeepExplicitFavoriteIntentAndSeparateDelete() {
    let menu = options(card("Text", favorite: true))
    XCTAssertEqual(menu.map(\.title), [
      "Preview", "Edit text", "Remove favorite", "Tags", "Paste as plain text", "", "Delete record",
    ])
    XCTAssertEqual(menu.map(\.action), [
      .preview, .editText, .favorite(false), nil, .pastePlainText, nil, .delete,
    ])
    XCTAssertEqual(options(card("Text"))[2].action, .favorite(true))
    XCTAssertTrue(menu[5].isSeparator)
    XCTAssertFalse(menu.map(\.title).contains("Copy as plain text"))
  }

  func testUsesNativeParityChineseLabels() {
    let menu = options(card("Text"), chinese: true)
    XCTAssertEqual(menu.filter { !$0.isSeparator }.map(\.title), [
      "预览", "编辑文本", "收藏", "标签", "粘贴为纯文本", "删除记录",
    ])
    XCTAssertEqual(options(card("Image"), chinese: true)[1].title, "识别图片文字")
    XCTAssertEqual(options(card("Image"))[1].title, "Recognize text in image")
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

  func testIgnoresStaleAssignmentsAndKeepsCreateAndAssign() throws {
    let assigned = PanelTag(id: 1, name: "Assigned")
    let stale = PanelTag(id: 99, name: "Stale")
    let available = PanelTag(id: 2, name: "Available")
    let menu = options(card("Text", tags: [assigned, stale]), tags: [assigned, available])
    let tags = try XCTUnwrap(menu.first { $0.title == "Tags" })
    XCTAssertNil(tags.action)
    XCTAssertEqual(tags.children.map(\.action), [
      .createTag, .removeTag(assigned), .assignTag(available), nil, .removeAllTags,
    ])
    XCTAssertFalse(tags.children.map(\.title).contains("Stale"))
  }

  func testAssignedAndUnassignedTagsShareOneCheckableMenu() throws {
    let assigned = PanelTag(id: 1, name: "Assigned")
    let available = PanelTag(id: 2, name: "Available")
    let handler = PanelMenuHandler { _ in }
    let menu = PanelContextMenu.menu(
      options(card("Text", tags: [assigned]), tags: [assigned, available]), handler: handler)
    let tags = try XCTUnwrap(menu.item(withTitle: "Tags")?.submenu)
    XCTAssertEqual(tags.item(withTitle: "Assigned")?.state, .on)
    XCTAssertEqual(tags.item(withTitle: "Available")?.state, .off)
    XCTAssertTrue(tags.items.dropLast().last?.isSeparatorItem == true)
    XCTAssertEqual(tags.items.last?.title, "Remove all assigned tags")
  }

  func testLoadingFailureAndKnownEmptyDoNotDelayBasicActions() throws {
    let handler = PanelMenuHandler { _ in }
    for (availability, expected) in [
      (PanelMenuTags.loading, ["Loading tags… Reopen the menu."]),
      (.failed, ["Tags unavailable", "Retry loading tags"]),
      (.loaded([]), ["Create and assign tag…", "No record tags"]),
    ] {
      let options = PanelContextMenu.options(card: card("Color"), tags: availability, colors: nil, chinese: false)
      let menu = PanelContextMenu.menu(options, handler: handler)
      XCTAssertTrue(menu.item(withTitle: "Preview")?.isEnabled == true)
      XCTAssertTrue(menu.item(withTitle: "Add favorite")?.isEnabled == true)
      let tags = try XCTUnwrap(menu.item(withTitle: "Tags")?.submenu)
      XCTAssertEqual(tags.items.map(\.title), expected)
      for item in tags.items {
        XCTAssertEqual(item.isEnabled, ["Retry loading tags", "Create and assign tag…"].contains(item.title))
      }
      let colorLoading = try XCTUnwrap(menu.item(withTitle: "Copy color as")?.submenu?.items.first)
      XCTAssertEqual(colorLoading.title, "Loading color formats… Reopen the menu.")
      XCTAssertFalse(colorLoading.isEnabled)
      XCTAssertTrue(menu.items.dropLast().last?.isSeparatorItem == true)
    }
  }

  func testAddsExportAndFolderActionsForASingleImageFile() {
    XCTAssertEqual(options(card("File", exportImage: true)).map(\.action), [
      .preview, .favorite(true), nil, .exportImage, .openFolder, .copyFolder, nil, .delete,
    ])
    XCTAssertFalse(options(card("File")).contains { $0.action == .exportImage })
    XCTAssertTrue(options(card("Image", exportImage: true)).contains { $0.action == .exportImage })
  }

  func testBuildsColorConversionChildren() throws {
    let menu = options(card("Color"), colors: [
      PanelColorOption(format: "HEX", value: "#3366FF"),
      PanelColorOption(format: "RGB", value: "rgb(51, 102, 255)"),
    ])
    let conversions = try XCTUnwrap(menu.first { $0.title == "Copy color as" }).children
    XCTAssertEqual(conversions.map(\.title), ["HEX #3366FF", "RGB rgb(51, 102, 255)"])
    XCTAssertEqual(conversions[1].action, .copyColor("rgb(51, 102, 255)"))
  }

  func testShowsUnsupportedColorEntryWhenConversionsAreUnavailable() throws {
    let menu = options(card("Color"))
    let conversions = try XCTUnwrap(menu.first { $0.title == "Copy color as" }).children
    XCTAssertEqual(conversions.map(\.title), ["This color format cannot be converted yet"])
    XCTAssertNil(conversions[0].action)
  }

  func testNSMenuKeepsSubmenusDangerAndDisabledPlaceholders() throws {
    var chosen: [PanelMenuAction] = []
    let handler = PanelMenuHandler { chosen.append($0) }
    let tag = PanelTag(id: 1, name: "Only")
    let menu = PanelContextMenu.menu(
      options(card("Text", tags: [tag]), tags: [tag]), handler: handler)
    let tags = try XCTUnwrap(menu.item(withTitle: "Tags"))
    XCTAssertNotNil(tags.submenu)
    XCTAssertNil(tags.representedObject, "A submenu parent must not run an action")
    XCTAssertFalse(tags.target === handler)
    let placeholder = try XCTUnwrap(tags.submenu?.item(withTitle: "All tags are assigned"))
    XCTAssertFalse(placeholder.isEnabled)
    let removeAll = try XCTUnwrap(tags.submenu?.items.last)
    let color = removeAll.attributedTitle?.attribute(.foregroundColor, at: 0, effectiveRange: nil)
    XCTAssertEqual(color as? NSColor, .systemRed)
    let delete = try XCTUnwrap(menu.items.last)
    XCTAssertTrue(menu.autoenablesItems == false)
    handler.select(delete)
    XCTAssertEqual(chosen, [.delete])
  }
}
