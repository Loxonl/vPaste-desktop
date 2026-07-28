import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Item, ItemType } from "../../../src/clipboard/Item";
import { ImagePreview } from "../../../src/clipboard/ClipboardCardPreview";

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
});
