import { describe, expect, it } from "vitest";
import { clipboardKeyDownAction } from "../../../src/clipboard/clipboardKeyboard";

function keyDown(
    key: string,
    init: KeyboardEventInit = {},
    target?: EventTarget,
): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, ...init });
    if (target) {
        Object.defineProperty(event, "target", { value: target });
    }
    return event;
}

function context(overrides: Partial<Parameters<typeof clipboardKeyDownAction>[1]> = {}) {
    return {
        contextMenuOpen: false,
        isMac: false,
        pasteAsTextShortcut: "Shift+Enter",
        quickInputEnabled: true,
        searchHasText: false,
        searchComposing: false,
        searchInput: null,
        searchOpen: false,
        tabQuickSelectEnabled: true,
        ...overrides,
    };
}

describe("clipboardKeyDownAction", () => {
    it("opens editing only for an unmodified, non-repeated F2 outside inputs and dialogs", () => {
        expect(clipboardKeyDownAction(keyDown("F2"), context())).toEqual({ type: "edit-selected" });
        for (const init of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }]) {
            expect(clipboardKeyDownAction(keyDown("F2", init), context())).toBeNull();
        }
        expect(clipboardKeyDownAction(keyDown("F2"), context({ contextMenuOpen: true }))).toBeNull();
        expect(clipboardKeyDownAction(keyDown("F2", { repeat: true }), context({ pasteAsTextShortcut: "F2" }))).toBeNull();
        for (const target of [document.createElement("input"), document.createElement("textarea")]) {
            expect(clipboardKeyDownAction(keyDown("F2", {}, target), context())).toBeNull();
        }
        const rich = document.createElement("div");
        rich.contentEditable = "true";
        Object.defineProperty(rich, "isContentEditable", { value: true });
        expect(clipboardKeyDownAction(keyDown("F2", {}, rich), context())).toBeNull();
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        expect(clipboardKeyDownAction(keyDown("F2", {}, dialog), context())).toBeNull();
    });
    it.each([false, true])("uses only the fixed platform delete key (mac=%s)", isMac => {
        expect(clipboardKeyDownAction(keyDown(isMac ? "Backspace" : "Delete"), context({ isMac })))
            .toEqual({ type: "delete-selected" });
        expect(clipboardKeyDownAction(keyDown(isMac ? "Delete" : "Backspace"), context({ isMac })))
            .toBeNull();
        for (const init of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }, { isComposing: true }]) {
            expect(clipboardKeyDownAction(keyDown(isMac ? "Backspace" : "Delete", init), context({ isMac })))
                .toBeNull();
        }
        expect(clipboardKeyDownAction(keyDown(isMac ? "Backspace" : "Delete"), context({ isMac, searchComposing: true })))
            .toBeNull();
    });

    it.each([false, true])("leaves deletion to text inputs, dialogs and menus (mac=%s)", isMac => {
        const key = isMac ? "Backspace" : "Delete";
        const editor = document.createElement("div");
        Object.defineProperty(editor, "isContentEditable", { value: true });
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        const dialogButton = document.createElement("button");
        dialog.append(dialogButton);
        const toolbarButton = document.createElement("button");
        toolbarButton.dataset.keyboardPassthrough = "true";
        for (const target of [document.createElement("input"), document.createElement("textarea"), document.createElement("select"), editor, dialogButton, toolbarButton]) {
            expect(clipboardKeyDownAction(keyDown(key, {}, target), context({ isMac }))).toBeNull();
        }
        expect(clipboardKeyDownAction(keyDown(key), context({ isMac, contextMenuOpen: true }))).toBeNull();
    });

    it.each([false, true])("ignores held quick-item repeats (mac=%s)", isMac => {
        const searchInput = document.createElement("input");
        for (const target of [undefined, searchInput]) {
            const settings = context({ isMac, searchInput });
            const init = { altKey: true, code: "Digit1" };
            expect(clipboardKeyDownAction(keyDown("1", init, target), settings))
                .toEqual({ type: "quick-item", index: 0 });
            expect(clipboardKeyDownAction(keyDown("1", { ...init, repeat: true }, target), settings))
                .toBeNull();
            expect(clipboardKeyDownAction(keyDown("1", init, target), settings))
                .toEqual({ type: "quick-item", index: 0 });
        }
    });

    it("preserves repeated selection and context-menu navigation", () => {
        for (const key of ["ArrowRight", "Tab"]) {
            expect(clipboardKeyDownAction(keyDown(key, { repeat: true }), context()))
                .toEqual({ type: "navigate-selection", direction: 1 });
        }
        expect(clipboardKeyDownAction(
            keyDown("ArrowDown", { repeat: true }), context({ contextMenuOpen: true }),
        )).toEqual({ type: "move-context-menu-selection", direction: 1 });
    });

    it("always handles Alt while only showing hints when quick input is enabled", () => {
        expect(clipboardKeyDownAction(keyDown("Alt"), context()))
            .toEqual({ type: "alt-press", showHints: true, stopPropagation: true });
        expect(clipboardKeyDownAction(
            keyDown("Alt"),
            context({ quickInputEnabled: false }),
        )).toEqual({ type: "alt-press", showHints: false, stopPropagation: true });
    });

    it("allows quick input in search but ignores other text-entry targets", () => {
        const searchInput = document.createElement("input");
        const otherInput = document.createElement("input");

        expect(clipboardKeyDownAction(
            keyDown("1", { altKey: true, code: "Digit1" }, searchInput),
            context({ searchInput }),
        )).toEqual({ type: "quick-item", index: 0 });
        expect(clipboardKeyDownAction(
            keyDown("1", { altKey: true, code: "Digit1" }, otherInput),
            context({ searchInput }),
        )).toBeNull();
    });

    it("maps search focus, submit, clear, and close actions", () => {
        const searchInput = document.createElement("input");

        expect(clipboardKeyDownAction(
            keyDown("f", { ctrlKey: true }),
            context(),
        )).toEqual({ type: "focus-search" });
        expect(clipboardKeyDownAction(
            keyDown("Enter", {}, searchInput),
            context({ searchInput }),
        )).toEqual({ type: "submit-search", plainText: false, stopPropagation: true });
        expect(clipboardKeyDownAction(
            keyDown("Escape", {}, searchInput),
            context({ searchInput, searchOpen: true, searchHasText: true }),
        )).toEqual({ type: "dismiss-search", clear: true });
        expect(clipboardKeyDownAction(
            keyDown("Escape", {}, searchInput),
            context({ searchInput, searchOpen: true }),
        )).toEqual({ type: "dismiss-search", clear: false });
    });

    it("preserves the paste-as-text shortcut when search has focus", () => {
        const searchInput = document.createElement("input");
        expect(clipboardKeyDownAction(
            keyDown("Enter", { shiftKey: true }, searchInput),
            context({ searchInput }),
        )).toEqual({ type: "submit-search", plainText: true, stopPropagation: true });
        expect(clipboardKeyDownAction(
            keyDown("p", { ctrlKey: true, shiftKey: true }, searchInput),
            context({ searchInput, pasteAsTextShortcut: "Ctrl+Shift+P" }),
        )).toEqual({ type: "submit-search", plainText: true, stopPropagation: true });
    });

    it("does not activate paste-as-text inside unrelated inputs", () => {
        expect(clipboardKeyDownAction(
            keyDown("Enter", { shiftKey: true }, document.createElement("input")),
            context({ searchInput: document.createElement("input") }),
        )).toBeNull();
    });

    it.each([false, true])("does not treat IME confirmation as a search submission (shift=%s)", shiftKey => {
        const searchInput = document.createElement("input");
        const composingEnter = keyDown(
            "Enter",
            { isComposing: true, shiftKey },
            searchInput,
        );
        const legacyImeEnter = keyDown("Enter", {}, searchInput);
        Object.defineProperty(legacyImeEnter, "keyCode", { value: 229 });

        expect(clipboardKeyDownAction(
            composingEnter,
            context({ searchInput }),
        )).toBeNull();
        expect(clipboardKeyDownAction(
            legacyImeEnter,
            context({ searchInput }),
        )).toBeNull();
    });

    it("keeps context-menu navigation ahead of global navigation", () => {
        expect(clipboardKeyDownAction(
            keyDown("ArrowDown"),
            context({ contextMenuOpen: true }),
        )).toEqual({ type: "move-context-menu-selection", direction: 1 });
        expect(clipboardKeyDownAction(
            keyDown("ArrowUp"),
            context({ contextMenuOpen: true }),
        )).toEqual({ type: "move-context-menu-selection", direction: -1 });
        expect(clipboardKeyDownAction(
            keyDown("Enter"),
            context({ contextMenuOpen: true }),
        )).toEqual({ type: "activate-context-menu-option" });
        expect(clipboardKeyDownAction(
            keyDown("Escape"),
            context({ contextMenuOpen: true }),
        )).toEqual({ type: "close-context-menu" });
    });

    it("maps selection navigation, preview, and window dismissal", () => {
        expect(clipboardKeyDownAction(keyDown("Tab", { shiftKey: true }), context()))
            .toEqual({ type: "navigate-selection", direction: -1 });
        expect(clipboardKeyDownAction(keyDown("ArrowRight"), context()))
            .toEqual({ type: "navigate-selection", direction: 1 });
        expect(clipboardKeyDownAction(keyDown("ArrowDown"), context()))
            .toEqual({ type: "open-selected-context-menu" });
        expect(clipboardKeyDownAction(keyDown(" "), context()))
            .toEqual({ type: "toggle-preview" });
        expect(clipboardKeyDownAction(keyDown("Escape"), context()))
            .toEqual({ type: "hide-window" });
    });

    it("preserves paste-as-text precedence and regular Enter activation", () => {
        expect(clipboardKeyDownAction(
            keyDown("Enter", { shiftKey: true }),
            context(),
        )).toEqual({ type: "paste-selected", plainText: true });
        expect(clipboardKeyDownAction(
            keyDown("Enter"),
            context(),
        )).toEqual({ type: "paste-selected", plainText: false });
    });

    it("lets Enter and Space activate a passthrough toolbar button instead of pasting or previewing", () => {
        const toolbar = document.createElement("div");
        const updateButton = document.createElement("button");
        updateButton.dataset.keyboardPassthrough = "true";
        const icon = document.createElement("span");
        updateButton.append(icon);
        toolbar.append(updateButton);

        for (const target of [updateButton, icon]) {
            for (const key of ["Enter", " ", "Spacebar"]) {
                expect(clipboardKeyDownAction(keyDown(key, {}, target), context())).toBeNull();
            }
            expect(clipboardKeyDownAction(keyDown("Enter", { shiftKey: true }, target), context())).toBeNull();
            expect(clipboardKeyDownAction(keyDown("Escape", {}, target), context()))
                .toEqual({ type: "hide-window" });
        }

        const ordinaryButton = document.createElement("button");
        expect(clipboardKeyDownAction(keyDown("Enter", {}, ordinaryButton), context()))
            .toEqual({ type: "paste-selected", plainText: false });
    });

    it("leaves every key to a passthrough dialog, including Escape and Tab", () => {
        const dialog = document.createElement("div");
        dialog.dataset.keyboardPassthrough = "dialog";
        const confirm = document.createElement("button");
        dialog.append(confirm);

        for (const key of ["Enter", " ", "Escape", "Tab", "ArrowRight", "ArrowDown"]) {
            expect(clipboardKeyDownAction(keyDown(key, {}, confirm), context())).toBeNull();
        }
        expect(clipboardKeyDownAction(keyDown("1", { altKey: true, code: "Digit1" }, confirm), context())).toBeNull();
    });
});
