import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src-tauri/src/browser_preview_keys.js"), "utf8");

function harness() {
    let handler: (event: object) => void;
    class Element {
        isContentEditable = false;
        constructor(public tag = "div") {}
        matches() { return ["input", "textarea", "select"].includes(this.tag); }
    }
    const target = { location: { href: "" } };
    vm.runInNewContext(source.replace("__TOKEN__", "fixture-token"), {
        Element, window: { top: target, addEventListener: (_: string, callback: typeof handler) => { handler = callback; } },
    });
    return {
        send(key: string, changes = {}, editing = false) {
            let prevented = false;
            target.location.href = "";
            handler({ isTrusted: true, isComposing: false, altKey: false, metaKey: false,
                ctrlKey: false, shiftKey: false, repeat: false, key,
                composedPath: () => [new Element(editing ? "input" : "div")],
                preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {}, ...changes });
            return { url: target.location.href, prevented };
        },
    };
}

describe("native webpage keyboard signal", () => {
    it("forwards genuine navigation and close keys without exposing app IPC", () => {
        const keys = harness();
        for (const key of ["Escape", " ", "ArrowRight", "ArrowLeft", "Tab"]) {
            expect(keys.send(key)).toEqual({ url: `https://keyboard.vpaste.invalid/fixture-token/${key === " " ? "Space" : key}/0/0`, prevented: true });
        }
        expect(keys.send("Tab", { ctrlKey: true, shiftKey: true }).url).toContain("/Tab/1/1");
        expect(source).not.toContain("__TAURI");
        expect(source).not.toContain("invoke(");
    });

    it("ignores synthetic/composing events, ordinary typing and reserved browser modifiers", () => {
        const keys = harness();
        for (const change of [{ isTrusted: false }, { isComposing: true }, { altKey: true }, { metaKey: true }]) {
            expect(keys.send("ArrowLeft", change)).toEqual({ url: "", prevented: false });
        }
        expect(keys.send("Enter")).toEqual({ url: "", prevented: false });
    });

    it("keeps webpage inputs editable and avoids closing on a held Space key", () => {
        const keys = harness();
        for (const key of [" ", "ArrowLeft", "ArrowRight", "Tab"]) {
            expect(keys.send(key, {}, true)).toEqual({ url: "", prevented: false });
        }
        expect(keys.send("Escape", {}, true).url).toContain("/Escape/");
        expect(keys.send(" ", { repeat: true })).toEqual({ url: "", prevented: true });
        expect(keys.send("Escape", { repeat: true })).toEqual({ url: "", prevented: true });
    });
});
