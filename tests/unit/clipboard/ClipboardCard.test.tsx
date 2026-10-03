import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    vi.restoreAllMocks();
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

    it("uses the dragged card content as its drag thumbnail", () => {
        const item = new Item(6, "thumbnail-text", ItemType.Text, "git clone example", Date.now());
        const dataTransfer = { effectAllowed: "", setData: vi.fn(), setDragImage: vi.fn() };
        render(
            <ClipboardCard
                item={item}
                selected
                simulatedHover
                refreshKey={0}
                searchQuery=""
                shortcutHint="1"
                filterMotionIndex={0}
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );
        const card = document.querySelector('[data-hash="thumbnail-text"]') as HTMLElement;
        card.querySelector('[data-testid="card-preview"]')!.textContent = "git clone example";

        fireEvent.dragStart(card, { dataTransfer });
        const thumbnail = dataTransfer.setDragImage.mock.calls[0][0] as HTMLElement;
        expect(thumbnail).toHaveTextContent("git clone example");
        expect(thumbnail).not.toHaveTextContent("clipboard.dragging");
        expect(thumbnail).toHaveAttribute("aria-hidden", "true");
        expect(thumbnail.inert).toBe(true);
        expect(thumbnail.querySelector('[data-hash], [data-external-dragging]')).toBeNull();
        expect(thumbnail.querySelector('[data-motion-preset="shortcutHint"]')).toBeNull();
        expect(thumbnail.querySelector('[class*="selected"], [class*="simulated-hover"]')).toBeNull();
        expect(card).toHaveAttribute("data-external-dragging", "true");
    });

    it("preserves the visible image in the browser drag thumbnail and removes the temporary preview", () => {
        const item = new Item(6, "thumbnail-image", ItemType.Image, "", Date.now(), undefined, "/preview.png");
        const dataTransfer = { effectAllowed: "", setData: vi.fn(), setDragImage: vi.fn() };
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
        const card = document.querySelector('[data-hash="thumbnail-image"]') as HTMLElement;
        const image = document.createElement("img");
        image.src = "data:image/png;base64,visible-image";
        card.querySelector('[data-testid="card-preview"]')!.appendChild(image);
        const frame = vi.spyOn(window, "requestAnimationFrame");
        const previousFrames = frame.mock.calls.length;

        fireEvent.dragStart(card, { dataTransfer });
        const thumbnail = dataTransfer.setDragImage.mock.calls[0][0] as HTMLElement;
        expect(thumbnail.querySelector("img")?.src).toBe(image.src);
        expect(thumbnail.isConnected).toBe(true);
        frame.mock.calls.slice(previousFrames).forEach(([callback]) => callback(0));
        expect(thumbnail.isConnected).toBe(false);
        frame.mockRestore();
    });

    it("preserves leading and trailing whitespace when dragging ordinary text", () => {
        const originalText = "    print('x')  \r\nnext line \r\n";
        const item = new Item(7, "short-text-drag", ItemType.Text, originalText, Date.now());
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

        const card = document.querySelector('[data-hash="short-text-drag"]') as HTMLElement;
        fireEvent.dragStart(card, { dataTransfer });
        expect(values.get("text/plain")).toBe(originalText);
    });

    it("never drags a long-text preview instead of the full stored text", async () => {
        const fullText = `  ${"long text\n".repeat(1500)}  `;
        const item = new Item(7, "long-text-drag", ItemType.TextFile, "C:\\history\\long-text-drag", Date.now(), undefined, fullText.slice(0, 1800));
        let resolveText!: (text: string) => void;
        invokeMock.mockReturnValue(new Promise<string>(resolve => { resolveText = resolve; }));
        const onDragUnavailable = vi.fn();
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
                onDragUnavailable={onDragUnavailable}
            />,
        );

        const card = document.querySelector('[data-hash="long-text-drag"]') as HTMLElement;
        fireEvent.mouseEnter(card);
        expect(invokeMock).toHaveBeenCalledWith("plain_text_content", { hash: "long-text-drag" });

        expect(fireEvent.dragStart(card, { dataTransfer })).toBe(false);
        expect(values.has("text/plain")).toBe(false);
        expect(onDragUnavailable).toHaveBeenCalledOnce();

        await act(async () => { resolveText(fullText); });
        fireEvent.mouseDown(card, { button: 0 });
        fireEvent.mouseLeave(card);
        expect(fireEvent.dragStart(card, { dataTransfer })).toBe(true);
        expect(values.get("text/plain")).toBe(fullText);
        expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
    });

    it.each(["mouseup", "blur"])("discards prepared long-text gesture data after %s outside the card", async (cancelEvent) => {
        const fullText = "stored full text";
        const item = new Item(7, "cancel-long-text-drag", ItemType.TextFile, "/history/long-text", Date.now(), undefined, "preview");
        invokeMock.mockResolvedValue(fullText);
        const dataTransfer = { effectAllowed: "", setData: vi.fn(), setDragImage: vi.fn() };
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
        const card = document.querySelector('[data-hash="cancel-long-text-drag"]') as HTMLElement;
        await act(async () => { fireEvent.mouseEnter(card); });
        fireEvent.mouseDown(card, { button: 0 });
        fireEvent.mouseLeave(card);
        if (cancelEvent === "mouseup") fireEvent.mouseUp(document.body);
        else fireEvent.blur(window);

        expect(fireEvent.dragStart(card, { dataTransfer })).toBe(false);
        expect(dataTransfer.setData).not.toHaveBeenCalled();
        expect(dataTransfer.setDragImage).not.toHaveBeenCalled();
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

    it.each([
        { name: "image", type: ItemType.Image, paths: ["/history/image.png"], title: "type.image" },
        { name: "image file", type: ItemType.File, paths: ["/history/image.png"], title: "type.image" },
        { name: "document", type: ItemType.File, paths: ["/history/report.pdf"], title: "type.file" },
        { name: "folder", type: ItemType.File, paths: ["/history/project"], title: "type.file" },
        { name: "multiple files", type: ItemType.File, paths: ["/history/report.pdf", "/history/notes.txt"], title: "type.file" },
    ])("captures the complete macOS $name card before native dragging", async ({ type, paths, title }) => {
        vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel" });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        let finishCapture!: (bytes: number[]) => void;
        let finishDrag!: (dropped: boolean) => void;
        const readStyle = window.getComputedStyle.bind(window);
        vi.spyOn(window, "getComputedStyle").mockImplementation(element => {
            const style = readStyle(element);
            if (element.hasAttribute("data-native-drag-preview")) {
                Object.defineProperty(style, "borderTopLeftRadius", { value: "8.4px" });
            }
            return style;
        });
        invokeMock.mockImplementation((command: string) => command === "capture_native_drag_preview"
            ? new Promise<number[]>(resolve => { finishCapture = resolve; })
            : new Promise<boolean>(resolve => { finishDrag = resolve; }));
        const item = new Item(12, "mac-card-preview", type, type === ItemType.File ? JSON.stringify(paths) : paths[0], Date.now());
        render(<ClipboardCard item={item} selected simulatedHover refreshKey={0} searchQuery=""
            filterMotionIndex={0} mediaPlaybackReady={false} shortcutHint="1" t={key => key} onContextMenu={vi.fn()} />);
        const card = document.querySelector('[data-hash="mac-card-preview"]') as HTMLElement;
        if (title === "type.image") {
            card.querySelector('[data-testid="card-preview"]')!.innerHTML = '<img src="data:image/png;base64,source-image" />';
        } else {
            card.querySelector('[data-testid="card-preview"]')!.textContent = paths.join("\n");
        }
        fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 80 });
        fireEvent.mouseMove(card, { buttons: 1, clientX: 18, clientY: 80 });
        await waitFor(() => expect(document.querySelector('[data-native-drag-preview]')).not.toBeNull());
        const copy = document.querySelector('[data-native-drag-preview]') as HTMLElement;
        expect(copy).toHaveTextContent(title);
        if (title === "type.image") expect(copy.querySelector("img")?.src).toContain("source-image");
        else for (const path of paths) expect(copy).toHaveTextContent(path);
        expect(copy.querySelector('[data-hash], [class*="selected"], [data-motion-preset="shortcutHint"]')).toBeNull();
        await waitFor(() => expect(finishCapture).toBeTypeOf("function"));
        expect(invokeMock).toHaveBeenCalledWith("capture_native_drag_preview", {
            rect: expect.objectContaining({ cornerRadius: 8.4 }),
        });
        await act(async () => finishCapture([137, 80, 78, 71]));
        expect(copy.isConnected).toBe(false);
        expect(invokeMock).toHaveBeenLastCalledWith("native_drag_file", {
            paths, isImage: type === ItemType.Image, previewPng: [137, 80, 78, 71],
        });
        await act(async () => finishDrag(false));
        expect(card).not.toHaveAttribute("data-external-dragging");
    });

    it.each([
        { type: ItemType.Image, cancel: "release" }, { type: ItemType.Image, cancel: "blur" }, { type: ItemType.Image, cancel: "unmount" },
        { type: ItemType.File, cancel: "release" }, { type: ItemType.File, cancel: "blur" }, { type: ItemType.File, cancel: "unmount" },
    ])("cancels a pending macOS $type card snapshot on $cancel", async ({ type, cancel }) => {
        vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel" });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        let finishCapture!: (bytes: number[]) => void;
        invokeMock.mockImplementation(() => new Promise<number[]>(resolve => { finishCapture = resolve; }));
        const item = new Item(13, "mac-card-cancel", type, type === ItemType.File ? JSON.stringify(["/history/report.pdf"]) : "/history/image.png", Date.now());
        const view = render(<ClipboardCard item={item} selected={false} simulatedHover={false} refreshKey={0} searchQuery=""
            filterMotionIndex={0} mediaPlaybackReady={false} t={key => key} onContextMenu={vi.fn()} />);
        const card = document.querySelector('[data-hash="mac-card-cancel"]') as HTMLElement;
        fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 80 });
        fireEvent.mouseMove(card, { buttons: 1, clientX: 18, clientY: 80 });
        await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_native_drag_preview", expect.anything()));
        if (cancel === "release") {
            fireEvent.mouseLeave(card);
            fireEvent.mouseUp(document.body);
        } else if (cancel === "blur") {
            fireEvent.blur(window);
        } else {
            view.unmount();
        }
        expect(document.querySelector('[data-native-drag-preview]')).toBeNull();
        await act(async () => finishCapture([137, 80, 78, 71]));
        expect(document.querySelector('[data-native-drag-preview]')).toBeNull();
        expect(invokeMock.mock.calls.some(([command]) => command === "native_drag_file")).toBe(false);
        if (cancel !== "unmount") expect(card).not.toHaveAttribute("data-external-dragging");
    });

    it("passes the complete file list with the shared card preview on macOS", async () => {
        vi.stubGlobal("navigator", {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
            platform: "MacIntel",
        });
        vi.stubGlobal("__TAURI_INTERNALS__", {});
        invokeMock.mockImplementation((command: string) => Promise.resolve(
            command === "capture_native_drag_preview" ? [137, 80, 78, 71] : true,
        ));

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

        await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("native_drag_file", {
            paths: ["/Users/demo/clip.txt", "/Volumes/Shared/second.pdf"],
            isImage: false,
            previewPng: [137, 80, 78, 71],
        }));
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
