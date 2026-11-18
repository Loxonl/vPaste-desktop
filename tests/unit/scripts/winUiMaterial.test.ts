import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nativeFile = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");

describe("WinUI window material ownership", () => {
    it("uses one system Acrylic backdrop on the existing XAML host", () => {
        const panel = nativeFile("WinUiPanel.cpp");
        expect(panel.includes("DesktopAcrylicController::IsSupported()")).toBe(true);
        expect(panel.includes("g_panel.xamlSource.SystemBackdrop(DesktopAcrylicBackdrop{});")).toBe(true);
    });

    it("shares the window canvas across history, queue and tag views", () => {
        for (const file of ["WinUiPanel.cpp", "WinUiQueueView.cpp", "WinUiTagManager.cpp"]) {
            expect(nativeFile(file).includes("WindowCanvasBackground()")).toBe(true);
        }
    });

    it("keeps an explicit opaque fallback and the native caption in the app theme", () => {
        const panel = nativeFile("WinUiPanel.cpp");
        expect(panel.includes("g_panel.windowCanvas.Color(")).toBe(true);
        expect(panel.includes("DWMWA_USE_IMMERSIVE_DARK_MODE")).toBe(true);
        expect(panel.includes("ConfigureAcrylicBackdrop(false)")).toBe(true);
    });

    it("tracks the shared appearance header in both native and Cargo builds", () => {
        const project = nativeFile("WinUiPanel.vcxproj");
        const build = readFileSync(resolve("src-tauri/build.rs"), "utf8");
        expect(project.includes('ClInclude Include="WinUiAppearance.h"')).toBe(true);
        expect(build.includes('"native-demo/windows/winui/WinUiAppearance.h"')).toBe(true);
    });

    it("detaches the backdrop before destroying its native host", () => {
        const panel = nativeFile("WinUiPanel.cpp");
        const stop = panel.slice(panel.indexOf("case kStopWindow:"), panel.indexOf("case kPanelResponse:"));
        const detach = stop.indexOf("g_panel.xamlSource.SystemBackdrop(nullptr)");
        expect(detach).toBeGreaterThanOrEqual(0);
        expect(detach).toBeLessThan(stop.indexOf("DestroyWindow(window)"));
        const cleanup = panel.slice(panel.indexOf("// Release UI objects on their STA"), panel.indexOf("g_panel.search = nullptr"));
        expect(cleanup.includes(".SystemBackdrop(")).toBe(false);
    });
});
