import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ItemType } from "../../../src/clipboard/Item";
import { PreviewBody } from "../../../src/clipboard/Preview";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path, invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

beforeEach(() => {
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
});
