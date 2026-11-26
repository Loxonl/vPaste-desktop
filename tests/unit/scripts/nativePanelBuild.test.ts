import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src-tauri/build.rs"), "utf8");
const main = readFileSync(join(process.cwd(), "src-tauri/src/main.rs"), "utf8");
const gate = source.slice(source.indexOf("fn build_swift_macos()"), source.indexOf("fn build_winui_panel()"));

describe("macOS Swift build", () => {
    it("compiles the production tray and native panel on every macOS profile", () => {
        expect(gate).toContain('env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")');
        const debugGate = gate.indexOf('if env::var("PROFILE").as_deref() == Ok("debug") {');
        expect(debugGate).toBeGreaterThan(gate.indexOf("return;"));
        expect(gate.slice(0, debugGate)).toContain('vec!["native-panel/MacOSTrayMenu.swift"]');
        expect(gate.slice(0, debugGate)).toContain("generate_onboarding_art();");
        expect(gate.slice(0, debugGate)).toContain("sources.extend_from_slice(PANEL_SOURCES);");
        expect(gate.slice(debugGate, gate.indexOf("    }", debugGate))).toContain("VPASTE_NATIVE_DEBUG");
        expect(gate.indexOf("return;")).toBeLessThan(gate.indexOf('Command::new("xcrun")'));
        expect(gate).toContain(".args(sources)");
        expect(main).toContain('#[cfg(target_os = "macos")]\nmod native_panel;');
    });
    it("imports its own bridge and links every real panel source", () => {
        expect(gate).toContain('"native-panel/NativePanelBridge.h"');
        expect(gate).toContain('"native-panel/NativePanelDeveloperToolbar.swift"');
        expect(gate).toContain('"native-panel/NativePanelOnboarding.swift"');
        expect(gate).toContain('"native-panel/NativePanelController.swift"');
        expect(gate).toContain('"cargo:rustc-link-lib=static=VPasteNative"');
        expect(source).not.toContain("NativeDemo");
    });
    it("routes the macOS status item to the Swift bridge and excludes its WebView opener", () => {
        expect(main).toContain(".on_tray_icon_event(macos_tray::handle_event)");
        expect(main).toContain('#[cfg(not(target_os = "macos"))]\nasync fn show_vpaste_tray_menu(');
    });
});

it("presents the Swift tray as the status item's system pull-down", () => {
    const swift = readFileSync(join(process.cwd(), "src-tauri/native-panel/MacOSTrayMenu.swift"), "utf8");
    const attach = swift.indexOf("item.menu = menu");
    expect(attach).toBeGreaterThanOrEqual(0);
    const tracking = swift.slice(attach);
    expect(tracking).toMatch(/defer \{ item\.menu = nil \}\s*button\.performClick\(nil\)\s*return selection\.action/);
    expect(swift).not.toContain("menu.popUp(");
});
