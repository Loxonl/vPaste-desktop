import { describe, expect, it } from "vitest";
import { Item, ItemType } from "../../../src/clipboard/Item";
import {
    compactPath,
    dirName,
    getBackendTypeLabel,
    imageExportSourcePath,
    isGifPath,
    isImagePath,
    isSingleImageFileItem,
    isTextLikeItem,
    itemHasGifFormat,
    joinPath,
    parseFilePaths,
    parseLinkContent,
} from "../../../src/clipboard/itemPresentation";

function item(
    type: ItemType,
    content: string,
    previewContent = "",
): Item {
    return new Item(1, "hash", type, content, 0, undefined, previewContent);
}

describe("clipboard item presentation helpers", () => {
    it("maps frontend item types to backend labels", () => {
        expect(getBackendTypeLabel(ItemType.Text)).toBe("Text");
        expect(getBackendTypeLabel(ItemType.TextFile)).toBe("Text");
        expect(getBackendTypeLabel(ItemType.Image)).toBe("Image");
        expect(getBackendTypeLabel(ItemType.Link)).toBe("Link");
        expect(getBackendTypeLabel(ItemType.Color)).toBe("Color");
        expect(getBackendTypeLabel(ItemType.File)).toBe("File");
    });

    it("parses only string file paths from JSON arrays", () => {
        expect(parseFilePaths('["C:\\\\one.png",42,null,"/two.txt"]')).toEqual([
            "C:\\one.png",
            "/two.txt",
        ]);
        expect(parseFilePaths('{"path":"/one.txt"}')).toEqual([]);
        expect(parseFilePaths("not-json")).toEqual([]);
    });

    it("recognizes supported image and GIF paths", () => {
        expect(isImagePath("C:\\image.JPEG")).toBe(true);
        expect(isImagePath("/tmp/vector.svg")).toBe(true);
        expect(isImagePath("/tmp/document.pdf")).toBe(false);
        expect(isGifPath(" C:\\animation.GIF?cache=1 ")).toBe(true);
        expect(isGifPath("/tmp/image.png")).toBe(false);
    });

    it("identifies single image file items and GIF formats", () => {
        const gifFile = item(ItemType.File, '["C:\\\\animation.gif"]');
        const multipleFiles = item(ItemType.File, '["C:\\\\one.png","C:\\\\two.png"]');
        const image = item(ItemType.Image, "image-content", "C:\\preview.gif");

        expect(isSingleImageFileItem(gifFile)).toBe(true);
        expect(isSingleImageFileItem(multipleFiles)).toBe(false);
        expect(itemHasGifFormat(gifFile)).toBe(true);
        expect(itemHasGifFormat(image)).toBe(true);
    });

    it("selects an export source only for image content", () => {
        expect(imageExportSourcePath(item(ItemType.Image, "raw", "C:\\preview.png")))
            .toBe("C:\\preview.png");
        expect(imageExportSourcePath(item(ItemType.File, '["/tmp/photo.webp"]')))
            .toBe("/tmp/photo.webp");
        expect(imageExportSourcePath(item(ItemType.File, '["/tmp/readme.txt"]')))
            .toBe("");
    });

    it("keeps the existing compact and platform-aware path behavior", () => {
        expect(compactPath("C:\\short.txt", 20)).toBe("C:/short.txt");
        expect(compactPath("C:\\a\\very\\long\\folder\\file.txt", 16)).toBe("...lder/file.txt");
        expect(joinPath("C:\\Downloads\\", "image.png")).toBe("C:\\Downloads\\image.png");
        expect(joinPath("/tmp/downloads/", "image.png")).toBe("/tmp/downloads/image.png");
        expect(dirName("C:\\Downloads\\image.png")).toBe("C:\\Downloads");
        expect(dirName("/tmp/downloads/image.png")).toBe("/tmp/downloads");
    });

    it("recognizes text-like items", () => {
        expect(isTextLikeItem(item(ItemType.Text, "text"))).toBe(true);
        expect(isTextLikeItem(item(ItemType.TextFile, "text"))).toBe(true);
        expect(isTextLikeItem(item(ItemType.Link, "https://example.com"))).toBe(true);
        expect(isTextLikeItem(item(ItemType.Image, "image"))).toBe(false);
    });

    it("parses the existing tab-separated link preview payload", () => {
        expect(parseLinkContent("https://example.com|||C:\\preview.png|||Example|||image"))
            .toEqual({
                url: "https://example.com",
                imagePath: "C:\\preview.png",
                title: "Example",
                imageKind: "image",
            });
        expect(parseLinkContent("https://example.com")).toEqual({
            url: "https://example.com",
            imagePath: "",
            title: "",
            imageKind: "",
        });
    });
});
