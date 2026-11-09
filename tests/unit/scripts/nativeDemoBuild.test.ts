import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src-tauri", "build.rs"), "utf8");
const gate = source.slice(source.indexOf("fn build_native_demo()"), source.indexOf("fn build_swift_native_demo()"));

describe("native demo build gating", () => {
    it("uses the Cargo profile available to the supported toolchain", () => {
        expect(gate).toContain('env::var("PROFILE")');
        expect(gate).not.toContain("CARGO_CFG_DEBUG_ASSERTIONS");
    });

    it("returns before either native compiler for non-Debug profiles", () => {
        expect(gate).toMatch(/if env::var\("PROFILE"\)\.as_deref\(\) != Ok\("debug"\)\s*\{\s*return;/);
        expect(gate.indexOf("return;")).toBeLessThan(gate.indexOf('env::var("CARGO_CFG_TARGET_OS")'));
    });

    it("retains the Windows and macOS compiler paths behind the same gate", () => {
        expect(gate).toContain('Ok("windows") => build_win32_native_demo()');
        expect(gate).toContain('Ok("macos") => build_swift_native_demo()');
        expect(source).toContain('build.compile("VPasteNativeDemo")');
    });
});
