import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Preview from "../../../src/clipboard/Preview";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";
import { motionDurationsMs, motionTokens } from "../../../src/ui/motion";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen, emitTo: tauri.emitTo }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));

let listeners: Map<string, (event: { payload: unknown }) => void>;
const emit = (name: string, payload?: unknown) => act(() => listeners.get(name)?.({ payload }));
const text = (id: number, content: string, direction = 0) => ({
    request_id: id, item_type: "Text", content, navigation_direction: direction,
});

beforeEach(() => {
    listeners = new Map();
    tauri.listen.mockReset().mockImplementation(async (name, callback) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
    });
    tauri.emitTo.mockReset().mockResolvedValue(undefined);
    tauri.invoke.mockReset().mockImplementation(async (command: string) => {
        if (command === "commit_preview_window") return true;
        if (command === "history_image_metadata") return { isGif: false, width: 320, height: 200 };
        return undefined;
    });
});
afterEach(cleanup);

describe("continuous preview session", () => {
    it("does not close on repeated Space but closes on the next physical press", () => {
        render(<MotionTestProvider><Preview /></MotionTestProvider>);
        fireEvent.keyDown(window, { key: " ", repeat: true });
        expect(tauri.invoke).not.toHaveBeenCalledWith("hide_preview_window");
        fireEvent.keyDown(window, { key: " " });
        expect(tauri.invoke).toHaveBeenCalledWith("hide_preview_window");
    });

    it("passes the authoritative navigation direction and shared geometry timing to the native commit", async () => {
        render(<MotionTestProvider reducedMotion="always"><Preview /></MotionTestProvider>);
        emit("preview-item", text(1, "First"));
        await waitFor(() => expect(screen.getByText("First").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        emit("preview-item", text(2, "Next", 1));
        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("commit_preview_window", {
            requestId: 2, reducedMotion: true, durationMs: motionDurationsMs.standard, easing: motionTokens.easing.enter,
        }));
        expect(screen.getByText("Next").closest("[data-preview-direction]"))
            .toHaveAttribute("data-preview-direction", "forward");
        expect(screen.getByText("Next").closest("[data-preview-phase]"))
            .not.toHaveAttribute("inert");
    });

    it("reuses an unchanged viewer and requests native animation only in normal motion mode", async () => {
        render(<MotionTestProvider><Preview /></MotionTestProvider>);
        emit("preview-item", text(1, "Same content"));
        await waitFor(() => expect(screen.getByText("Same content").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        const viewer = screen.getByText("Same content");
        emit("preview-item", text(2, "Same content"));
        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({
            requestId: 2, reducedMotion: false,
        })));
        expect(screen.getByText("Same content")).toBe(viewer);
        expect(document.querySelectorAll("[data-preview-phase]")).toHaveLength(1);
    });

    it("retains the outgoing layer until its own exit animation completes", async () => {
        render(<MotionTestProvider><Preview /></MotionTestProvider>);
        emit("preview-item", text(1, "Outgoing"));
        await waitFor(() => expect(screen.getByText("Outgoing").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        emit("preview-item", text(2, "Incoming"));
        await waitFor(() => expect(screen.getByText("Incoming").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        expect(screen.getByText("Outgoing").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "exiting");
        await waitFor(() => expect(screen.queryByText("Outgoing")).not.toBeInTheDocument());
    });

    it("keeps the current viewer when a native commit is rejected", async () => {
        render(<MotionTestProvider><Preview /></MotionTestProvider>);
        emit("preview-item", text(1, "Pinned content"));
        await waitFor(() => expect(screen.getByText("Pinned content").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        tauri.invoke.mockImplementation(async (command: string) => command === "commit_preview_window" ? false : undefined);
        emit("preview-item", text(2, "Rejected content"));
        await waitFor(() => expect(screen.queryByText("Rejected content")).not.toBeInTheDocument());
        expect(screen.getByText("Pinned content").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current");
    });

    it("keeps the current content until the next image loads and discards a superseded image", async () => {
        const { container } = render(<MotionTestProvider><Preview /></MotionTestProvider>);
        emit("preview-item", text(1, "Existing content"));
        await waitFor(() => expect(screen.getByText("Existing content").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        emit("preview-item", { request_id: 2, item_type: "Image", content: "slow.png", preview_asset_path: "slow.png" });
        await waitFor(() => expect(container.querySelector('img[src="asset://slow.png"]')).not.toBeNull());
        const slowImage = container.querySelector('img[src="asset://slow.png"]')!;
        expect(screen.getByText("Existing content").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current");
        expect(tauri.invoke).not.toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 2 }));
        emit("preview-item", text(3, "Latest content"));
        await waitFor(() => expect(screen.getByText("Latest content").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        fireEvent.load(slowImage);
        expect(tauri.invoke).not.toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 2 }));
        expect(container.querySelectorAll("[data-preview-phase]").length).toBeLessThanOrEqual(2);
    });

    it("commits a prepared image only after its load event", async () => {
        const { container } = render(<MotionTestProvider><Preview /></MotionTestProvider>);
        emit("preview-item", { request_id: 1, item_type: "Image", content: "ready.png", preview_asset_path: "ready.png" });
        await waitFor(() => expect(container.querySelector('img[src="asset://ready.png"]')).not.toBeNull());
        expect(tauri.invoke).not.toHaveBeenCalledWith("commit_preview_window", expect.anything());
        fireEvent.load(container.querySelector("img")!);
        await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 1 })));
    });

    it("cancels pending content when the preview closes and ignores older native requests", async () => {
        const { container } = render(<MotionTestProvider><Preview /></MotionTestProvider>);
        emit("preview-item", text(5, "Newest"));
        await waitFor(() => expect(screen.getByText("Newest").closest("[data-preview-phase]"))
            .toHaveAttribute("data-preview-phase", "current"));
        emit("preview-item", text(4, "Obsolete"));
        expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
        emit("preview-item", { request_id: 6, item_type: "Image", content: "closed.png", preview_asset_path: "closed.png" });
        await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
        const image = container.querySelector("img")!;
        emit("preview-clear");
        fireEvent.load(image);
        expect(tauri.invoke).not.toHaveBeenCalledWith("commit_preview_window", expect.objectContaining({ requestId: 6 }));
        expect(screen.queryByText("Newest")).not.toBeInTheDocument();
    });
});
