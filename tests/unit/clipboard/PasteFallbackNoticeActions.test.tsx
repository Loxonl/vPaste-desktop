import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { invoke, opened } = vi.hoisted(() => ({ invoke: vi.fn(), opened: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
import PasteFallbackNotice from "../../../src/clipboard/PasteFallbackNotice";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("opens permission settings before destroying the notice's IPC context", async () => {
    let destroyed = false;
    invoke.mockImplementation(async (command: string) => {
        if (destroyed) throw new Error("caller webview was destroyed");
        if (command === "hide_paste_fallback_notice") destroyed = true;
        if (command === "open_config_window") opened();
    });
    render(<PasteFallbackNotice />);
    fireEvent.click(screen.getByRole("button", { name: "common.settings" }));
    await waitFor(() => expect(opened).toHaveBeenCalledOnce());
    await waitFor(() => expect(destroyed).toBe(true));
    expect(invoke).toHaveBeenCalledWith("open_config_window", { target: "permissions" });
});
