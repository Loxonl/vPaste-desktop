import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClipboardCard from "../../../src/clipboard/ClipboardCard";
import { ensureWhiteTextContrast } from "../../../src/clipboard/clipboardHeaderColor";
import { Item, ItemType } from "../../../src/clipboard/Item";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: invokeMock,
}));

vi.mock("../../../src/clipboard/ClipboardCardPreview", () => ({
    default: () => <div data-testid="card-preview" />,
}));

afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    vi.unstubAllGlobals();
});

describe("clipboard card header", () => {
    it("keeps the accepted source color for the background and format tag", () => {
        const item = new Item(
            1,
            "light-header",
            ItemType.Text,
            "content",
            Date.now(),
            "rgb(255, 207, 73)",
            "",
            "",
            0,
            "explorer",
            "",
            "<p>rich content</p>",
        );

        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const header = screen.getByText("type.text").closest("[style]");
        expect(header).toHaveStyle({ color: "#fff" });
        expect(header).toHaveStyle({ background: "rgb(255, 207, 73)" });
        expect(screen.getByText("clipboard.richFormat")).toHaveStyle({
            color: "rgb(255, 207, 73)",
        });
    });

    it("uses the adjusted background color for the format tag too", () => {
        const sourceColor = "rgb(255, 255, 255)";
        const adjustedColor = ensureWhiteTextContrast(sourceColor);
        const item = new Item(
            2,
            "very-light-header",
            ItemType.Text,
            "content",
            Date.now(),
            sourceColor,
            "",
            "",
            0,
            "light-app",
            "",
            "<p>rich content</p>",
        );

        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const header = screen.getByText("type.text").closest("[style]");
        expect(header).toHaveStyle({ background: adjustedColor });
        expect(screen.getByText("clipboard.richFormat")).toHaveStyle({ color: adjustedColor });
    });

    it("uses the shared grid motion and animates the Alt shortcut hint independently", () => {
        const item = new Item(3, "motion-card", ItemType.Text, "content", Date.now());

        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                shortcutHint="1"
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        expect(document.querySelector('[data-motion-preset="gridItem"]')).toHaveAttribute(
            "data-card-hash",
            "motion-card",
        );
        expect(document.querySelector('[data-filter-motion-hash="motion-card"]')).toBeInTheDocument();
        expect(screen.getByText("1")).toHaveAttribute("data-motion-preset", "shortcutHint");
    });

    it("uses shared state motion for favorite and paste-queue selection indicators", () => {
        const favoriteItem = new Item(
            4,
            "favorite-motion-card",
            ItemType.Text,
            "content",
            Date.now(),
            undefined,
            "",
            "",
            1,
        );

        render(
            <ClipboardCard
                item={favoriteItem}
                selected
                selectionMode
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        expect(document.querySelector('[data-motion-state="favorite"]')).toHaveAttribute(
            "data-motion-preset",
            "stateIndicator",
        );
        expect(document.querySelector('[data-motion-state="queue-selection"]')).toHaveAttribute(
            "data-motion-preset",
            "stateIndicator",
        );
    });

    it("configures a privacy-safe external drag and reports an accepted drop", () => {
        const item = new Item(5, "external-drag-card", ItemType.Link, "https://vpaste.app|||", Date.now());
        const values = new Map<string, string>();
        const dataTransfer = {
            effectAllowed: "",
            dropEffect: "none",
            setData: (type: string, value: string) => values.set(type, value),
            setDragImage: vi.fn(),
        };

        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="external-drag-card"]') as HTMLElement;
        fireEvent.dragStart(card, { dataTransfer });
        expect(card).toHaveAttribute("data-external-dragging", "true");
        expect(values.get("text/uri-list")).toBe("https://vpaste.app");
        expect(values.has("application/x-vpaste-item")).toBe(true);
        expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();

        dataTransfer.dropEffect = "copy";
        fireEvent.dragEnd(card, { dataTransfer });
        expect(card).not.toHaveAttribute("data-external-dragging");
        expect(document.querySelector('[data-motion-state="external-drag-complete"]')).toBeInTheDocument();
    });

    it("disables external drag while paste-queue selection mode is active", () => {
        const item = new Item(6, "selection-drag-card", ItemType.Text, "content", Date.now());

        render(
            <ClipboardCard
                item={item}
                selected
                selectionMode
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="selection-drag-card"]');
        expect(card).toHaveAttribute("draggable", "false");
    });

    it("uses the native file drag command only after a file card crosses the threshold", () => {
        vi.stubGlobal("navigator", {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            platform: "Win32",
        });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        invokeMock.mockResolvedValue(true);

        const item = new Item(
            7,
            "native-file-drag-card",
            ItemType.File,
            JSON.stringify(["C:\\Users\\demo\\clip.txt"]),
            Date.now(),
        );
        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="native-file-drag-card"]') as HTMLElement;
        fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseLeave(card);
        fireEvent.mouseMove(card, { buttons: 0, clientX: 8, clientY: 0 });
        expect(invokeMock).not.toHaveBeenCalled();
        fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
        // WebView2 may report buttons=0 for a move while the physical left
        // button is still held; the gesture must remain usable in that case.
        fireEvent.mouseMove(card, { buttons: 0, clientX: 8, clientY: 0 });

        expect(invokeMock).toHaveBeenCalledWith("native_drag_file", {
            paths: ["C:\\Users\\demo\\clip.txt"],
            isImage: false,
        });
    });

    it("passes every path from a multi-file card to the native drag command", () => {
        vi.stubGlobal("navigator", {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            platform: "Win32",
        });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        invokeMock.mockResolvedValue(true);

        const item = new Item(
            11,
            "native-multi-file-drag-card",
            ItemType.File,
            JSON.stringify([
                "C:\\Users\\demo\\first.txt",
                "D:\\Shared\\second.pdf",
                "C:\\Users\\demo\\third.png",
            ]),
            Date.now(),
        );
        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="native-multi-file-drag-card"]') as HTMLElement;
        fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseMove(card, { buttons: 1, clientX: 8, clientY: 0 });

        expect(invokeMock).toHaveBeenCalledWith("native_drag_file", {
            paths: [
                "C:\\Users\\demo\\first.txt",
                "D:\\Shared\\second.pdf",
                "C:\\Users\\demo\\third.png",
            ],
            isImage: false,
        });
    });

    it("asks the native drag command to materialize image history as an image file", () => {
        vi.stubGlobal("navigator", {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            platform: "Win32",
        });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        invokeMock.mockResolvedValue(true);

        const item = new Item(
            8,
            "native-image-drag-card",
            ItemType.Image,
            "D:\\vPaste\\history\\image-data",
            Date.now(),
        );
        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="native-image-drag-card"]') as HTMLElement;
        fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseMove(card, { buttons: 1, clientX: 8, clientY: 0 });

        expect(invokeMock).toHaveBeenCalledWith("native_drag_file", {
            paths: ["D:\\vPaste\\history\\image-data"],
            isImage: true,
        });
    });

    it("passes the complete file list to the native drag command on macOS too", () => {
        vi.stubGlobal("navigator", {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
            platform: "MacIntel",
        });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        invokeMock.mockResolvedValue(true);

        const item = new Item(
            9,
            "native-macos-file-drag-card",
            ItemType.File,
            JSON.stringify(["/Users/demo/clip.txt", "/Volumes/Shared/second.pdf"]),
            Date.now(),
        );
        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="native-macos-file-drag-card"]') as HTMLElement;
        fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseMove(card, { buttons: 1, clientX: 8, clientY: 0 });

        expect(invokeMock).toHaveBeenCalledWith("native_drag_file", {
            paths: ["/Users/demo/clip.txt", "/Volumes/Shared/second.pdf"],
            isImage: false,
        });
    });

    it("restores a native file card after a canceled drop", async () => {
        vi.stubGlobal("navigator", {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            platform: "Win32",
        });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        invokeMock.mockResolvedValue(false);

        const item = new Item(
            10,
            "canceled-native-drag-card",
            ItemType.File,
            JSON.stringify(["C:\\Users\\demo\\clip.txt"]),
            Date.now(),
        );
        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const card = document.querySelector('[data-hash="canceled-native-drag-card"]') as HTMLElement;
        fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.mouseMove(card, { buttons: 1, clientX: 8, clientY: 0 });
        expect(card).toHaveAttribute("data-external-dragging", "true");

        await waitFor(() => expect(card).not.toHaveAttribute("data-external-dragging"));
        expect(document.querySelector('[data-motion-state="external-drag-complete"]')).not.toBeInTheDocument();
    });

});
