import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src-tauri/build.rs"), "utf8");
const gate = source.slice(source.indexOf("fn build_swift_native_panel()"), source.indexOf("fn build_winui_panel()"));

describe("standalone mac native panel build", () => {
    it("gates the retained Swift panel to macOS Debug profiles", () => {
        expect(gate).toContain('env::var("PROFILE").as_deref() != Ok("debug")');
        expect(gate).toContain('env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")');
        expect(gate.indexOf("return;")).toBeLessThan(gate.indexOf('Command::new("xcrun")'));
    });
    it("imports its own bridge and links every real panel source", () => {
        expect(gate).toContain('"native-panel/NativePanelBridge.h"');
        expect(gate).toContain('"native-panel/NativePanelDeveloperToolbar.swift"');
        expect(gate).toContain('"native-panel/NativePanelController.swift"');
        expect(gate).toContain('"cargo:rustc-link-lib=static=VPasteNativePanel"');
        expect(source).not.toContain("NativeDemo");
    });
    it("preserves upstream native onboarding sources and generates their assets after the platform gate", () => {
        const generator = source.indexOf("fn generate_onboarding_art()");
        expect(generator).toBeGreaterThan(-1);
        expect(generator).toBeLessThan(source.indexOf("fn build_swift_native_panel()"));
        expect(gate).toContain('"native-panel/NativePanelOnboarding.swift"');
        expect(gate.indexOf("return;")).toBeLessThan(gate.indexOf("generate_onboarding_art();"));
    });
});
