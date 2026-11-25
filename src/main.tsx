import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import "./desktopBootstrap";
import AppThemeProvider from "./ui/AppThemeProvider.tsx";
import RouteFallback from "./ui/RouteFallback.tsx";
import AppMotionProvider from "./ui/motion/AppMotionProvider.tsx";

const Clipboard = React.lazy(() => import("./clipboard/Clipboard.tsx"));
const EmojiPicker = React.lazy(() => import("./clipboard/EmojiPicker.tsx"));
const Preview = React.lazy(() => import("./clipboard/Preview.tsx"));
const TabEditor = React.lazy(() => import("./clipboard/TabEditor.tsx"));
const TextEditor = React.lazy(() => import("./clipboard/TextEditor.tsx"));
const OnboardingPermissionWindow = React.lazy(() => import("./clipboard/OnboardingPermissionWindow.tsx"));
const NativeOnboardingWindow = React.lazy(() => import("./clipboard/NativeOnboardingWindow.tsx"));
const PasteFallbackNotice = React.lazy(() => import("./clipboard/PasteFallbackNotice.tsx"));
const PasteQueue = React.lazy(() => import("./clipboard/PasteQueue.tsx"));
const Config = React.lazy(() => import("./config/Config.tsx"));
const TrayMenu = React.lazy(() => import("./tray/TrayMenu.tsx"));

const UiLab = import.meta.env.DEV
    ? React.lazy(() => import("./ui/UiLab.tsx"))
    : null;
const SettingsPreview = import.meta.env.DEV
    ? React.lazy(() => import("./config/SettingsPreview.tsx"))
    : null;
// Only the native experiment's explicit build mode embeds these on-demand tools.
// Normal production builds still exclude them; UI Lab remains Vite-only.
const embeddedDeveloperTools = import.meta.env.MODE === "native-debug";
const TestRoom = import.meta.env.DEV || embeddedDeveloperTools
    ? React.lazy(() => import("./debug/TestRoom.tsx"))
    : null;
const DeveloperMemoryWindow = import.meta.env.DEV || embeddedDeveloperTools
    ? React.lazy(() => import("./debug/DeveloperMemoryWindow.tsx"))
    : null;

const DeveloperTutorialWindow = import.meta.env.DEV || embeddedDeveloperTools
    ? React.lazy(() => import("./debug/DeveloperTutorialWindow.tsx"))
    : null;

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (import.meta.env.DEV && "__vpasteMemoryProfileDiagnostics" in window) {
    Object.defineProperty(window, "__vpasteMemoryProfileUnmount", { value: () => root.unmount() });
}
root.render(
    <React.StrictMode>
        <AppMotionProvider>
            <AppThemeProvider>
                <Router>
                    <React.Suspense fallback={<RouteFallback />}>
                        <Routes>
                        <Route path="/clipboard" element={<Clipboard />} />
                        <Route path="/clipboard/preview" element={<Preview />} />
                        <Route path="/emoji-picker" element={<EmojiPicker />} />
                        <Route path="/tab-editor" element={<TabEditor />} />
                        <Route path="/text-editor" element={<TextEditor />} />
                        <Route path="/onboarding-permission" element={<OnboardingPermissionWindow />} />
                        <Route path="/native-onboarding" element={<NativeOnboardingWindow />} />
                        <Route path="/paste-fallback-notice" element={<PasteFallbackNotice />} />
                        <Route path="/paste-failure-notice" element={<PasteFallbackNotice showSettingsAction={false} />} />
                        <Route path="/paste-queue" element={<PasteQueue />} />
                        <Route path="/config" element={<Config />} />
                        <Route path="/tray-menu" element={<TrayMenu />} />
                        {UiLab ? <Route path="/__ui-lab" element={<UiLab />} /> : null}
                        {SettingsPreview ? <Route path="/__settings-preview" element={<SettingsPreview />} /> : null}
                        {TestRoom ? <Route path="/__test-room" element={<TestRoom />} /> : null}
                        {DeveloperTutorialWindow ? <Route path="/__dev-tutorial" element={<DeveloperTutorialWindow />} /> : null}
                        {DeveloperMemoryWindow ? <Route path="/__dev-memory" element={<DeveloperMemoryWindow />} /> : null}
                        <Route path="/" element={<Clipboard />} />
                        <Route path="*" element={<Clipboard />} />
                        </Routes>
                    </React.Suspense>
                </Router>
            </AppThemeProvider>
        </AppMotionProvider>
    </React.StrictMode>,
);
