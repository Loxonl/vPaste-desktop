import { info } from "@tauri-apps/plugin-log";
import "./theme.css";
import { installThemeSync } from "./theme";
import { syncMotionCssVariables } from "./ui/motion";

if ("__TAURI_INTERNALS__" in window) {
    void info(`Rendering app, path: ${window.location.pathname}`);
}
installThemeSync();
syncMotionCssVariables();

function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || target.isContentEditable;
}

function installDesktopInteractionGuards() {
    window.addEventListener("contextmenu", event => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-allow-context-menu='true']")) {
            event.preventDefault();
        }
    });

    window.addEventListener("auxclick", event => {
        if (event.button === 1) {
            event.preventDefault();
        }
    });

    window.addEventListener("dragover", event => event.preventDefault());
    window.addEventListener("drop", event => event.preventDefault());

    window.addEventListener("keydown", event => {
        const key = event.key.toLowerCase();
        const ctrlOrMeta = event.ctrlKey || event.metaKey;
        const reloadLike = key === "f5" || (ctrlOrMeta && key === "r");
        const browserAction = ctrlOrMeta && ["p", "s", "o", "n"].includes(key);
        const historyNav = event.altKey && ["arrowleft", "arrowright"].includes(key);
        const backspaceNav = key === "backspace" && !isEditableTarget(event.target);

        if (reloadLike || browserAction || historyNav || backspaceNav) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
}

installDesktopInteractionGuards();
