import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
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
});
