import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_ATTRIBUTE = "data-theme";
const THEME_MODE_ATTRIBUTE = "data-theme-mode";
const THEME_STORAGE_KEY = "vpaste.themeMode";
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentMode: ThemeMode = "system";
let previewMode: ResolvedTheme | null = null;
let isSyncingFromConfig = false;

function normalizeThemeMode(value: unknown): ThemeMode {
    return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function resolvedTheme(mode: ThemeMode): ResolvedTheme {
    return mode === "system" ? (mediaQuery.matches ? "dark" : "light") : mode;
}

function renderTheme() {
    const theme = previewMode || resolvedTheme(currentMode);
    const mode = previewMode || currentMode;
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
    document.documentElement.setAttribute(THEME_MODE_ATTRIBUTE, mode);
    document.body?.setAttribute(THEME_ATTRIBUTE, theme);
    document.body?.setAttribute(THEME_MODE_ATTRIBUTE, mode);
}

export function applyThemeMode(mode: ThemeMode) {
    currentMode = normalizeThemeMode(mode);
    renderTheme();
    try {
        localStorage.setItem(THEME_STORAGE_KEY, currentMode);
    } catch {
        // localStorage can be unavailable during early webview startup.
    }
}

export function setThemePreview(mode: ResolvedTheme | null) {
    previewMode = mode === "light" || mode === "dark" ? mode : null;
    renderTheme();
}

export function getThemePreview(): ResolvedTheme | null {
    return previewMode;
}

export function getResolvedTheme(): ResolvedTheme {
    return previewMode || resolvedTheme(currentMode);
}

function applyStoredThemeMode() {
    try {
        const storedMode = localStorage.getItem(THEME_STORAGE_KEY);
        if (storedMode) {
            applyThemeMode(normalizeThemeMode(storedMode));
        }
    } catch {
        // Ignore and let the backend config decide the theme.
    }
}

export async function loadAndApplyTheme() {
    applyStoredThemeMode();
    if (isSyncingFromConfig) return;
    isSyncingFromConfig = true;
    try {
        const config = await invoke<string>("get_config");
        const parsed = JSON.parse(config);
        applyThemeMode(normalizeThemeMode(parsed.theme_mode));
    } catch (e) {
        error(`Failed to load theme config: ${e}`);
        applyThemeMode("system");
    } finally {
        isSyncingFromConfig = false;
    }
}

export function installThemeSync() {
    applyStoredThemeMode();
    void loadAndApplyTheme();

    mediaQuery.addEventListener("change", () => {
        if (currentMode === "system") {
            applyThemeMode("system");
        }
    });

    listen<ThemeMode>("theme-changed", event => {
        applyThemeMode(normalizeThemeMode(event.payload));
    }).catch(e => error(`Failed to listen theme change: ${e}`));

    window.addEventListener("focus", () => {
        void loadAndApplyTheme();
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void loadAndApplyTheme();
        }
    });
}
