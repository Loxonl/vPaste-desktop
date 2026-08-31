import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClipboardLifecycleSubscriptions } from "../../../src/clipboard/useClipboardLifecycleSubscriptions";

type EventCallback = (event: { payload: unknown }) => void;

const tauri = vi.hoisted(() => {
    const callbacks = new Map<string, EventCallback>();
    const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();
    const listen = vi.fn((eventName: string, callback: EventCallback) => {
        callbacks.set(eventName, callback);
        const unlisten = vi.fn();
        unlisteners.set(eventName, unlisten);
        return Promise.resolve(unlisten);
    });
    return { callbacks, listen, unlisteners };
});

vi.mock("@tauri-apps/api/event", () => ({
    listen: tauri.listen,
}));

function handlers() {
    return {
        browser: {
            onBlur: vi.fn(),
            onDismissMenus: vi.fn(),
            onFocus: vi.fn(),
            onMouseMove: vi.fn(),
            onStorage: vi.fn(),
            onVisibilityChange: vi.fn(),
        },
        onBeforeCleanup: vi.fn(),
        onMount: vi.fn(),
        onUnlistenError: vi.fn(),
        tauri: {
            onBehaviorConfigChanged: vi.fn(),
            onClipboardChanged: vi.fn(),
            onCustomTabsChanged: vi.fn(),
            onItemTagsChanged: vi.fn(),
            onPermissionStatusChanged: vi.fn(),
            onPreviewNavigation: vi.fn(),
            onTutorialCompleted: vi.fn(),
            onTutorialStarted: vi.fn(),
            onWindowHidden: vi.fn(),
            onWindowHide: vi.fn(),
            onWindowShow: vi.fn(),
            onWindowShowComplete: vi.fn(),
        },
    };
}

describe("useClipboardLifecycleSubscriptions", () => {
    beforeEach(() => {
        tauri.callbacks.clear();
        tauri.unlisteners.clear();
        tauri.listen.mockClear();
    });

    it("registers the established event contract and forwards normalized payloads", () => {
        const callbacks = handlers();
        const { unmount } = renderHook(() => useClipboardLifecycleSubscriptions(callbacks));

        expect(tauri.listen.mock.calls.map(call => call[0])).toEqual([
            "window-show",
            "window-show-complete",
            "window-hide",
            "window-hidden",
            "listen_new_clipboard",
            "tutorial-started",
            "tutorial-completed",
            "onboarding-permission-status-changed",
            "clipboard-behavior-config-changed",
            "custom-tabs-changed",
            "item-tags-changed",
            "preview-navigate-selection",
        ]);
        expect(callbacks.onMount).toHaveBeenCalledOnce();

        act(() => {
            tauri.callbacks.get("window-show")?.({ payload: { x: 12, y: 24 } });
            tauri.callbacks.get("clipboard-behavior-config-changed")?.({
                payload: { link_auto_preview: false },
            });
            tauri.callbacks.get("custom-tabs-changed")?.({
                payload: JSON.stringify({ activeId: "work", tabs: [] }),
            });
            tauri.callbacks.get("item-tags-changed")?.({
                payload: JSON.stringify({ activeId: "record-tag-3" }),
            });
            tauri.callbacks.get("preview-navigate-selection")?.({
                payload: { direction: -1, key: "Tab" },
            });
            tauri.callbacks.get("item-tags-changed")?.({ payload: null });
        });

        expect(callbacks.tauri.onWindowShow).toHaveBeenCalledWith({ x: 12, y: 24 });
        expect(callbacks.tauri.onBehaviorConfigChanged)
            .toHaveBeenCalledWith({ link_auto_preview: false });
        expect(callbacks.tauri.onCustomTabsChanged)
            .toHaveBeenCalledWith({ activeId: "work", tabs: [] });
        expect(callbacks.tauri.onItemTagsChanged)
            .toHaveBeenCalledWith({ activeId: "record-tag-3" });
        expect(callbacks.tauri.onItemTagsChanged).toHaveBeenLastCalledWith({});
        expect(callbacks.tauri.onPreviewNavigation)
            .toHaveBeenCalledWith({ direction: -1, key: "Tab" });

        unmount();
    });

    it("forwards browser lifecycle events and removes every subscription on cleanup", async () => {
        const callbacks = handlers();
        const { unmount } = renderHook(() => useClipboardLifecycleSubscriptions(callbacks));
        const storageEvent = new StorageEvent("storage", {
            key: "vpaste.pendingItemTagsChangedPayload",
            newValue: "{}",
        });

        act(() => {
            window.dispatchEvent(new MouseEvent("mousemove"));
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(storageEvent);
            window.dispatchEvent(new Event("blur"));
            window.dispatchEvent(new MouseEvent("click"));
            window.dispatchEvent(new Event("resize"));
        });

        expect(callbacks.browser.onMouseMove).toHaveBeenCalledOnce();
        expect(callbacks.browser.onFocus).toHaveBeenCalledOnce();
        expect(callbacks.browser.onVisibilityChange).toHaveBeenCalledOnce();
        expect(callbacks.browser.onStorage).toHaveBeenCalledWith(storageEvent);
        expect(callbacks.browser.onBlur).toHaveBeenCalledOnce();
        expect(callbacks.browser.onDismissMenus).toHaveBeenCalledTimes(2);

        unmount();
        expect(callbacks.onBeforeCleanup).toHaveBeenCalledOnce();
        await waitFor(() => {
            expect([...tauri.unlisteners.values()].every(unlisten =>
                unlisten.mock.calls.length === 1,
            )).toBe(true);
        });

        act(() => {
            window.dispatchEvent(new Event("focus"));
            window.dispatchEvent(new MouseEvent("click"));
        });
        expect(callbacks.browser.onFocus).toHaveBeenCalledOnce();
        expect(callbacks.browser.onDismissMenus).toHaveBeenCalledTimes(2);
        expect(callbacks.onUnlistenError).not.toHaveBeenCalled();
    });
});
