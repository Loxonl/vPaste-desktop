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
});
