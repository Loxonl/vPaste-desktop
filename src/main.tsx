import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { info } from "@tauri-apps/plugin-log";
import Clipboard from "./clipboard/Clipboard.tsx";
import EmojiPicker from "./clipboard/EmojiPicker.tsx";
import Preview from "./clipboard/Preview.tsx";
import TabEditor from "./clipboard/TabEditor.tsx";
import OnboardingPermissionWindow from "./clipboard/OnboardingPermissionWindow.tsx";
import PasteFallbackNotice from "./clipboard/PasteFallbackNotice.tsx";
import Config from "./config/Config.tsx";
import TrayMenu from "./tray/TrayMenu.tsx";
import "./theme.css";
import { installThemeSync } from "./theme.ts";

info(`Rendering app, path: ${window.location.pathname}`);
installThemeSync();

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <Router>
            <Routes>
                <Route path="/clipboard" element={<Clipboard />} />
                <Route path="/clipboard/preview" element={<Preview />} />
                <Route path="/emoji-picker" element={<EmojiPicker />} />
                <Route path="/tab-editor" element={<TabEditor />} />
                <Route path="/onboarding-permission" element={<OnboardingPermissionWindow />} />
                <Route path="/paste-fallback-notice" element={<PasteFallbackNotice />} />
                <Route path="/config" element={<Config />} />
                <Route path="/tray-menu" element={<TrayMenu />} />
                <Route path="/" element={<Clipboard />} />
                <Route path="*" element={<Clipboard />} />
            </Routes>
        </Router>
    </React.StrictMode>,
);
