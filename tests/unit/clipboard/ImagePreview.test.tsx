import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Item, ItemType } from "../../../src/clipboard/Item";
import ClipboardCardPreview, { ImagePreview } from "../../../src/clipboard/ClipboardCardPreview";

const clipboardStyles = readFileSync(
    join(process.cwd(), "src", "clipboard", "Clipboard.module.css"),
    "utf8",
);
const filePresentationStyles = readFileSync(
    join(process.cwd(), "src", "clipboard", "FileTypePresentation.module.css"),
    "utf8",
);

const { invokeMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: invokeMock,
}));

class ImmediateIntersectionObserver {
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
    }

    observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
    }

    disconnect() {}
    unobserve() {}
    takeRecords() {
        return [];
    }
    root = null;
    rootMargin = "";
    thresholds = [];
}

class ImmediateResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
}

describe("ImagePreview", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
        vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "history_image_metadata") {
                return { width: 320, height: 180, isGif: false };
            }
            if (command === "history_image_card_preview_asset_path") {
                return "C:\\cache\\preview.png";
            }
            if (command === "history_file_data_url") {
                return "data:image/png;base64,recovered";
            }
            if (command === "file_preview_info") {
                return {
                    kind: "single-preview",
                    paths: ["C:\\images\\transparent.png"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\images\\transparent.png",
                    secondary_text: "",
                    extension: "PNG",
                    preview_path: "C:\\images\\transparent.png",
                    image_width: 320,
                    image_height: 180,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
    });

    it("remounts after the completed window refresh activates media and recovers a failed asset source", async () => {
        const item = new Item(
            1,
            "image-hash",
            ItemType.Image,
            "C:\\history\\image.bin",
            Date.now(),
        );
        const onGifFormatChange = vi.fn();
        const t = ((key: string) => key) as never;
        const { container, rerender } = render(
            <ImagePreview
                item={item}
                active={false}
                refreshKey={0}
                t={t}
                onGifFormatChange={onGifFormatChange}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("img")).toHaveAttribute("src", "asset://C:\\cache\\preview.png");
        });
        const firstImage = container.querySelector("img");
        expect(firstImage?.className).toContain("image-preview-img");
        expect(firstImage).not.toHaveAttribute("loading");

        rerender(
            <ImagePreview
                item={item}
                active={true}
                refreshKey={1}
                t={t}
                onGifFormatChange={onGifFormatChange}
            />,
        );
        const refreshedImage = container.querySelector("img");
        expect(refreshedImage).not.toBe(firstImage);

        fireEvent.error(refreshedImage!);
        await waitFor(() => {
            expect(container.querySelector("img")).toHaveAttribute(
                "src",
                "data:image/png;base64,recovered",
            );
        });
        expect(invokeMock).toHaveBeenCalledWith("history_file_data_url", {
            path: "C:\\history\\image.bin",
        });
    });

    it("styles transparency with a checkerboard confined to the image bounds", () => {
        const imageRule = clipboardStyles.match(/\.transparency-grid\s*\{([^}]*)\}/)?.[1];
        const stageRule = clipboardStyles.match(/\.image-preview-stage\s*\{([^}]*)\}/)?.[1];

        expect(imageRule).toContain("background-image:");
        expect(imageRule).toContain("linear-gradient");
        expect(stageRule).not.toContain("background-image:");
        expect(stageRule).not.toContain("background: #fff");
    });

    it("uses one restrained metadata treatment for image dimensions and color values", () => {
        const metadataRule = clipboardStyles.match(/\.preview-metadata\s*\{([^}]*)\}/)?.[1];
        const colorRule = clipboardStyles.match(/\.color-value\s*\{([^}]*)\}/)?.[1];

        expect(metadataRule).toContain("border-radius: var(--ui-radius-control)");
        expect(metadataRule).toContain("font-size: 11px");
        expect(metadataRule).toContain("font-weight: 500");
        expect(metadataRule).toContain("color: rgba(30, 34, 40, 0.88)");
        expect(metadataRule).toContain("background: rgba(248, 250, 252, 0.68)");
        expect(metadataRule).not.toContain("0 8px 22px");
        expect(colorRule).not.toContain("font-weight:");
    });

    it("uses the transparency checkerboard for a copied single-image file", async () => {
        const item = new Item(
            2,
            "transparent-file-hash",
            ItemType.File,
            JSON.stringify(["C:\\images\\transparent.png"]),
            Date.now(),
        );
        const t = ((key: string) => key) as never;
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={t}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("img")?.className).toContain("transparency-grid");
        });

        const image = container.querySelector("img");
        const stage = image?.parentElement;
        expect(image).not.toHaveAttribute("style");
        expect(stage?.className).toContain("image-file-stage");

        const imageFileStageRule = clipboardStyles.match(/\.file-preview-stage:not\(\.image-file-stage\)\s*\{([^}]*)\}/)?.[1];
        expect(imageFileStageRule).toContain("background: #fff");
    });

    it("renders the mapped icon with a close extension label for known files", async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "pdf-preview",
                    paths: ["C:\\Documents\\report.pdf"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\Documents\\report.pdf",
                    secondary_text: "",
                    extension: "PDF",
                    preview_path: "",
                    image_width: null,
                    image_height: null,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const item = new Item(
            3,
            "pdf-file-hash",
            ItemType.File,
            JSON.stringify(["C:\\Documents\\report.pdf"]),
            Date.now(),
        );
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={((key: string) => key) as never}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='known']")).not.toBeNull();
        });
        expect(container.querySelector("[data-file-presentation='known']")).toHaveTextContent("PDF");
        expect(container.querySelector("[data-file-presentation='known'] img")).toHaveAttribute("alt", "");
    });

    it("renders TXT with a dedicated lined text-document icon", async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "single-icon",
                    paths: ["C:\\Documents\\notes.txt"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\Documents\\notes.txt",
                    secondary_text: "",
                    extension: "TXT",
                    preview_path: "",
                    image_width: null,
                    image_height: null,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const item = new Item(
            4,
            "txt-file-hash",
            ItemType.File,
            JSON.stringify(["C:\\Documents\\notes.txt"]),
            Date.now(),
        );
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={((key: string) => key) as never}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-icon-name='text-document']"))
                .toHaveTextContent("TXT");
        });
        expect(container.querySelector("svg[data-file-text-document='lined']")).not.toBeNull();
        expect(container.querySelector("[data-file-icon-name='text-document'] img")).toBeNull();
    });

    it("uses the U1 document icon with an extension label for unknown files", async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "single-icon",
                    paths: ["C:\\Documents\\archive.vpxzz"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\Documents\\archive.vpxzz",
                    secondary_text: "",
                    extension: "VPXZZ",
                    preview_path: "",
                    image_width: null,
                    image_height: null,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const item = new Item(
            4,
            "unknown-file-hash",
            ItemType.File,
            JSON.stringify(["C:\\Documents\\archive.vpxzz"]),
            Date.now(),
        );
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={((key: string) => key) as never}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='unknown']")).toHaveTextContent("VPXZZ");
        });
        expect(container.querySelectorAll("[data-file-presentation='unknown'] img")).toHaveLength(1);
    });

    it("uses the M5 three-document stack and a count label for multiple files", async () => {
        const paths = [
            "C:\\Documents\\one.vpxzz",
            "C:\\Documents\\two.vpxzz",
            "C:\\Documents\\three.vpxzz",
        ];
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "multiple",
                    paths,
                    exists: true,
                    missing_paths: [],
                    display_path: paths[0],
                    secondary_text: "",
                    extension: "",
                    preview_path: "",
                    contains_directories: false,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const item = new Item(5, "multiple-file-hash", ItemType.File, JSON.stringify(paths), Date.now());
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={((key: string, params?: { count?: number }) => key === "clipboard.fileCount" ? `${params?.count} files` : key) as never}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='multiple']")).toHaveTextContent("3 files");
        });
        const stack = container.querySelector("svg[data-file-stack='m5']");
        expect(stack).not.toBeNull();
        expect(stack?.querySelectorAll("[data-file-stack-layer]")).toHaveLength(3);
        expect(container.querySelectorAll("[data-file-presentation='multiple'] img")).toHaveLength(0);
        expect(container.querySelector("[data-file-presentation='multiple']")).toHaveAttribute(
            "data-file-icon-name",
            "document",
        );
    });

    it("keeps the folder-resource icon for mixed files and folders", async () => {
        const paths = ["C:\\Documents\\one.pdf", "C:\\Documents\\assets"];
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "multiple",
                    paths,
                    exists: true,
                    missing_paths: [],
                    display_path: paths[0],
                    secondary_text: "",
                    extension: "",
                    preview_path: "",
                    contains_directories: true,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const item = new Item(6, "mixed-file-hash", ItemType.File, JSON.stringify(paths), Date.now());
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={((key: string, params?: { count?: number }) => key === "clipboard.fileCount" ? `${params?.count} files` : key) as never}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='mixed']")).toHaveTextContent("2 files");
        });
        expect(container.querySelectorAll("[data-file-presentation='mixed'] img")).toHaveLength(1);
        expect(container.querySelector("[data-file-presentation='mixed']")).toHaveAttribute(
            "data-file-icon-name",
            "folder-resource",
        );
    });

    it("keeps the Material Icon Theme folder for a single folder", async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "single-folder",
                    paths: ["C:\\Documents\\assets"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\Documents\\assets",
                    secondary_text: "",
                    extension: "",
                    preview_path: "",
                    contains_directories: true,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const item = new Item(
            7,
            "folder-hash",
            ItemType.File,
            JSON.stringify(["C:\\Documents\\assets"]),
            Date.now(),
        );
        const { container } = render(
            <ClipboardCardPreview
                item={item}
                active={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={((key: string) => key) as never}
                onGifFormatChange={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='folder']")).toHaveAttribute(
                "data-file-icon-name",
                "folder",
            );
        });
        const folderIcon = container.querySelector("svg[data-file-folder-icon='yellow']");
        expect(folderIcon).not.toBeNull();
        expect(folderIcon?.querySelector("path")).toHaveAttribute("fill", "#fbc02d");
        expect(container.querySelector("[data-file-presentation='folder']")).toHaveTextContent("");
    });

    it("centers the icon independently while keeping the label attached below it", () => {
        const presentationRule = filePresentationStyles.match(/\.presentation\s*\{([^}]*)\}/)?.[1];
        const multipleIconRule = filePresentationStyles.match(/\.multipleIcon\s*\{([^}]*)\}/)?.[1];
        const labelRule = filePresentationStyles.match(/\.label\s*\{([^}]*)\}/)?.[1];

        expect(presentationRule).toContain("position: relative");
        expect(presentationRule).toContain("align-items: center");
        expect(presentationRule).toContain("justify-content: center");
        expect(multipleIconRule).toContain("width: 76px");
        expect(multipleIconRule).toContain("height: 60px");
        expect(labelRule).toContain("position: absolute");
        expect(labelRule).toContain("top: calc(50% + 26px)");
        expect(labelRule).toContain("font-weight: 500");
    });
});
