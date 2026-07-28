import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface SettingsBridge {
    invoke: typeof invoke;
    listen: typeof listen;
    open: typeof open;
    save: typeof save;
    convertFileSrc: typeof convertFileSrc;
    startWindowDragging: () => Promise<void>;
    hideWindow: () => Promise<void>;
}

export const tauriSettingsBridge: SettingsBridge = {
    invoke,
    listen,
    open,
    save,
    convertFileSrc,
    startWindowDragging: () => getCurrentWindow().startDragging(),
    hideWindow: () => getCurrentWindow().hide(),
};
