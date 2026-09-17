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
});
