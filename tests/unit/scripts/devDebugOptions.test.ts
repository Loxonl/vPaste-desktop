import { describe, expect, it } from "vitest";
// @ts-expect-error The launcher is a plain Node ES module.
import { parseDevDebugOptions } from "../../../scripts/dev-debug-options.mjs";

describe("developer main interface selection", () => {
    it("keeps WebView as the default on both supported platforms", () => {
        for (const platform of ["darwin", "win32"]) {
            expect(parseDevDebugOptions([], platform)).toEqual({
                mainUi: "webview", appArgs: ["--dev-mode", "--main-ui=webview"],
            });
        }
    });
    it("forwards native and webview choices in a canonical app argument", () => {
        expect(parseDevDebugOptions(["--main-ui=native"], "darwin").appArgs)
            .toEqual(["--dev-mode", "--main-ui=native"]);
        expect(parseDevDebugOptions(["--main-ui", "native"], "darwin").mainUi).toBe("native");
        expect(parseDevDebugOptions(["--main-ui=webview"], "darwin").mainUi).toBe("webview");
    });
    it("forwards native mode when npm consumes an option before the script separator", () => {
        expect(parseDevDebugOptions([], "darwin", { npm_config_main_ui: "native" }))
            .toEqual({ mainUi: "native", appArgs: ["--dev-mode", "--main-ui=native"] });
        expect(parseDevDebugOptions([], "darwin", { npm_config_main_ui: "webview" }).mainUi)
            .toBe("webview");
    });
    it("lets explicit script arguments override inherited npm options", () => {
        expect(parseDevDebugOptions(["--main-ui=webview"], "darwin", { npm_config_main_ui: "native" }).mainUi)
            .toBe("webview");
        expect(parseDevDebugOptions(["--main-ui=native"], "darwin", { npm_config_main_ui: "webview" }).mainUi)
            .toBe("native");
    });
    it("rejects invalid or unavailable npm choices instead of falling back silently", () => {
        for (const value of ["", "true", "other"]) {
            expect(() => parseDevDebugOptions([], "darwin", { npm_config_main_ui: value })).toThrow();
        }
        expect(() => parseDevDebugOptions([], "win32", { npm_config_main_ui: "native" })).toThrow("macOS DEV");
    });
    it("rejects unavailable native mode and malformed options before launching anything", () => {
        expect(() => parseDevDebugOptions(["--main-ui=native"], "win32")).toThrow("macOS DEV");
        for (const args of [["--main-ui"], ["--main-ui="], ["--main-ui=other"],
            ["--main-ui=native", "--main-ui=webview"], ["--native"]]) {
            expect(() => parseDevDebugOptions(args, "darwin")).toThrow();
        }
    });
});
