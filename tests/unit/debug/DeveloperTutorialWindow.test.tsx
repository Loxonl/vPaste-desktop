import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type TutorialOverlay from "../../../src/clipboard/TutorialOverlay";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), language: vi.fn(), theme: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key, setPreviewLanguageCode: native.language }) }));
vi.mock("../../../src/theme", () => ({ setThemePreview: native.theme }));
vi.mock("../../../src/clipboard/TutorialOverlay", () => ({
    default: (props: ComponentProps<typeof TutorialOverlay>) => <>
        <span>{props.platform} · {props.shortcutText}</span>
        <span>{props.filters.filter(filter => filter.enabled).length} filters</span>
        <button onClick={() => props.onToggleFilter("color", true)}>Enable color</button>
        <button onClick={() => props.onPermissionAction("paste")}>Permission</button>
        <button onClick={props.onComplete}>Finish preview</button>
    </>,
}));
import DeveloperTutorialWindow from "../../../src/debug/DeveloperTutorialWindow";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("previews the reused tutorial without writing onboarding, filter, or appearance preferences", async () => {
    let open: (event: { payload: Record<string, string> }) => void = () => {};
    const unlisten = vi.fn();
    native.listen.mockImplementation(async (_: string, handler: typeof open) => { open = handler; return unlisten; });
    native.invoke.mockResolvedValue({ background: { done: true }, paste: { done: true } });
    const view = render(<DeveloperTutorialWindow />);
    await waitFor(() => expect(native.listen).toHaveBeenCalledWith("dev-tutorial-open", expect.any(Function)));
    act(() => open({ payload: { platform: "mac", shortcut: "Alt+V", languageCode: "Chinese", themePreview: "dark" } }));
    expect(screen.getByText("mac · Option+V")).toBeVisible();
    expect(native.language).toHaveBeenCalledWith("Chinese");
    expect(native.theme).toHaveBeenCalledWith("dark");
    expect(screen.getByText("4 filters")).toBeVisible();
    fireEvent.click(screen.getByText("Enable color"));
    expect(screen.getByText("5 filters")).toBeVisible();
    fireEvent.click(screen.getByText("Permission"));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("open_onboarding_permission_window", {
        permission: "paste", languageCode: "Chinese", themePreview: "dark",
    }));
    act(() => open({ payload: { platform: "windows", shortcut: "Alt+V", languageCode: "English", themePreview: "light" } }));
    expect(screen.getByText("windows · Alt+V")).toBeVisible();
    expect(screen.getByText("4 filters")).toBeVisible();
    fireEvent.click(screen.getByText("Finish preview"));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("close_dev_tutorial_window"));
    for (const command of ["begin_onboarding", "complete_onboarding", "save_custom_tabs", "set_config"]) {
        expect(native.invoke.mock.calls.map(([name]) => name)).not.toContain(command);
    }
    view.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
});
