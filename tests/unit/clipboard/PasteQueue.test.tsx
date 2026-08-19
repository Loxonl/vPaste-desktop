import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PasteQueue from "../../../src/clipboard/PasteQueue";
import { ItemType } from "../../../src/clipboard/Item";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const render = (ui: ReactElement) => renderUi(<MotionTestProvider>{ui}</MotionTestProvider>);

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(async () => () => undefined),
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
    startDragging: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: tauri.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ startDragging: tauri.startDragging }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));
vi.mock("@mui/icons-material/CloseRounded", () => ({ default: () => <span /> }));
vi.mock("@mui/icons-material/DeleteOutlineRounded", () => ({ default: () => <span /> }));
vi.mock("@mui/icons-material/DragIndicatorRounded", () => ({ default: () => <span /> }));
vi.mock("@mui/icons-material/MoreHorizRounded", () => ({ default: () => <span /> }));
vi.mock("@mui/icons-material/SwapVertRounded", () => ({ default: () => <span /> }));
vi.mock("@mui/icons-material/UndoRounded", () => ({ default: () => <span /> }));
vi.mock("../../../src/lang", () => ({
    useLanguage: () => ({
        t: (key: string) => key,
    }),
}));

const items = [
    {
        id: 1,
        hash: "first",
        itemType: ItemType.Text,
        content: "First queued value",
        time: 2,
        previewContent: "First queued value",
        textContent: "",
        label: 0,
        appSource: "",
        appIconPath: "",
        richHtml: "",
        tags: [],
    },
    {
        id: 2,
        hash: "second",
        itemType: ItemType.Text,
        content: "Second queued value",
        time: 1,
        previewContent: "Second queued value",
        textContent: "",
        label: 0,
        appSource: "",
        appIconPath: "",
        richHtml: "",
        tags: [],
    },
];

function state(error: null | { hash: string; message: string } = null) {
    return {
        active: true,
        busy: false,
        capacity: 100,
        items,
        error,
        undoHash: null,
        undoExpiresAt: null,
        revision: 1,
    };
}

beforeEach(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    tauri.invoke.mockReset().mockImplementation(async (command: string) => {
        if (command === "get_paste_queue_state") return state();
        return state();
    });
    tauri.listeners.clear();
    tauri.listen.mockReset().mockImplementation(async (
        event: string,
        callback: (event: { payload: unknown }) => void,
    ) => {
        tauri.listeners.set(event, callback);
        return () => tauri.listeners.delete(event);
    });
    tauri.startDragging.mockReset();
});

afterEach(() => {
    cleanup();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("PasteQueue", () => {
    it("loads image thumbnails through the history preview asset command", async () => {
        const imageState = {
            ...state(),
            items: [{
                ...items[0],
                hash: "image",
                itemType: ItemType.Image,
                content: "/history/original-image.bin",
                previewContent: "/history/image-hash",
            }],
        };
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "get_paste_queue_state") return imageState;
            if (command === "history_image_card_preview_asset_path") {
                return "/cache/image-card-preview.png";
            }
            return imageState;
        });

        const { container } = render(<PasteQueue />);

        await waitFor(() => {
            const image = container.querySelector("img");
            expect(tauri.invoke).toHaveBeenCalledWith(
                "history_image_card_preview_asset_path",
                { path: "/history/image-hash" },
            );
            expect(image).toHaveAttribute("src", "asset:///cache/image-card-preview.png");
        });
    });

    it("falls back to a decrypted data URL when an image preview asset cannot be created", async () => {
        const imageState = {
            ...state(),
            items: [{
                ...items[0],
                hash: "fallback-image",
                itemType: ItemType.Image,
                content: "/history/original-image.bin",
                previewContent: "/history/fallback-image-hash",
            }],
        };
        tauri.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
            if (command === "get_paste_queue_state") return imageState;
            if (command === "history_image_card_preview_asset_path") {
                throw new Error("preview unavailable");
            }
            if (command === "history_file_data_url") {
                return `data:image/png;base64,${args?.path === "/history/fallback-image-hash" ? "preview" : "original"}`;
            }
            return imageState;
        });

        const { container } = render(<PasteQueue />);

        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("history_file_data_url", {
                path: "/history/fallback-image-hash",
            });
            expect(container.querySelector("img")).toHaveAttribute(
                "src",
                "data:image/png;base64,preview",
            );
        });
    });

    it("shows useful compact content for every non-image queue item type", async () => {
        const allTypeState = {
            ...state(),
            items: [
                { ...items[0], hash: "text", itemType: ItemType.Text, content: "Plain text" },
                {
                    ...items[0],
                    hash: "rich",
                    itemType: ItemType.Text,
                    content: "Rich text fallback",
                    richHtml: "<strong>Rich text</strong>",
                },
                {
                    ...items[0],
                    hash: "text-file",
                    itemType: ItemType.TextFile,
                    content: "/history/large-text.bin",
                    previewContent: "Large text preview",
                },
                {
                    ...items[0],
                    hash: "link",
                    itemType: ItemType.Link,
                    content: "https://vpaste.app|||/preview.png|||vPaste|||image",
                },
                { ...items[0], hash: "color", itemType: ItemType.Color, content: "#5B8CFF" },
                {
                    ...items[0],
                    hash: "files",
                    itemType: ItemType.File,
                    content: JSON.stringify(["/docs/first.pdf", "/docs/second.txt"]),
                },
            ],
        };
        tauri.invoke.mockImplementation(async (command: string) => (
            command === "get_paste_queue_state" ? allTypeState : allTypeState
        ));

        render(<PasteQueue />);

        await waitFor(() => expect(screen.getByText("Plain text")).toBeVisible());
        expect(screen.getByText("Rich text fallback")).toBeVisible();
        expect(screen.getByText("Large text preview")).toBeVisible();
        expect(screen.queryByText("/history/large-text.bin")).not.toBeInTheDocument();
        expect(screen.getByText("https://vpaste.app")).toBeVisible();
        expect(screen.getByText("#5B8CFF")).toBeVisible();
        expect(screen.getByText("first.pdf +1")).toBeVisible();
    });

    it("explicitly reveals a row delete action while the pointer is inside", async () => {
        render(<PasteQueue />);

        const row = (await screen.findAllByRole("listitem"))[0];
        const deleteButton = within(row).getByRole("button", { name: "pasteQueue.remove" });
        expect(row).toHaveAttribute("data-pointer-hovered", "false");
        expect(deleteButton).toHaveAttribute("data-pointer-visible", "false");

        fireEvent.pointerEnter(row);
        expect(row).toHaveAttribute("data-pointer-hovered", "true");
        expect(deleteButton).toHaveAttribute("data-pointer-visible", "true");

        fireEvent.pointerLeave(row);
        expect(row).toHaveAttribute("data-pointer-hovered", "false");
        expect(deleteButton).toHaveAttribute("data-pointer-visible", "false");
    });

    it("updates row hover from native pointer coordinates without clicking the drag handle", async () => {
        render(<PasteQueue />);

        const row = (await screen.findAllByRole("listitem"))[0];
        await waitFor(() => {
            expect(tauri.listeners.has("paste-queue-pointer-position")).toBe(true);
        });
        const elementFromPoint = vi.fn(() => row);
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: elementFromPoint,
        });

        act(() => {
            tauri.listeners.get("paste-queue-pointer-position")?.({
                payload: { x: 80, y: 90, inside: true },
            });
        });
        expect(row).toHaveAttribute("data-pointer-hovered", "true");

        act(() => {
            tauri.listeners.get("paste-queue-pointer-position")?.({
                payload: { x: -1, y: -1, inside: false },
            });
        });
        expect(row).toHaveAttribute("data-pointer-hovered", "false");
        delete (document as Document & { elementFromPoint?: unknown }).elementFromPoint;
    });

    it("directly pastes, removes, and reverses through queue commands", async () => {
        const user = userEvent.setup();
        expect(PasteQueue).toBeTypeOf("function");
        render(<PasteQueue />);

        const firstItem = await screen.findByRole("button", { name: /First queued value/ });
        await user.click(firstItem);
        expect(firstItem).not.toHaveFocus();
        await user.click(screen.getAllByRole("button", { name: "pasteQueue.remove" })[1]);
        await user.click(screen.getByRole("button", { name: "pasteQueue.reverse" }));

        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("paste_queue_item", { hash: "first" });
            expect(tauri.invoke).toHaveBeenCalledWith("remove_paste_queue_item", { hash: "second" });
            expect(tauri.invoke).toHaveBeenCalledWith("reverse_paste_queue", undefined);
        });
    });

    it("drags the whole row vertically while neighboring rows make space", async () => {
        render(<PasteQueue />);
        const rows = await screen.findAllByRole("listitem");
        const handles = screen.getAllByLabelText("pasteQueue.drag");
        const bounds = (top: number) => ({
            x: 0,
            y: top,
            top,
            left: 0,
            right: 320,
            bottom: top + 66,
            width: 320,
            height: 66,
            toJSON: () => ({}),
        });
        vi.spyOn(rows[0], "getBoundingClientRect").mockReturnValue(bounds(0));
        vi.spyOn(rows[1], "getBoundingClientRect").mockReturnValue(bounds(66));

        fireEvent.pointerDown(handles[1], {
            pointerId: 7,
            isPrimary: true,
            button: 0,
            clientY: 99,
        });
        fireEvent.pointerMove(screen.getByTestId("paste-queue"), {
            pointerId: 7,
            isPrimary: true,
            clientY: 10,
        });

        expect(rows[1].querySelector("[data-drag-surface]"))
            .toHaveStyle({ transform: "translate3d(0, -66px, 0)" });
        expect(rows[0].querySelector("[data-drag-surface]"))
            .toHaveStyle({ transform: "translate3d(0, 66px, 0)" });

        fireEvent.pointerUp(screen.getByTestId("paste-queue"), {
            pointerId: 7,
            isPrimary: true,
            clientY: 10,
        });
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("reorder_paste_queue", {
                hashes: ["second", "first"],
            });
        });
    });

    it("reorders from the keyboard-accessible drag handle", async () => {
        const user = userEvent.setup();
        render(<PasteQueue />);

        const handles = await screen.findAllByRole("button", { name: "pasteQueue.drag" });
        handles[1].focus();
        await user.keyboard("{ArrowUp}");

        expect(tauri.invoke).toHaveBeenCalledWith("reorder_paste_queue", {
            hashes: ["second", "first"],
        });
    });

    it("requires in-window confirmation before clearing", async () => {
        const user = userEvent.setup();
        render(<PasteQueue />);

        await screen.findByText("First queued value");
        await user.click(screen.getByRole("button", { name: "pasteQueue.more" }));
        await user.click(screen.getByRole("menuitem", { name: "pasteQueue.clear" }));
        expect(tauri.invoke).not.toHaveBeenCalledWith("clear_paste_queue", undefined);
        expect(screen.getByRole("alertdialog")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "pasteQueue.clear" }));
        expect(tauri.invoke).toHaveBeenCalledWith("clear_paste_queue", undefined);
    });

    it("restores focus to the menu trigger after Escape closes a menu or confirmation", async () => {
        const user = userEvent.setup();
        render(<PasteQueue />);

        const moreButton = await screen.findByRole("button", { name: "pasteQueue.more" });
        await user.click(moreButton);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "pasteQueue.clear" })).toBeVisible());
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("menuitem", { name: "pasteQueue.clear" })).not.toBeInTheDocument());
        expect(moreButton).toHaveFocus();

        await user.click(moreButton);
        await user.click(screen.getByRole("menuitem", { name: "pasteQueue.clear" }));
        expect(screen.getByRole("alertdialog")).toBeVisible();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        expect(moreButton).toHaveFocus();
    });

    it("dismisses the clear queue menu when focus leaves it", async () => {
        const user = userEvent.setup();
        render(<PasteQueue />);

        const moreButton = await screen.findByRole("button", { name: "pasteQueue.more" });
        await user.click(moreButton);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "pasteQueue.clear" })).toBeVisible());

        fireEvent.pointerDown(document.body);
        await waitFor(() => expect(screen.queryByRole("menuitem", { name: "pasteQueue.clear" })).not.toBeInTheDocument());

        await user.click(moreButton);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "pasteQueue.clear" })).toBeVisible());

        fireEvent.focusIn(screen.getByRole("menuitem", { name: "pasteQueue.clear" }));
        expect(screen.getByRole("menuitem", { name: "pasteQueue.clear" })).toBeVisible();
        fireEvent.focusIn(screen.getByRole("button", { name: "pasteQueue.close" }));
        await waitFor(() => expect(screen.queryByRole("menuitem", { name: "pasteQueue.clear" })).not.toBeInTheDocument());

        await user.click(moreButton);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "pasteQueue.clear" })).toBeVisible());

        fireEvent.blur(window);
        await waitFor(() => expect(screen.queryByRole("menuitem", { name: "pasteQueue.clear" })).not.toBeInTheDocument());
    });

    it("dismisses the clear queue menu from a native outside-window click event", async () => {
        const user = userEvent.setup();
        render(<PasteQueue />);

        const moreButton = await screen.findByRole("button", { name: "pasteQueue.more" });
        await user.click(moreButton);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "pasteQueue.clear" })).toBeVisible());
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("set_paste_queue_menu_open", { open: true });
        });

        act(() => {
            tauri.listeners.get("paste-queue-dismiss-menu")?.({ payload: null });
        });

        await waitFor(() => expect(screen.queryByRole("menuitem", { name: "pasteQueue.clear" })).not.toBeInTheDocument());
        await waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("set_paste_queue_menu_open", { open: false });
        });
    });

    it("offers retry and delete actions for a failed item", async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "get_paste_queue_state") {
                return state({ hash: "first", message: "Paste failed" });
            }
            return state();
        });
        render(<PasteQueue />);

        expect(await screen.findByRole("alert")).toHaveTextContent("Paste failed");
        fireEvent.click(screen.getByRole("button", { name: "pasteQueue.retry" }));
        fireEvent.click(screen.getByRole("button", { name: "pasteQueue.deleteFailed" }));

        expect(tauri.invoke).toHaveBeenCalledWith("paste_queue_item", { hash: "first" });
        expect(tauri.invoke).toHaveBeenCalledWith("remove_paste_queue_item", { hash: "first" });
    });

    it("disables every queue mutation while a paste is in progress", async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "get_paste_queue_state") {
                return {
                    ...state({ hash: "first", message: "Paste failed" }),
                    busy: true,
                    undoHash: "first",
                    undoExpiresAt: Date.now() + 5_000,
                };
            }
            return state();
        });
        render(<PasteQueue />);

        expect(await screen.findByRole("button", { name: "pasteQueue.reverse" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "pasteQueue.more" })).toBeDisabled();
        (await screen.findAllByRole("button", { name: "pasteQueue.drag" }))
            .forEach(button => expect(button).toBeDisabled());
        screen.getAllByRole("button", { name: "pasteQueue.remove" })
            .forEach(button => expect(button).toBeDisabled());
        expect(screen.getByRole("button", { name: "pasteQueue.retry" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "pasteQueue.deleteFailed" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "pasteQueue.undo" })).toBeDisabled();
    });
});
