import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { info } from "@tauri-apps/plugin-log";
import "./theme.css";
import { installThemeSync } from "./theme.ts";
import AppThemeProvider from "./ui/AppThemeProvider.tsx";
import RouteFallback from "./ui/RouteFallback.tsx";

const Clipboard = React.lazy(() => import("./clipboard/Clipboard.tsx"));
const EmojiPicker = React.lazy(() => import("./clipboard/EmojiPicker.tsx"));
const Preview = React.lazy(() => import("./clipboard/Preview.tsx"));
const TabEditor = React.lazy(() => import("./clipboard/TabEditor.tsx"));
const OnboardingPermissionWindow = React.lazy(() => import("./clipboard/OnboardingPermissionWindow.tsx"));
const PasteFallbackNotice = React.lazy(() => import("./clipboard/PasteFallbackNotice.tsx"));
const Config = React.lazy(() => import("./config/Config.tsx"));
const TrayMenu = React.lazy(() => import("./tray/TrayMenu.tsx"));

const UiLab = import.meta.env.DEV
    ? React.lazy(() => import("./ui/UiLab.tsx"))
    : null;
const SettingsPreview = import.meta.env.DEV
    ? React.lazy(() => import("./config/SettingsPreview.tsx"))
    : null;

if ("__TAURI_INTERNALS__" in window) {
    void info(`Rendering app, path: ${window.location.pathname}`);
}
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
        <AppThemeProvider>
            <Router>
                <React.Suspense fallback={<RouteFallback />}>
                    <Routes>
                        <Route path="/clipboard" element={<Clipboard />} />
                        <Route path="/clipboard/preview" element={<Preview />} />
                        <Route path="/emoji-picker" element={<EmojiPicker />} />
                        <Route path="/tab-editor" element={<TabEditor />} />
                        <Route path="/onboarding-permission" element={<OnboardingPermissionWindow />} />
                        <Route path="/paste-fallback-notice" element={<PasteFallbackNotice />} />
                        <Route path="/config" element={<Config />} />
                        <Route path="/tray-menu" element={<TrayMenu />} />
                        {UiLab ? <Route path="/__ui-lab" element={<UiLab />} /> : null}
                        {SettingsPreview ? <Route path="/__settings-preview" element={<SettingsPreview />} /> : null}
                        <Route path="/" element={<Clipboard />} />
                        <Route path="*" element={<Clipboard />} />
                    </Routes>
                </React.Suspense>
            </Router>
        </AppThemeProvider>
    </React.StrictMode>,
);
