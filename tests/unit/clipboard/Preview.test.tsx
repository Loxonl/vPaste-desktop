import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Item, ItemType } from "../../../src/clipboard/Item";
import { createClipboardPreviewRuntime } from "../../../src/clipboard/clipboardPreviewRuntime";
import { PreviewBody } from "../../../src/clipboard/Preview";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
    emitTo: vi.fn(),
    listen: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

const t = (key: string) => key;

describe("PreviewBody transparency", () => {
    it("renders the complete long text delivered by the preview runtime", async () => {
        const body = "line of saved text\n".repeat(1200) + "FINAL LINE";
        const path = "C:\\history\\data\\long-text";
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "plain_text_content") return body;
            return undefined;
        });
        await createClipboardPreviewRuntime({
            closeContextMenu: vi.fn(), requestSequence: { current: 0 },
            selectItem: vi.fn(), showToast: vi.fn(), t,
        }).openPreviewItem(new Item(1, "long-text", ItemType.TextFile, path, 0, undefined, body.slice(0, 1800)));
        const call = tauri.invoke.mock.calls.find(([command]) => command === "show_preview_window");
        expect(call).toBeDefined();
        const { container } = render(<PreviewBody payload={call![1]} t={t} />);
        expect(container.querySelector("pre")?.textContent).toBe(body);
        expect(container).not.toHaveTextContent(path);
    });

    beforeEach(() => {
        tauri.invoke.mockReset();
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "history_image_metadata") {
                return { width: 320, height: 180, isGif: false };
            }
            if (command === "history_file_preview_asset_path") {
                return "C:\\cache\\transparent.png";
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
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
    });

    it("shows the checkerboard behind an image preview", () => {
        const { container } = render(
            <PreviewBody
                payload={{ item_type: ItemType.Image, content: "C:\\history\\transparent.bin" }}
                t={t}
            />,
        );

        expect(container.querySelector("img")?.className).toContain("transparency-grid");
    });

    it("shows the checkerboard behind a single-image file preview", async () => {
        const { container } = render(
            <PreviewBody
                payload={{
                    item_type: ItemType.File,
                    content: JSON.stringify(["C:\\images\\transparent.png"]),
                }}
                t={t}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("img")?.className).toContain("transparency-grid");
        });
    });

    it("uses the same mapped file icon and extension label as the clipboard card", async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "single-icon",
                    paths: ["C:\\Documents\\contract.doc"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\Documents\\contract.doc",
                    secondary_text: "",
                    extension: "DOC",
                    preview_path: "",
                    contains_directories: false,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const { container } = render(
            <PreviewBody
                payload={{
                    item_type: ItemType.File,
                    content: JSON.stringify(["C:\\Documents\\contract.doc"]),
                }}
                t={t}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='known']")).toHaveTextContent("DOC");
        });
        expect(container.querySelectorAll("[data-file-presentation='known'] img")).toHaveLength(1);
        expect(container.querySelector("[class*='preview-file-symbol']")).toBeNull();
    });
});
