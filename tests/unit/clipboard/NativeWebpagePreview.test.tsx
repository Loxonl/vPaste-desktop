import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
import { PreviewBody } from "../../../src/clipboard/Preview";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path, invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn(), listen: tauri.listen }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

beforeEach(() => {
    cleanup();
    tauri.invoke.mockReset();
    tauri.listen.mockReset().mockResolvedValue(() => {});
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    tauri.invoke.mockImplementation(async (command: string) => command === "fetch_link_preview_document"
        ? { url: "https://example.com/page", html: "<p>Old HTML snapshot</p>" }
        : true);
});

describe("native webpage preview", () => {
    it("loads the original URL in a native browser without fetching or rewriting HTML", async () => {
        const { container } = render(<PreviewBody payload={{ request_id: 17, item_type: ItemType.Link, content: "https://example.com/page|||cached-icon" }} t={key => key} />);
        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("sync_preview_browser", expect.objectContaining({
            requestId: 17, url: "https://example.com/page",
        })));
        expect(tauri.invoke.mock.calls.some(([command]) => command === "fetch_link_preview_document")).toBe(false);
        expect(container.querySelector("iframe")).toBeNull();
    });

    it("does not start a page for pending or outgoing layers, and parks only its own request", async () => {
        const payload = { request_id: 21, item_type: ItemType.Link, content: "https://example.com/page" };
        const { rerender, unmount } = render(<PreviewBody payload={payload} active={false} t={key => key} />);
        expect(tauri.invoke).not.toHaveBeenCalled();
        rerender(<PreviewBody payload={payload} active t={key => key} />);
        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("sync_preview_browser", expect.objectContaining({ requestId: 21 })));
        unmount();
        expect(tauri.invoke).toHaveBeenCalledWith("hide_preview_browser", { requestId: 21 });
    });

    it("shows the actual navigation URL only for the active request", async () => {
        const { getByText, queryByText } = render(<PreviewBody payload={{ request_id: 31, item_type: ItemType.Link, content: "https://example.com/page" }} t={key => key} />);
        const callback = tauri.listen.mock.calls.find(([name]) => name === "preview-browser-location")![1];
        act(() => callback({ payload: { requestId: 30, url: "https://stale.example/" } }));
        expect(queryByText("https://stale.example/")).toBeNull();
        act(() => callback({ payload: { requestId: 31, url: "https://redirect.example/" } }));
        expect(getByText("https://redirect.example/")).toBeInTheDocument();
    });

    it("serializes resizing while native creation is in flight", async () => {
        let finish!: (ready: boolean) => void;
        tauri.invoke.mockImplementation(command => command === "sync_preview_browser"
            ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
        const { unmount } = render(<PreviewBody payload={{ request_id: 41, item_type: ItemType.Link, content: "https://example.com/page" }} t={key => key} />);
        fireEvent(window, new Event("resize"));
        expect(tauri.invoke.mock.calls.filter(([command]) => command === "sync_preview_browser")).toHaveLength(1);
        await act(async () => finish(true));
        await waitFor(() => expect(tauri.invoke.mock.calls.filter(([command]) => command === "sync_preview_browser")).toHaveLength(2));
        unmount();
        await act(async () => finish(true));
    });
});
