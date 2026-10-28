import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), language: vi.fn(), theme: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key, setPreviewLanguageCode: native.language }) }));
vi.mock("../../../src/theme", () => ({ setThemePreview: native.theme }));
import DeveloperMemoryWindow from "../../../src/debug/DeveloperMemoryWindow";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps its own window on blur, applies DEV preview and closes through native destruction", async () => {
    let preview: (event: { payload: { languageCode: string; themePreview: string } }) => void = () => {};
    native.listen.mockImplementation(async (_: string, handler: typeof preview) => { preview = handler; return () => {}; });
    native.invoke.mockResolvedValue({ running: true, platform: "macos", accountedMetric: "physicalFootprint", samples: [] });
    render(<DeveloperMemoryWindow />);
    expect(screen.getByText("memory.ownWindow")).toBeVisible();
    await waitFor(() => expect(native.listen).toHaveBeenCalledWith("dev-memory-open", expect.any(Function)));
    preview({ payload: { languageCode: "Chinese", themePreview: "dark" } });
    expect(native.language).toHaveBeenCalledWith("Chinese");
    expect(native.theme).toHaveBeenCalledWith("dark");
    fireEvent(window, new Event("blur"));
    expect(native.invoke).not.toHaveBeenCalledWith("close_dev_memory_window");
    fireEvent.click(screen.getByRole("button", { name: "memory.close" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("close_dev_memory_window"));
    expect(native.invoke).not.toHaveBeenCalledWith("set_dev_memory_monitoring", { enabled: false });
});
