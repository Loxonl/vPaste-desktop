import {
    isTextInputTarget,
    matchesKeyboardShortcut,
    quickInputAction,
} from "./clipboardInteractions";

export type ClipboardKeyDownAction =
    | { type: "alt-press"; showHints: boolean; stopPropagation: true }
    | { type: "quick-tab"; tabId: "all" | "favorite" }
    | { type: "quick-item"; index: number }
    | { type: "focus-search" }
    | { type: "submit-search"; plainText: boolean; stopPropagation: true }
    | { type: "dismiss-search"; clear: boolean }
    | { type: "move-context-menu-selection"; direction: -1 | 1 }
    | { type: "activate-context-menu-option" }
    | { type: "close-context-menu" }
    | { type: "hide-window" }
    | { type: "navigate-selection"; direction: -1 | 1 }
    | { type: "open-selected-context-menu" }
    | { type: "toggle-preview" }
    | { type: "delete-selected" }
    | { type: "edit-selected" }
    | { type: "paste-selected"; plainText: boolean };

export type ClipboardKeyboardContext = {
    contextMenuOpen: boolean;
    isMac: boolean;
    pasteAsTextShortcut?: string | null;
    quickInputEnabled: boolean;
    searchHasText: boolean;
    searchComposing: boolean;
    searchInput: HTMLInputElement | null;
    searchOpen: boolean;
    tabQuickSelectEnabled: boolean;
};

/**
 * Controls marked with `data-keyboard-passthrough` handle Enter and Space
 * themselves (native button activation) rather than pasting or previewing
 * the selected card. Dialogs marked with `data-keyboard-passthrough="dialog"`
 * handle every key, including Escape and Tab.
 */
function isKeyboardPassthroughTarget(target: EventTarget | null, selector = "[data-keyboard-passthrough]"): boolean {
    return target instanceof Element && target.closest(selector) !== null;
}

export function clipboardKeyDownAction(
    event: KeyboardEvent,
    context: ClipboardKeyboardContext,
): ClipboardKeyDownAction | null {
    if (context.searchComposing || event.isComposing || event.keyCode === 229) {
        return null;
    }

    if (isKeyboardPassthroughTarget(event.target, '[data-keyboard-passthrough="dialog"]')) {
        return null;
    }

    if (event.key === "Alt") {
        return {
            type: "alt-press",
            showHints: context.quickInputEnabled,
            stopPropagation: true,
        };
    }

    const targetIsTextInput = isTextInputTarget(event.target);
    const allowQuickInputInSearch = event.target === context.searchInput;
    if (
        context.quickInputEnabled
        && event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && (!targetIsTextInput || allowQuickInputInSearch)
    ) {
        const action = quickInputAction(event, context.isMac);
        if (action?.kind === "tab") {
            return { type: "quick-tab", tabId: action.tabId };
        }
        if (action?.kind === "item") {
            if (event.repeat) return null;
            return { type: "quick-item", index: action.index };
        }
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        return { type: "focus-search" };
    }

    if (targetIsTextInput) {
        const plainText = matchesKeyboardShortcut(event, context.pasteAsTextShortcut);
        if ((event.key === "Enter" || plainText) && event.target === context.searchInput) {
            return { type: "submit-search", plainText, stopPropagation: true };
        }
        if (event.key === "Escape" && context.searchOpen) {
            return { type: "dismiss-search", clear: context.searchHasText };
        }
        return null;
    }

    if (
        isKeyboardPassthroughTarget(event.target)
        && (event.key === "Enter" || event.key === " " || event.key === "Spacebar")
    ) {
        return null;
    }

    if (context.contextMenuOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            return {
                type: "move-context-menu-selection",
                direction: event.key === "ArrowDown" ? 1 : -1,
            };
        }
        if (event.key === "Enter") {
            return { type: "activate-context-menu-option" };
        }
        if (event.key === "Escape") {
            return { type: "close-context-menu" };
        }
    }

    if (event.key === "Escape" && context.searchOpen) {
        return { type: "dismiss-search", clear: context.searchHasText };
    }
    if (event.key === "Escape") {
        return { type: "hide-window" };
    }
    if (context.tabQuickSelectEnabled && event.key === "Tab") {
        return {
            type: "navigate-selection",
            direction: event.shiftKey ? -1 : 1,
        };
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        return {
            type: "navigate-selection",
            direction: event.key === "ArrowRight" ? 1 : -1,
        };
    }
    if (event.key === "ArrowDown") {
        return { type: "open-selected-context-menu" };
    }
    if (event.key === " " || event.key === "Spacebar") {
        return { type: "toggle-preview" };
    }
    if (event.key === (context.isMac ? "Backspace" : "Delete")) {
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || context.contextMenuOpen || isKeyboardPassthroughTarget(event.target)
            || isKeyboardPassthroughTarget(event.target, '[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
            return null;
        }
        return { type: "delete-selected" };
    }
    if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        if (event.repeat || context.contextMenuOpen || isKeyboardPassthroughTarget(event.target)
            || isKeyboardPassthroughTarget(event.target, '[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return null;
        return { type: "edit-selected" };
    }
    if (matchesKeyboardShortcut(event, context.pasteAsTextShortcut)) {
        return { type: "paste-selected", plainText: true };
    }
    if (event.key === "Enter") {
        return { type: "paste-selected", plainText: false };
    }

    return null;
}
