import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAME_PREFIX_EMOJIS, applyNameEmoji, selectedNameEmoji } from "../../../src/clipboard/nameEmoji";

describe("shared native name emoji catalog", () => {
    it("retains the shipping catalog and prefix semantics", () => {
        const catalog: string[] = JSON.parse(readFileSync("src/clipboard/name-prefix-emojis.json", "utf8"));
        expect(catalog).toEqual(NAME_PREFIX_EMOJIS);
        expect(catalog).toHaveLength(112);
        expect(new Set(catalog).size).toBe(catalog.length);
        expect(selectedNameEmoji("1️⃣   Work")).toBe("1️⃣");
        expect(applyNameEmoji("🖼️   Work", "📌")).toBe("📌 Work");
        expect(applyNameEmoji("1️⃣ Work", "")).toBe("Work");
        expect(applyNameEmoji("👩‍💻 Notes", "📌")).toBe("📌 👩‍💻 Notes");
        expect(applyNameEmoji("🖼️\u3000\uFEFF Work", "")).toBe("Work");
    });
    it("embeds the same catalog and reuses the picker in both native editors", () => {
        const directory = "src-tauri/native-demo/windows/winui/";
        expect(readFileSync(`${directory}WinUiNameEmoji.rc`, "utf8"))
            .toContain("src/clipboard/name-prefix-emojis.json");
        expect(readFileSync(`${directory}WinUiPanel.vcxproj`, "utf8"))
            .toContain('ResourceCompile Include="WinUiNameEmoji.rc"');
        for (const editor of ["WinUiTagManager.cpp", "WinUiFilterEditor.cpp"])
            expect(readFileSync(`${directory}${editor}`, "utf8")).toContain("NameEmojiButton(");
        const picker = readFileSync(`${directory}WinUiNameEmoji.cpp`, "utf8");
        expect(picker).toContain("FlyoutPlacementMode::TopEdgeAlignedLeft");
        for (const forbidden of ["WebView", "SetCursor(", "SendInput(", "SetWindowPos("])
            expect(picker).not.toContain(forbidden);
    });
});
