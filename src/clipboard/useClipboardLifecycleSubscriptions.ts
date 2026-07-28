import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { CustomTab } from "./customTabs";
import type { ItemTagsChangedPayload } from "./clipboardTags";

export type WindowShowPayload = {
    x: number;
    y: number;
} | null;

export type CustomTabsChangedPayload = {
    activeId?: string;
    tabs?: CustomTab[];
};

export type PreviewNavigationPayload = {
    direction?: number;
    key?: string;
};

type ClipboardTauriEventHandlers = {
    onClipboardChanged: () => void;
    onCustomTabsChanged: (payload: CustomTabsChangedPayload) => void;
    onItemTagsChanged: (payload: ItemTagsChangedPayload) => void;
    onPermissionStatusChanged: () => void;
    onPreviewNavigation: (payload: PreviewNavigationPayload) => void;
    onTutorialCompleted: () => void;
    onTutorialStarted: () => void;
    onWindowHidden: () => void;
    onWindowHide: () => void;
    onWindowShow: (payload: WindowShowPayload) => void;
    onWindowShowComplete: () => void;
};

type ClipboardBrowserEventHandlers = {
    onBlur: () => void;
    onDismissMenus: () => void;
    onFocus: () => void;
    onMouseMove: () => void;
    onStorage: (event: StorageEvent) => void;
    onVisibilityChange: () => void;
};

type ClipboardLifecycleSubscriptions = {
    browser: ClipboardBrowserEventHandlers;
    onBeforeCleanup: () => void;
    onMount: () => void;
    onUnlistenError: (label: string, error: unknown) => void;
    tauri: ClipboardTauriEventHandlers;
};

function normalizePayload<T extends object>(
    payload: T | string | null | undefined,
): T {
    if (typeof payload === "string") {
        return JSON.parse(payload || "{}") as T;
    }
    return payload ?? {} as T;
}

export function useClipboardLifecycleSubscriptions(
    subscriptions: ClipboardLifecycleSubscriptions,
) {
    useEffect(() => {
        const unlistenShow = listen<WindowShowPayload>("window-show", event => {
            subscriptions.tauri.onWindowShow(event.payload);
        });
        const unlistenShowComplete = listen("window-show-complete", () => {
            subscriptions.tauri.onWindowShowComplete();
        });
        const unlistenHide = listen("window-hide", () => {
            subscriptions.tauri.onWindowHide();
        });
        const unlistenHidden = listen("window-hidden", () => {
            subscriptions.tauri.onWindowHidden();
        });
        const unlistenClipboard = listen("listen_new_clipboard", () => {
            subscriptions.tauri.onClipboardChanged();
        });
        const unlistenTutorialStarted = listen("tutorial-started", () => {
            subscriptions.tauri.onTutorialStarted();
        });
        const unlistenTutorialCompleted = listen("tutorial-completed", () => {
            subscriptions.tauri.onTutorialCompleted();
        });
        const unlistenPermissionStatusChanged = listen(
            "onboarding-permission-status-changed",
            () => {
                subscriptions.tauri.onPermissionStatusChanged();
            },
        );
        const unlistenCustomTabs = listen<CustomTabsChangedPayload | string | null>(
            "custom-tabs-changed",
            event => {
                subscriptions.tauri.onCustomTabsChanged(
                    normalizePayload<CustomTabsChangedPayload>(event.payload),
                );
            },
        );
        const unlistenItemTags = listen<ItemTagsChangedPayload | string | null>(
            "item-tags-changed",
            event => {
                subscriptions.tauri.onItemTagsChanged(
                    normalizePayload<ItemTagsChangedPayload>(event.payload),
                );
            },
        );
        const unlistenPreviewNavigation = listen<PreviewNavigationPayload>(
            "preview-navigate-selection",
            event => {
                subscriptions.tauri.onPreviewNavigation(event.payload);
            },
        );

        window.addEventListener("mousemove", subscriptions.browser.onMouseMove, {
            capture: true,
        });
        window.addEventListener("focus", subscriptions.browser.onFocus);
        document.addEventListener(
            "visibilitychange",
            subscriptions.browser.onVisibilityChange,
        );
        window.addEventListener("storage", subscriptions.browser.onStorage);
        window.addEventListener("blur", subscriptions.browser.onBlur);
        window.addEventListener("click", subscriptions.browser.onDismissMenus);
        window.addEventListener("resize", subscriptions.browser.onDismissMenus);
        subscriptions.onMount();

        const removeTauriListener = (
            unlisten: Promise<() => void>,
            label: string,
        ) => {
            unlisten
                .then(removeListener => removeListener())
                .catch(error => subscriptions.onUnlistenError(label, error));
        };

        return () => {
            subscriptions.onBeforeCleanup();
            removeTauriListener(unlistenShow, "show");
            removeTauriListener(unlistenShowComplete, "show completion");
            removeTauriListener(unlistenHide, "hide");
            removeTauriListener(unlistenHidden, "hidden");
            removeTauriListener(unlistenClipboard, "clipboard");
            removeTauriListener(unlistenCustomTabs, "custom tabs");
            removeTauriListener(unlistenItemTags, "item tags");
            removeTauriListener(unlistenPreviewNavigation, "preview navigation");
            removeTauriListener(unlistenTutorialStarted, "tutorial start");
            removeTauriListener(unlistenTutorialCompleted, "tutorial complete");
            removeTauriListener(
                unlistenPermissionStatusChanged,
                "onboarding permission status",
            );
            window.removeEventListener(
                "mousemove",
                subscriptions.browser.onMouseMove,
                { capture: true },
            );
            window.removeEventListener("focus", subscriptions.browser.onFocus);
            document.removeEventListener(
                "visibilitychange",
                subscriptions.browser.onVisibilityChange,
            );
            window.removeEventListener("storage", subscriptions.browser.onStorage);
            window.removeEventListener("blur", subscriptions.browser.onBlur);
            window.removeEventListener("click", subscriptions.browser.onDismissMenus);
            window.removeEventListener("resize", subscriptions.browser.onDismissMenus);
        };
    }, []);
}
