import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import { notifyAuxiliaryWindowReady } from "../auxiliaryWindowReady";
import { setThemePreview, type ResolvedTheme } from "../theme";
import DeveloperMemoryPanel from "./DeveloperMemoryPanel";

type Preview = { languageCode?: string; themePreview?: ResolvedTheme };

export default function DeveloperMemoryWindow() {
    const { t, setPreviewLanguageCode } = useLanguage();
    useEffect(() => {
        const unlisten = listen<Preview>("dev-memory-open", event => {
            if (event.payload.languageCode) setPreviewLanguageCode(event.payload.languageCode);
            if (event.payload.themePreview) setThemePreview(event.payload.themePreview);
        });
        const cancelReady = notifyAuxiliaryWindowReady([unlisten]);
        return () => {
            cancelReady();
            void unlisten.then(remove => remove()).catch(reason => error(String(reason)));
        };
    }, [setPreviewLanguageCode]);
    return <DeveloperMemoryPanel open fullScreen t={t} onClose={() => {
        void invoke("close_dev_memory_window").catch(reason => error(`Failed to close memory window: ${reason}`));
    }} />;
}
