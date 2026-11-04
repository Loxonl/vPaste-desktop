import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Preview from "../../../src/clipboard/Preview";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
const fileModule = vi.hoisted(() => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    return { loads: 0, allowed: false, ready, release };
});
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
vi.mock("../../../src/clipboard/FileTypePresentation", () => {
    fileModule.loads += 1;
    return { FileTypePresentation: () => {
        if (!fileModule.allowed) throw fileModule.ready;
        return <div role="img" aria-label="File icon" />;
    } };
});
afterEach(cleanup);

it("keeps blank and non-file previews lightweight, then waits for file presentation before showing it", async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
        if (command === "commit_preview_window") return true;
        if (command === "fetch_link_preview_document") return { url: "https://example.com", html: "<p>Synthetic page</p>" };
        if (command === "file_preview_info") return {
            kind: "single-icon", paths: ["demo.txt"], display_path: "demo.txt", extension: "txt", exists: true, preview_path: "",
        };
        return null;
    });
    render(<MotionTestProvider reducedMotion="always"><Preview /></MotionTestProvider>);
    await waitFor(() => expect(tauri.listeners.has("preview-item")).toBe(true));
    expect(fileModule.loads).toBe(0);
    expect(tauri.invoke).not.toHaveBeenCalledWith("file_preview_info", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("resolve_history_media", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("fetch_link_preview_document", expect.anything());

    const emit = (payload: unknown) => act(() => tauri.listeners.get("preview-item")?.({ payload }));
    emit({ request_id: 1, item_type: "Text", content: "Lightweight text" });
    await screen.findByText("Lightweight text");
    emit({ request_id: 2, item_type: "Color", content: "#336699" });
    await screen.findByText("#336699");
    emit({ request_id: 3, item_type: "Image", content: "image.png", preview_asset_path: "image.png" });
    emit({ request_id: 4, item_type: "Link", content: "https://example.com" });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 4 })));
    expect(fileModule.loads).toBe(0);

    emit({ request_id: 5, item_type: "File", content: '["demo.txt"]' });
    await waitFor(() => expect(fileModule.loads).toBe(1));
    expect(tauri.invoke).not.toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 5 }));
    await act(async () => {
        fileModule.allowed = true;
        fileModule.release();
        await fileModule.ready;
    });
    expect(await screen.findByRole("img", { name: "File icon" })).toBeInTheDocument();
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 5 })));
    expect(fileModule.loads).toBe(1);
});
