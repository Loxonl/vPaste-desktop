import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Preview from "../../../src/clipboard/Preview";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/api/event", () => ({
    emitTo: vi.fn(),
    listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
        tauri.listeners.set(name, callback);
        return () => tauri.listeners.delete(name);
    },
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));

const emit = (payload: Record<string, unknown>) => act(() => tauri.listeners.get("preview-item")?.({ payload }));
const open = (reducedMotion: "always" | "never" = "always") => render(
    <MotionTestProvider reducedMotion={reducedMotion}><Preview /></MotionTestProvider>,
);

// Keep this interaction test independent of a cold module transform in a full run.
beforeAll(async () => { await import("../../../src/clipboard/ImageTextView"); });

beforeEach(() => {
    tauri.listeners.clear();
    tauri.invoke.mockReset().mockImplementation(async (command: string) => {
        if (command === "commit_preview_window") return true;
        if (command === "recognize_image_text") return { status: "complete", text: "Editable OCR text", error: null };
        if (command === "file_preview_info") return {
            kind: "pdf-preview", paths: ["C:/fixture.pdf"], display_path: "C:/fixture.pdf", exists: true,
        };
        return null;
    });
});
afterEach(cleanup);

describe("WinUI fallback preview toolbar", () => {
    it("places the shared Preview title and single pin above the PDF toolbar", async () => {
        const { container } = open();
        emit({ request_id: 1, item_type: "File", content: '["C:/fixture.pdf"]', native_toolbar: true });
        const pdf = await screen.findByTitle("fixture.pdf");
        await waitFor(() => expect(pdf.closest("[data-preview-phase]")).toHaveAttribute("data-preview-phase", "current"));
        const toolbar = container.querySelector("[data-preview-toolbar]");
        expect(toolbar).not.toBeNull();
        expect(toolbar).toContainElement(screen.getByRole("heading", { name: "preview.title" }));
        expect(toolbar).not.toContainElement(pdf);
        expect(toolbar?.nextElementSibling).toContainElement(pdf);
        const pin = screen.getByRole("button", { name: "preview.pin" });
        expect(pin).toHaveAttribute("aria-pressed", "false");
        expect(pin).toHaveTextContent("\uE718");
        expect(screen.queryByRole("button", { name: "common.close" })).not.toBeInTheDocument();
    });

    it("opens OCR unpinned in the same toolbar and keeps edit, copy, and Escape available", async () => {
        open();
        emit({ request_id: 1, item_type: "ImageText", content: "image-hash", native_toolbar: true });
        const editor = await screen.findByDisplayValue("Editable OCR text");
        await waitFor(() => expect(editor).toBeVisible());
        const pin = screen.getByRole("button", { name: "preview.pin" });
        expect(pin.closest("[data-preview-toolbar]")).not.toBeNull();
        expect(pin).toHaveAttribute("aria-pressed", "false");
        expect(screen.queryByRole("button", { name: "common.close" })).not.toBeInTheDocument();
        const user = userEvent.setup();
        fireEvent.change(editor, { target: { value: "Edited OCR text" } });
        await user.click(screen.getByRole("button", { name: "ocr.copy" }));
        expect(tauri.invoke).toHaveBeenCalledWith("copy", { item: "Edited OCR text", itemType: "Text", hash: null });
        expect(editor).toHaveFocus();
        await user.click(pin);
        expect(pin).toHaveAttribute("aria-pressed", "true");
        expect(pin).toHaveTextContent("\uE842");
        await user.click(pin);
        expect(pin).toHaveAttribute("aria-pressed", "false");
        expect(tauri.invoke).toHaveBeenCalledWith("set_preview_pinned", { pinned: false });
        fireEvent.keyDown(editor, { key: "Escape" });
        expect(tauri.invoke).toHaveBeenCalledWith("hide_preview_window");
    });

    it("preserves the shipping single pin on other renderers", async () => {
        const { container } = open();
        emit({ request_id: 1, item_type: "Text", content: "Shipping WebView", native_toolbar: false });
        await screen.findByText("Shipping WebView");
        expect(container.querySelector("[data-preview-toolbar]")).toBeNull();
        expect(screen.queryByRole("heading", { name: "preview.title" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "common.close" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "preview.pin" })).toBeInTheDocument();
    });

    it.each(["always", "never"] as const)("keeps actions stable across content switches and cancels late image readiness (%s)", async reducedMotion => {
        const { container } = open(reducedMotion);
        emit({ request_id: 1, item_type: "Text", content: "First", native_toolbar: true });
        await waitFor(() => expect(screen.getByText("First").closest("[data-preview-phase]")).toHaveAttribute("data-preview-phase", "current"));
        const user = userEvent.setup();
        const pin = screen.getByRole("button", { name: "preview.pin" });
        await user.click(pin);
        expect(tauri.invoke).toHaveBeenCalledWith("set_preview_pinned", { pinned: true });
        expect(pin).toHaveAttribute("aria-pressed", "true");
        for (const key of ["ArrowLeft", "ArrowRight", "Tab", " "]) fireEvent.keyDown(pin, { key });
        expect(tauri.invoke).not.toHaveBeenCalledWith("preview_navigate_selection", expect.anything());
        expect(tauri.invoke).not.toHaveBeenCalledWith("hide_preview_window");
        emit({ request_id: 2, item_type: "Color", content: "#123456", native_toolbar: true });
        await waitFor(() => expect(screen.getByText("#123456").closest("[data-preview-phase]")).toHaveAttribute("data-preview-phase", "current"));
        expect(screen.getByRole("button", { name: "preview.pin" })).toBe(pin);
        expect(screen.queryByRole("button", { name: "common.close" })).not.toBeInTheDocument();
        emit({ request_id: 3, item_type: "Image", content: "late.png", preview_asset_path: "late.png", native_toolbar: true });
        await waitFor(() => expect(container.querySelector('img[src="asset://late.png"]')).not.toBeNull());
        const image = container.querySelector('img[src="asset://late.png"]')!;
        fireEvent.keyDown(pin, { key: "Escape" });
        expect(tauri.invoke).toHaveBeenCalledWith("hide_preview_window");
        fireEvent.load(image);
        expect(tauri.invoke).not.toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 3 }));
    });
});
