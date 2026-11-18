import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NativeOnboardingWindow from "../../../src/clipboard/NativeOnboardingWindow";
import type { TutorialFilterTab } from "../../../src/clipboard/clipboardTutorial";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), emit: vi.fn(), ready: vi.fn(), theme: vi.fn(), shown: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: bridge.emit, listen: vi.fn(async (_: string, callback: () => void) => {
    bridge.shown.add(callback);
    return () => bridge.shown.delete(callback);
}) }));
vi.mock("../../../src/auxiliaryWindowReady", () => ({ notifyAuxiliaryWindowReady: bridge.ready }));
vi.mock("../../../src/theme", () => ({ loadAndApplyTheme: bridge.theme }));
vi.mock("../../../src/lang", () => ({
    useLanguage: () => ({ t: (key: string) => key, setLanguageCode: () => undefined }),
    getLanguagePack: () => ({}), translateWithPack: (_: unknown, key: string) => key,
}));
vi.mock("../../../src/clipboard/TutorialOverlay", () => ({
    default: (props: { filters: TutorialFilterTab[]; onToggleFilter: (id: string, enabled: boolean) => void;
        onComplete: () => void; onShortcutDemoAvailabilityChange: (enabled: boolean) => void }) => (
        <div>
            <output>{props.filters.filter(filter => filter.enabled).map(filter => filter.id).join(",")}</output>
            <button onClick={() => props.onToggleFilter("text", false)}>Disable text</button>
            <button onClick={() => props.onShortcutDemoAvailabilityChange(true)}>Practice</button>
            <button onClick={props.onComplete}>Finish</button>
        </div>
    ),
}));

describe("native-session first-run guide", () => {
    afterEach(cleanup);
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        bridge.shown.clear();
        bridge.ready.mockReturnValue(() => undefined);
        bridge.theme.mockResolvedValue(undefined);
        bridge.emit.mockResolvedValue(undefined);
        bridge.invoke.mockImplementation(async (command: string) => {
            if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: false });
            if (command === "get_custom_tabs") return [];
            return undefined;
        });
    });

    async function showGuide() {
        await waitFor(() => expect(bridge.ready).toHaveBeenCalled());
        await act(async () => { bridge.shown.forEach(callback => callback()); });
    }

    it("does not start the shipping tutorial before the native host is shown", async () => {
        render(<NativeOnboardingWindow />);
        await waitFor(() => expect(bridge.ready).toHaveBeenCalled());
        expect(screen.queryByText("Finish")).not.toBeInTheDocument();
        await showGuide();
        expect(await screen.findByText("Finish")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Disable text"));
        await screen.findByText("image,link,file");
        await showGuide();
        expect(screen.getByText("image,link,file")).toBeInTheDocument();
    });

    it("uses the existing first-run defaults and persists changes before completion", async () => {
        render(<NativeOnboardingWindow />);
        await showGuide();
        await screen.findByText("text,image,link,file");
        fireEvent.click(screen.getByText("Disable text"));
        await screen.findByText("image,link,file");
        fireEvent.click(screen.getByText("Practice"));
        expect(bridge.invoke).toHaveBeenCalledWith("set_onboarding_shortcut_demo_enabled", { enabled: true });
        fireEvent.click(screen.getByText("Finish"));
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("complete_onboarding"));
        const writes = bridge.invoke.mock.calls.filter(call => call[0] === "save_custom_tabs");
        expect(writes.at(-1)?.[1].tabs.map((tab: { id: string }) => tab.id)).toEqual([
            "tutorial-filter-image", "tutorial-filter-link", "tutorial-filter-file",
        ]);
        expect(bridge.ready).toHaveBeenCalled();
    });

    it("does not complete ahead of an outstanding save or after a failed save", async () => {
        render(<NativeOnboardingWindow />);
        await showGuide();
        await screen.findByText("text,image,link,file");
        let rejectWrite: (reason: Error) => void = () => undefined;
        bridge.invoke.mockImplementation(async (command: string) => {
            if (command === "save_custom_tabs") return new Promise((_, reject) => { rejectWrite = reject; });
            return undefined;
        });
        fireEvent.click(screen.getByText("Disable text"));
        const finish = screen.getByText("Finish");
        fireEvent.click(finish);
        fireEvent.click(finish);
        expect(bridge.invoke).not.toHaveBeenCalledWith("complete_onboarding");
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("save_custom_tabs", expect.anything()));
        await act(async () => rejectWrite(new Error("disk full")));
        expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
        expect(bridge.invoke).not.toHaveBeenCalledWith("complete_onboarding");
        expect(screen.getByText("text,image,link,file")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Finish"));
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("complete_onboarding"));
    });

    it("notifies the native tab strip only after the filter choice is saved", async () => {
        render(<NativeOnboardingWindow />);
        await showGuide();
        await screen.findByText("text,image,link,file");
        bridge.emit.mockClear();
        let save: () => void = () => undefined;
        bridge.invoke.mockImplementation(async (command: string) => {
            if (command === "save_custom_tabs") return new Promise<void>(resolve => { save = resolve; });
            return undefined;
        });
        fireEvent.click(screen.getByText("Disable text"));
        expect(screen.getByText("image,link,file")).toBeInTheDocument();
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("save_custom_tabs", expect.anything()));
        expect(bridge.emit).not.toHaveBeenCalled();
        await act(async () => save());
        await waitFor(() => expect(bridge.emit).toHaveBeenCalledWith("custom-tabs-changed", expect.objectContaining({
            tabs: expect.arrayContaining([expect.objectContaining({ id: "tutorial-filter-image" })]),
        })));
        expect(bridge.emit.mock.calls.at(-1)?.[1].tabs.some((tab: { id: string }) => tab.id === "tutorial-filter-text")).toBe(false);
    });

    it("retries a failed initial save without losing the first-run defaults", async () => {
        let failSave = true;
        bridge.invoke.mockImplementation(async (command: string) => {
            if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: false });
            if (command === "get_custom_tabs") return [];
            if (command === "save_custom_tabs" && failSave) throw new Error("storage unavailable");
            return undefined;
        });
        render(<NativeOnboardingWindow />);
        expect(await screen.findByRole("alert")).toHaveTextContent("storage unavailable");
        expect(bridge.invoke).not.toHaveBeenCalledWith("begin_onboarding");
        failSave = false;
        fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("begin_onboarding"));
        await showGuide();
        await screen.findByText("text,image,link,file");
        expect(bridge.invoke.mock.calls.filter(call => call[0] === "save_custom_tabs")).toHaveLength(2);
        expect(bridge.invoke).toHaveBeenCalledWith("begin_onboarding");
    });

    it("replaying the guide respects existing tabs and never reseeds them", async () => {
        bridge.invoke.mockImplementation(async (command: string) => {
            if (command === "get_config") return JSON.stringify({ multilingual: "English", onboarding_completed: true });
            if (command === "get_custom_tabs") return [];
            return undefined;
        });
        render(<NativeOnboardingWindow />);
        await showGuide();
        await screen.findByText("Finish");
        expect(document.querySelector("output")).toHaveTextContent("");
        expect(bridge.invoke).not.toHaveBeenCalledWith("save_custom_tabs", expect.anything());
    });

    it("hides the final illustration before native completion can hide and detach its owner", async () => {
        let complete!: () => void;
        const original = bridge.invoke.getMockImplementation()!;
        bridge.invoke.mockImplementation((command: string, ...args: unknown[]) => command === "complete_onboarding"
            ? new Promise<void>(resolve => { complete = resolve; })
            : original(command, ...args));
        render(<NativeOnboardingWindow />);
        await showGuide();
        fireEvent.click(await screen.findByText("Finish"));
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("complete_onboarding"));
        expect(screen.queryByRole("button", { name: "Finish" })).not.toBeInTheDocument();
        // A delayed shown notification must not remount the illustration.
        await showGuide();
        expect(screen.queryByRole("button", { name: "Finish" })).not.toBeInTheDocument();
        await act(async () => complete());
    });

    it("restores the guide after completion fails so the user can retry", async () => {
        const original = bridge.invoke.getMockImplementation()!;
        bridge.invoke.mockImplementation((command: string, ...args: unknown[]) => command === "complete_onboarding"
            ? Promise.reject(new Error("completion failed")) : original(command, ...args));
        render(<NativeOnboardingWindow />);
        await showGuide();
        fireEvent.click(await screen.findByText("Finish"));
        expect(await screen.findByRole("alert")).toHaveTextContent("completion failed");
        expect(screen.getByText("Finish")).toBeInTheDocument();
    });
});
