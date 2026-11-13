import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const native = (name: string) => readFileSync(resolve("src-tauri/native-demo/windows/winui", name), "utf8");

describe("WinUI management surfaces", () => {
    it("shares named compact icon actions and native confirmation dialogs", () => {
        const appearance = native("WinUiAppearance.h");
        expect(appearance.includes("NamedIconButton(")).toBe(true);
        expect(appearance.includes("MakeConfirmationDialog(")).toBe(true);
        for (const file of ["WinUiQueueView.cpp", "WinUiTagManager.cpp"]) {
            const source = native(file);
            expect(source.includes("NamedIconButton(")).toBe(true);
            expect(source.includes("MakeConfirmationDialog(")).toBe(true);
            // Dismissal is verified with real XAML controls in the native regression;
            // it must not depend on a particular local variable's spelling here.
        }
    });

    it("keeps queue commands in a native command bar and uses one row boundary", () => {
        const queue = native("WinUiQueueView.cpp");
        expect(queue.includes("toolbar = CommandBar{}")).toBe(true);
        expect(queue.includes("container.BorderThickness(Thickness{1, 1, 1, 1})")).toBe(true);
        expect(queue.includes("surface.BorderThickness(")).toBe(false);
        expect(queue.includes("ContentDialogResult::Primary")).toBe(true);
    });

    it("lets tag fields stretch and handles keyboard save and cancellation", () => {
        const tags = native("WinUiTagManager.cpp");
        expect(tags.includes("Grid addRow")).toBe(true);
        expect(tags.includes("addName.Width(350)")).toBe(false);
        expect(tags.includes("editName.Width(240)")).toBe(false);
        expect(tags.includes("VirtualKey::Enter")).toBe(true);
        expect(tags.includes("VirtualKey::Escape")).toBe(true);
    });
});
