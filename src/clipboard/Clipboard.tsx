// @ts-ignore
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopDir, downloadDir } from "@tauri-apps/api/path";
import { error } from "@tauri-apps/plugin-log";
import { Item, ItemTag, ItemType } from "./Item.ts";
import { useLanguage } from "../lang";
import { formatShortcutLabel, isMacPlatform } from "../shortcutDisplay";
import SearchIcon from "@mui/icons-material/Search";
import TutorialOverlay, { TutorialFilterId, TutorialFilterTab, TutorialPermission, TutorialPermissionId, TutorialPlatform } from "./TutorialOverlay.tsx";
import appIcon from "../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import { getResolvedTheme, getThemePreview, setThemePreview, type ResolvedTheme } from "../theme";
import { updateReady, useAppUpdateState } from "../update";
import {
    arraysEqual,
    customTabFilterPayload,
    DEFAULT_CUSTOM_FILTER,
    loadCustomTabs,
    loadTabOrder,
    mergeTagSearchFilter,
    normalizeCustomTabs,
    orderedDynamicTabs,
    parseTagSearch,
    recordTagIdFromTab,
    recordTagTabId,
    saveCustomTabs,
    saveTabOrder,
    type CustomTab,
} from "./customTabs";
import { fetchSearchPage } from "./searchPagination";
import ClipboardCard from "./ClipboardCard";
import {
    compactPath,
    dirName,
    getBackendTypeLabel,
    imageExportSourcePath,
    joinPath,
    parseLinkContent,
    type FilePreviewInfo,
} from "./itemPresentation";
import {
    CONTEXT_MENU_GAP,
    CONTEXT_MENU_PADDING,
    CONTEXT_MENU_ROW_HEIGHT,
    CONTEXT_MENU_WIDTH,
    CONTEXT_SUBMENU_WIDTH,
    TAB_CONTEXT_MENU_WIDTH,
    VIEWPORT_MARGIN,
    clampToViewport,
    contextMenuHeight,
    floatingPositionFromClick,
    screenAnchoredPositionFromClick,
    screenFloatingPositionFromAnchor,
} from "./floatingPosition";
import {
    ClipboardContextMenus,
    DeleteConfirmDialog,
    TabContextMenu,
    TagCreateChoicePopover,
    type ColorCopyOption,
    type ContextMenuState,
    type TabContextMenuState,
    type TagCreateChoiceState,
} from "./ClipboardOverlays";
import {
    ClipboardHeaderActions,
    ClipboardTabBar,
    ClipboardUpdateBanner,
} from "./ClipboardHeader";
import { clipboardKeyDownAction } from "./clipboardKeyboard";
import { buildClipboardContextMenuOptions } from "./clipboardContextMenu";
import {
    useClipboardLifecycleSubscriptions,
    type ItemTagsChangedPayload,
} from "./useClipboardLifecycleSubscriptions";
import { useClipboardListInteractions } from "./useClipboardListInteractions";

const CLIPBOARD_SHOW_REFRESH_DELAY_MS = 310;
const DEFAULT_PASTE_AS_TEXT_SHORTCUT = "Shift+Enter";
const HISTORY_PAGE_LIMIT = 36;
const IMAGE_EXPORT_DIR_KEY = "vpaste.imageExportDir.v1";
const PENDING_ITEM_TAGS_CHANGED_KEY = "vpaste.pendingItemTagsChangedPayload";
const PENDING_PERMISSION_WINDOW_KEY = "vpaste.pendingOnboardingPermission.v1";

type ToastKind = 'info' | 'warning' | 'error';

type ToastState = {
    id: number;
    message: string;
    kind: ToastKind;
    actionLabel?: string;
    onAction?: () => void;
} | null;

type ClipboardBehaviorConfig = {
    display_tray_icon?: boolean;
    onboarding_completed?: boolean;
    retain_search_history?: boolean;
    retain_last_position?: boolean;
    retain_tab_position?: boolean;
    link_auto_preview?: boolean;
    quick_input_enabled?: boolean;
    tab_quick_select_enabled?: boolean;
    shortcut_keys?: {
        main_window?: string | null;
        paste_into_plain_text?: string | null;
    };
};

type PasteAccessibilityPermissionStatus = {
    granted: boolean;
    needs_settings: boolean;
};

type TutorialPermissionStatus = {
    background: { done: boolean; needs_settings: boolean; error?: string | null };
    paste: { done: boolean; needs_settings: boolean; error?: string | null };
};

type LinkPreviewUpdate = {
    url: string;
    title: string;
    image_path: string;
    image_kind?: string;
};

type TabEditorMode = "add" | "edit";
type TagEditorKind = "filter" | "record";
const TAB_EDITOR_WIDTH = 286;
const FILTER_TAG_EDITOR_HEIGHT = 398;
const RECORD_TAG_EDITOR_HEIGHT = 178;
const TAG_CREATE_CHOICE_WIDTH = 252;
const TAG_CREATE_CHOICE_HEIGHT = 142;

const DEFAULT_MAIN_SHORTCUT = "Alt+V";
const TUTORIAL_FILTER_TABS: Array<{ id: TutorialFilterId; emoji: string; titleKey: string; itemType: ItemType }> = [
    { id: "text", emoji: "📝", titleKey: "type.text", itemType: ItemType.Text },
    { id: "image", emoji: "🖼️", titleKey: "type.image", itemType: ItemType.Image },
    { id: "link", emoji: "🔗", titleKey: "type.link", itemType: ItemType.Link },
    { id: "color", emoji: "🎨", titleKey: "type.color", itemType: ItemType.Color },
    { id: "file", emoji: "📁", titleKey: "type.file", itemType: ItemType.File },
];

function tutorialFilterTabId(id: TutorialFilterId): string {
    return `tutorial-filter-${id}`;
}

function persistCustomTabs(tabs: CustomTab[]) {
    saveCustomTabs(tabs);
    void invoke('save_custom_tabs', { tabs })
        .catch(e => error(`Failed to persist custom tabs: ${e}`));
}

class ClipboardPage {
    list: Item[];
    consumed: number;

    constructor(list: Item[], consumed: number) {
        this.list = list;
        this.consumed = consumed;
    }
}

export default function Clipboard() {
    const { t, languageCode, setPreviewLanguageCode } = useLanguage();
    const { state: updateState } = useAppUpdateState();
    const [selected, setSelected] = useState<String>("");
    const [searchWord, setSearchWord] = useState<String>("");
    const [searchOpen, setSearchOpen] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState<string>("all");
    const [customTabs, setCustomTabs] = useState<CustomTab[]>(loadCustomTabs);
    const [tabOrder, setTabOrder] = useState<string[]>(loadTabOrder);
    const [draggingTabId, setDraggingTabId] = useState<string>("");
    const [toast, setToast] = useState<ToastState>(null);
    const [fileRefreshKey, setFileRefreshKey] = useState(0);
    const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
    const [contextMenuIndex, setContextMenuIndex] = useState(0);
    const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState>(null);
    const [tagCreateChoice, setTagCreateChoice] = useState<TagCreateChoiceState>(null);
    const [deleteConfirmTab, setDeleteConfirmTab] = useState<CustomTab | null>(null);
    const [deleteConfirmRecordTag, setDeleteConfirmRecordTag] = useState<ItemTag | null>(null);
    const [itemTags, setItemTags] = useState<ItemTag[]>([]);
    const [hasMoreHistory, setHasMoreHistory] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [altHintsVisible, setAltHintsVisible] = useState(false);
    const [simulatedHoverHash, setSimulatedHoverHash] = useState("");
    const [tutorialActive, setTutorialActive] = useState(false);
    const [tutorialRunId, setTutorialRunId] = useState(0);
    const [tutorialPermissionStatus, setTutorialPermissionStatus] = useState<TutorialPermissionStatus | null>(null);
    const [tutorialPlatform, setTutorialPlatform] = useState<TutorialPlatform>(() => isMacPlatform() ? "mac" : "windows");
    const [developerMode, setDeveloperMode] = useState(false);
    const [developerTheme, setDeveloperTheme] = useState<ResolvedTheme>(() => getResolvedTheme());
    const [mainShortcut, setMainShortcut] = useState(DEFAULT_MAIN_SHORTCUT);

    // Initialize with mock data
    const [clipboardPage, setPage] = useState(() => {
        return new ClipboardPage([], 0);
    });

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        invoke<boolean>("get_developer_mode")
            .then(enabled => {
                setDeveloperMode(enabled);
                if (enabled) setDeveloperTheme(getResolvedTheme());
            })
            .catch(e => error(`Failed to detect developer mode: ${e}`));
    }, []);

    const [animationState, setAnimationState] = useState<'hidden' | 'entering' | 'entered' | 'exiting'>('entered');
    const containerRef = useRef<HTMLDivElement>(null);
    const cardsContainerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const addTabButtonRef = useRef<HTMLButtonElement>(null);
    const toastTimerRef = useRef<number | null>(null);
    const altHintTimerRef = useRef<number | null>(null);
    const scrollRefreshTimerRef = useRef<number | null>(null);
    const imagePrewarmTimerRef = useRef<number | null>(null);
    const lastLoadMoreCheckRef = useRef(0);
    const searchDebounceTimerRef = useRef<number | null>(null);
    const searchRequestSeqRef = useRef(0);
    const lastHistoryFetchRef = useRef<{ keywords: string; tab: string } | null>(null);
    const maybeLoadMoreHistoryRef = useRef<(force?: boolean) => void>(() => undefined);
    const searchWordRef = useRef("");
    const activeTabRef = useRef("all");
    const tutorialActiveRef = useRef(false);
    const selectedRef = useRef("");
    const pageListRef = useRef<Item[]>([]);
    const pasteAsTextShortcutRef = useRef(DEFAULT_PASTE_AS_TEXT_SHORTCUT);
    const quickInputEnabledRef = useRef(true);
    const tabQuickSelectEnabledRef = useRef(true);
    const linkAutoPreviewRef = useRef(true);
    const linkPreviewRefreshingRef = useRef(false);
    const imageClipboardCachePrewarmRef = useRef<Set<string>>(new Set());
    const hasMoreHistoryRef = useRef(true);
    const isLoadingMoreRef = useRef(false);
    const customTabsStorageReadyRef = useRef(false);
    const pendingRecordTagAssignTargetRef = useRef<Item | null>(null);
    const previewRequestSeqRef = useRef(0);
    const activateClipboardCardRef = useRef<(hash: string, plainText: boolean) => void>(() => { });
    const dynamicTabs = useMemo(
        () => orderedDynamicTabs(customTabs, itemTags, tabOrder),
        [customTabs, itemTags, tabOrder],
    );
    const openClipboardContextMenuRef = useRef<(item: Item, clientX: number, clientY: number) => void>(() => { });

    const activateClipboardCard = useCallback((hash: string, plainText: boolean) => {
        activateClipboardCardRef.current(hash, plainText);
    }, []);

    const openClipboardContextMenu = useCallback((item: Item, clientX: number, clientY: number) => {
        openClipboardContextMenuRef.current(item, clientX, clientY);
    }, []);

    const {
        clearClickSuppression: clearCardsClickSuppression,
        finishPointerDrag: finishCardsPointerDrag,
        handleClickCapture: handleCardsClickCapture,
        handlePointerDown: handleCardsPointerDown,
        handlePointerMove: handleCardsPointerMove,
        resetPointerState: resetCardsPointerState,
        stopWheelScroll,
    } = useClipboardListInteractions({
        containerRef: cardsContainerRef,
        tutorialActive,
        draggingClassName: styles.dragging,
        wheelScrollingClassName: styles["wheel-scrolling"],
        cardSelector: `.${styles["clipboard-card"]}`,
        contextMenuSelector: `.${styles["context-menu"]}`,
        onActivateCard: activateClipboardCard,
        onLoadMore: force => maybeLoadMoreHistoryRef.current(force),
        onPointerStart: () => setContextMenu(null),
        onWheelStart: () => {
            setContextMenu(null);
            setTabContextMenu(null);
        },
    });

    const clearAltHintTimer = () => {
        if (altHintTimerRef.current !== null) {
            window.clearTimeout(altHintTimerRef.current);
            altHintTimerRef.current = null;
        }
    };

    const hideAltHints = () => {
        clearAltHintTimer();
        setAltHintsVisible(false);
    };

    const pollAltKeyState = () => {
        clearAltHintTimer();
        altHintTimerRef.current = window.setTimeout(() => {
            void invoke<boolean>('is_alt_key_pressed')
                .then(pressed => {
                    altHintTimerRef.current = null;
                    if (pressed && quickInputEnabledRef.current) {
                        setAltHintsVisible(true);
                        pollAltKeyState();
                    } else {
                        setAltHintsVisible(false);
                    }
                })
                .catch(e => {
                    altHintTimerRef.current = null;
                    error(`Failed to read Alt key state: ${e}`);
                });
        }, 40);
    };

    const showAltHintsWhilePressed = () => {
        if (!quickInputEnabledRef.current) {
            hideAltHints();
            return;
        }
        setAltHintsVisible(true);
        pollAltKeyState();
    };

    const syncAltHintsFromNative = () => {
        void invoke<boolean>('is_alt_key_pressed')
            .then(pressed => {
                if (pressed && quickInputEnabledRef.current) {
                    showAltHintsWhilePressed();
                } else {
                    hideAltHints();
                }
            })
            .catch(e => error(`Failed to sync Alt key state: ${e}`));
    };

    const switchToTabWithShortcut = (tabId: string) => {
        setContextMenu(null);
        setTabContextMenu(null);
        activeTabRef.current = tabId;
        setActiveTab(tabId);
    };

    const activateItemShortcut = (index: number) => {
        const item = pageListRef.current[index];
        if (!item) return;
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash() as string);
        hideAltHints();
        void clickClipboardItem(item.getHash(), false, true, String(index + 1));
    };

    const selectFirstLoadedItem = (scroll: boolean = false) => {
        const firstHash = pageListRef.current[0]?.getHash() as string | undefined;
        if (!firstHash) return;
        selectedRef.current = firstHash;
        setSelected(firstHash);
        if (scroll && cardsContainerRef.current) {
            cardsContainerRef.current.scrollLeft = 0;
        }
    };

    useEffect(() => {
        searchWordRef.current = searchWord as string;
    }, [searchWord]);

    useEffect(() => {
        activeTabRef.current = activeTab;
    }, [activeTab]);

    useEffect(() => {
        tutorialActiveRef.current = tutorialActive;
    }, [tutorialActive]);

    useEffect(() => {
        const activeRecordTagId = recordTagIdFromTab(activeTab);
        if (activeRecordTagId === null) return;
        if (itemTags.some(tag => tag.id === activeRecordTagId)) return;
        activeTabRef.current = "all";
        setActiveTab("all");
    }, [activeTab, itemTags]);

    useEffect(() => {
        const localTabs = loadCustomTabs();
        void loadItemTags();
        void invoke<unknown>('get_custom_tabs')
            .then(value => {
                const storedTabs = normalizeCustomTabs(value);
                customTabsStorageReadyRef.current = true;
                if (storedTabs.length > 0) {
                    saveCustomTabs(storedTabs);
                    setCustomTabs(storedTabs);
                } else if (localTabs.length > 0) {
                    persistCustomTabs(localTabs);
                }
            })
            .catch(e => {
                customTabsStorageReadyRef.current = true;
                error(`Failed to load stored custom tabs: ${e}`);
            });
    }, []);

    useEffect(() => {
        saveCustomTabs(customTabs);
        if (customTabsStorageReadyRef.current) {
            void invoke('save_custom_tabs', { tabs: customTabs })
                .catch(e => error(`Failed to save stored custom tabs: ${e}`));
        }
        const activeRecordTagId = recordTagIdFromTab(activeTab);
        const activeRecordTagExists = activeRecordTagId !== null && itemTags.some(tag => tag.id === activeRecordTagId);
        if (activeTab !== "all" && activeTab !== "favorite" && !activeRecordTagExists && !customTabs.some(tab => tab.id === activeTab)) {
            setActiveTab("all");
        }
    }, [activeTab, customTabs, itemTags]);

    useEffect(() => {
        const normalizedOrder = dynamicTabs.map(tab => tab.id);
        if (!arraysEqual(tabOrder, normalizedOrder)) {
            setTabOrder(normalizedOrder);
        }
        saveTabOrder(normalizedOrder);
    }, [dynamicTabs, tabOrder]);

    useEffect(() => {
        selectedRef.current = selected as string;
    }, [selected]);

    useEffect(() => {
        pageListRef.current = clipboardPage.list;
    }, [clipboardPage]);

    useEffect(() => {
        hasMoreHistoryRef.current = hasMoreHistory;
    }, [hasMoreHistory]);

    useEffect(() => {
        isLoadingMoreRef.current = isLoadingMore;
    }, [isLoadingMore]);

    const hideCurrentWindowWithAnimation = async () => {
        setAnimationState('exiting');
        const generation = await invoke<number>('begin_hide_clipboard_window')
            .catch(e => {
                error(`Failed to mark clipboard hiding: ${e}`);
                return 0;
            });
        if (generation === 0) {
            setAnimationState('hidden');
            return;
        }
        await invoke('finish_hide_clipboard_window', { generation });
        setAnimationState('hidden');
    };

    const focusSearchInput = () => {
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
    };

    const showToast = (
        message: string,
        kind: ToastKind = 'info',
        durationMs: number = 2500,
        actionLabel?: string,
        onAction?: () => void,
    ) => {
        if (toastTimerRef.current !== null) {
            window.clearTimeout(toastTimerRef.current);
        }
        setToast({ id: Date.now(), message, kind, actionLabel, onAction });
        toastTimerRef.current = window.setTimeout(() => {
            setToast(null);
            toastTimerRef.current = null;
        }, durationMs);
    };

    const loadItemTags = async (): Promise<ItemTag[]> => {
        try {
            const tags = await invoke<ItemTag[]>('list_item_tags');
            setItemTags(tags);
            return tags;
        } catch (e) {
            error(`Failed to load item tags: ${e}`);
            return itemTags;
        }
    };

    const openRecordTagCreateEditorForItem = (item: Item) => {
        setContextMenu(null);
        setTabContextMenu(null);
        pendingRecordTagAssignTargetRef.current = item;
        openTabEditorWindow("add", "record", undefined, undefined, addTabButtonRef.current);
    };

    const appendTabOrderId = (tabId: string) => {
        setTabOrder(order => {
            const next = [...order.filter(id => id !== tabId), tabId];
            saveTabOrder(next);
            return next;
        });
    };

    const removeTabOrderId = (tabId: string) => {
        setTabOrder(order => {
            const next = order.filter(id => id !== tabId);
            saveTabOrder(next);
            return next;
        });
    };

    const updateItemTagsInPage = (item: Item, nextTags: ItemTag[]) => {
        const hash = item.getHash() as string;
        const activeRecordTagId = recordTagIdFromTab(activeTabRef.current);
        setPage(page => {
            let nextList = page.list.map(candidate =>
                candidate.getHash() === hash ? candidate.withTags(nextTags) : candidate
            );
            if (activeRecordTagId !== null && !nextTags.some(tag => tag.id === activeRecordTagId)) {
                nextList = nextList.filter(candidate => candidate.getHash() !== hash);
            }
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const removeRecordTagFromPageItems = (tagId: number) => {
        setPage(page => {
            const nextList = page.list.map(item => {
                const nextTags = item.getTags().filter(tag => tag.id !== tagId);
                return nextTags.length === item.getTags().length ? item : item.withTags(nextTags);
            });
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const updateRecordTagOnPageItems = (updatedTag: ItemTag) => {
        setPage(page => {
            const nextList = page.list.map(item => {
                const nextTags = item.getTags().map(tag => tag.id === updatedTag.id ? updatedTag : tag);
                return nextTags.some((tag, index) => tag !== item.getTags()[index])
                    ? item.withTags(nextTags)
                    : item;
            });
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const assignPendingRecordTagToItem = async (tag: ItemTag) => {
        const target = pendingRecordTagAssignTargetRef.current;
        pendingRecordTagAssignTargetRef.current = null;
        if (!target) return;
        try {
            await invoke('assign_item_tag', { hash: target.getHash(), tagId: tag.id });
            updateItemTagsInPage(target, [...target.getTags().filter(candidate => candidate.id !== tag.id), tag]);
            showToast(t("tags.createdAndAssigned", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const applyItemTagsChanged = (payload: ItemTagsChangedPayload | null | undefined) => {
        if (payload?.tag) {
            setItemTags(tags => {
                const exists = tags.some(tag => tag.id === payload.tag?.id);
                return exists
                    ? tags.map(tag => tag.id === payload.tag?.id ? payload.tag as ItemTag : tag)
                    : [...tags, payload.tag as ItemTag];
            });
            updateRecordTagOnPageItems(payload.tag);
        }
        void loadItemTags();
        if (payload?.activeId) {
            appendTabOrderId(payload.activeId);
            activeTabRef.current = payload.activeId;
            setActiveTab(payload.activeId);
        }
        if (payload?.tag) {
            void assignPendingRecordTagToItem(payload.tag);
        }
    };

    const consumePendingItemTagsChanged = () => {
        const raw = localStorage.getItem(PENDING_ITEM_TAGS_CHANGED_KEY);
        if (!raw) return;
        localStorage.removeItem(PENDING_ITEM_TAGS_CHANGED_KEY);
        try {
            applyItemTagsChanged(JSON.parse(raw) as ItemTagsChangedPayload);
        } catch (e) {
            error(`Failed to consume pending item tag change: ${e}`);
            void loadItemTags();
        }
    };

    const deleteRecordTag = async (tag: ItemTag) => {
        try {
            await invoke('delete_item_tag', { id: tag.id });
            removeTabOrderId(recordTagTabId(tag.id));
            setItemTags(tags => tags.filter(candidate => candidate.id !== tag.id));
            removeRecordTagFromPageItems(tag.id);
            if (activeTabRef.current === recordTagTabId(tag.id)) {
                activeTabRef.current = "all";
                setActiveTab("all");
            }
            void loadItemTags();
            setDeleteConfirmRecordTag(null);
            setTabContextMenu(null);
            showToast(t("tags.deleted", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const checkPasteAccessibilityPermission = async (): Promise<boolean> => {
        try {
            const status = await invoke<PasteAccessibilityPermissionStatus>('check_paste_accessibility_permission');
            return status.granted;
        } catch (e) {
            error(`Failed to check Accessibility permission: ${e}`);
            return false;
        }
    };

    const loadBehaviorConfig = async (): Promise<ClipboardBehaviorConfig> => {
        try {
            const config = JSON.parse(await invoke<string>('get_config'));
            return config as ClipboardBehaviorConfig;
        } catch (e) {
            error(`Failed to load clipboard behavior config: ${e}`);
            return {};
        }
    };

    const refreshTutorialPermissionStatus = async (): Promise<TutorialPermissionStatus | null> => {
        try {
            const status = await invoke<TutorialPermissionStatus>('get_onboarding_permission_status');
            setTutorialPermissionStatus(status);
            return status;
        } catch (e) {
            error(`Failed to refresh tutorial permission status: ${e}`);
            return null;
        }
    };

    const refreshTutorialConfig = async () => {
        const config = await loadBehaviorConfig();
        setMainShortcut(config.shortcut_keys?.main_window || DEFAULT_MAIN_SHORTCUT);
        return config;
    };

    const startTutorial = async (platform: TutorialPlatform = isMacPlatform() ? "mac" : "windows") => {
        setContextMenu(null);
        setTabContextMenu(null);
        setTagCreateChoice(null);
        setDeleteConfirmTab(null);
        setDeleteConfirmRecordTag(null);
        setSearchWord("");
        setSearchOpen(false);
        hideAltHints();
        activeTabRef.current = "all";
        setActiveTab("all");
        clearCardsClickSuppression();
        setTutorialPlatform(platform);
        setTutorialRunId(id => id + 1);
        setTutorialActive(true);
        void refreshTutorialConfig();
        if (platform === "mac") {
            setTutorialPermissionStatus(null);
            void refreshTutorialPermissionStatus();
        }
    };

    const handleTutorialPermissionAction = async (id: TutorialPermissionId) => {
        try {
            const themePreview = getThemePreview();
            const payload = { permission: id, languageCode, themePreview };
            localStorage.setItem(PENDING_PERMISSION_WINDOW_KEY, JSON.stringify(payload));
            await hideCurrentWindowWithAnimation();
            await invoke("open_onboarding_permission_window", payload);
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const makeTutorialFilterTab = (id: TutorialFilterId): CustomTab | null => {
        const meta = TUTORIAL_FILTER_TABS.find(tab => tab.id === id);
        if (!meta) return null;
        return {
            id: tutorialFilterTabId(id),
            name: `${meta.emoji} ${t(meta.titleKey)}`,
            filter: { ...DEFAULT_CUSTOM_FILTER, itemType: meta.itemType },
        };
    };

    const handleTutorialFilterToggle = (id: TutorialFilterId, enabled: boolean) => {
        const tabId = tutorialFilterTabId(id);
        const tab = makeTutorialFilterTab(id);
        if (!tab) return;

        setCustomTabs(tabs => {
            const exists = tabs.some(candidate => candidate.id === tabId);
            if (enabled && !exists) return [...tabs, tab];
            if (!enabled && exists) return tabs.filter(candidate => candidate.id !== tabId);
            return tabs;
        });

        if (enabled) {
            appendTabOrderId(tabId);
        } else {
            removeTabOrderId(tabId);
            if (activeTabRef.current === tabId) {
                activeTabRef.current = "all";
                setActiveTab("all");
            }
        }
    };

    const completeTutorial = async () => {
        try {
            await invoke("complete_onboarding");
            setTutorialActive(false);
            void fetchHistory();
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };
    const tabLabelForBackend = (tabId: string): string => {
        if (tabId === "favorite") return "__favorite";
        if (tabId === "all") return "__all";
        const recordTagId = recordTagIdFromTab(tabId);
        if (recordTagId !== null) {
            return `__filter:${JSON.stringify({ mode: "record-tag", record_tag_ids: [recordTagId] })}`;
        }
        const tab = customTabs.find(candidate => candidate.id === tabId);
        return tab ? customTabFilterPayload(tab) : "__all";
    };

    const openTagCreateChoice = (clientX: number, clientY: number) => {
        const position = floatingPositionFromClick(clientX, clientY, TAG_CREATE_CHOICE_WIDTH, TAG_CREATE_CHOICE_HEIGHT);
        setContextMenu(null);
        setTabContextMenu(null);
        setTagCreateChoice({ ...position, originX: clientX, originY: clientY });
    };

    const openTabEditorWindow = (mode: TabEditorMode, kind: TagEditorKind, tab?: CustomTab, recordTag?: ItemTag, anchor?: HTMLElement | null) => {
        const popupHeight = kind === "record" ? RECORD_TAG_EDITOR_HEIGHT : FILTER_TAG_EDITOR_HEIGHT;
        const position = screenFloatingPositionFromAnchor(anchor, TAB_EDITOR_WIDTH, popupHeight);
        const payload = JSON.stringify({ mode, kind, tab, recordTag, tabs: customTabs, languageCode });
        localStorage.setItem("vpaste.pendingTabEditorPayload", payload);
        void invoke('open_tab_editor_window', { x: position.x, y: position.y, width: TAB_EDITOR_WIDTH, height: popupHeight, payload })
            .catch(e => {
                error(`Failed to open tab editor window: ${e}`);
                showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
            });
    };

    const openTabEditorWindowAt = (mode: TabEditorMode, kind: TagEditorKind, tab: CustomTab | undefined, recordTag: ItemTag | undefined, clientX: number, clientY: number) => {
        const popupHeight = kind === "record" ? RECORD_TAG_EDITOR_HEIGHT : FILTER_TAG_EDITOR_HEIGHT;
        const payload = JSON.stringify({ mode, kind, tab, recordTag, tabs: customTabs, languageCode });
        localStorage.setItem("vpaste.pendingTabEditorPayload", payload);
        const position = screenAnchoredPositionFromClick(clientX, clientY, TAB_EDITOR_WIDTH, popupHeight);
        void invoke('open_tab_editor_window', {
            x: position.x,
            y: position.y,
            width: TAB_EDITOR_WIDTH,
            height: popupHeight,
            payload,
        }).catch(e => {
            error(`Failed to open tab editor window: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        });
    };

    const openEditTabEditor = (tab: CustomTab, anchor?: HTMLElement | null) => {
        openTabEditorWindow("edit", "filter", tab, undefined, anchor);
    };

    const openEditRecordTagEditor = (tag: ItemTag, anchor?: HTMLElement | null) => {
        openTabEditorWindow("edit", "record", undefined, tag, anchor);
    };

    const deleteCustomTab = (tab: CustomTab) => {
        removeTabOrderId(tab.id);
        setCustomTabs(tabs => tabs.filter(candidate => candidate.id !== tab.id));
        if (activeTabRef.current === tab.id) {
            activeTabRef.current = "all";
            setActiveTab("all");
        }
        setDeleteConfirmTab(null);
        setTabContextMenu(null);
    };

    const handleTabDrop = (targetId: string) => {
        if (!draggingTabId || draggingTabId === targetId) return;
        setTabOrder(order => {
            const currentOrder = orderedDynamicTabs(customTabs, itemTags, order).map(tab => tab.id);
            const sourceIndex = currentOrder.indexOf(draggingTabId);
            const targetIndex = currentOrder.indexOf(targetId);
            if (sourceIndex === -1 || targetIndex === -1) return order;
            const next = [...currentOrder];
            const [moved] = next.splice(sourceIndex, 1);
            next.splice(targetIndex, 0, moved);
            saveTabOrder(next);
            return next;
        });
        setDraggingTabId("");
    };

    const scheduleFileRefresh = (delay: number = 320) => {
        if (scrollRefreshTimerRef.current !== null) {
            window.clearTimeout(scrollRefreshTimerRef.current);
        }
        scrollRefreshTimerRef.current = window.setTimeout(() => {
            setFileRefreshKey(key => key + 1);
            scrollRefreshTimerRef.current = null;
        }, delay);
    };

    const scrollCardIntoView = (index: number, behavior: ScrollBehavior = 'auto') => {
        stopWheelScroll();
        const container = cardsContainerRef.current;
        const cards = container?.querySelectorAll<HTMLElement>(`.${styles["clipboard-card"]}`);
        const card = cards?.item(index);
        if (!container || !card) return;

        const cardLeft = card.offsetLeft;
        const cardRight = cardLeft + card.offsetWidth;
        const visibleLeft = container.scrollLeft;
        const visibleRight = visibleLeft + container.clientWidth;
        const edgePadding = 24;
        let nextScrollLeft = visibleLeft;

        if (cardLeft - edgePadding < visibleLeft) {
            nextScrollLeft = Math.max(0, cardLeft - edgePadding);
        } else if (cardRight + edgePadding > visibleRight) {
            nextScrollLeft = cardRight + edgePadding - container.clientWidth;
        }

        if (nextScrollLeft !== visibleLeft) {
            container.scrollTo({ left: nextScrollLeft, behavior });
            maybeLoadMoreHistory();
        }
    };

    const selectCardAt = (index: number, behavior: ScrollBehavior = 'auto'): Item | null => {
        const list = pageListRef.current;
        if (list.length === 0) {
            setSelected("");
            selectedRef.current = "";
            return null;
        }
        const nextIndex = Math.max(0, Math.min(index, list.length - 1));
        const item = list[nextIndex];
        const nextHash = item.getHash() as string;
        selectedRef.current = nextHash;
        setSelected(nextHash);
        scrollCardIntoView(nextIndex, behavior);
        return item;
    };

    const isPreviewableDomainLink = (url: string) => {
        try {
            const parsed = new URL(url.trim());
            if (parsed.protocol !== "https:") return false;
            const host = parsed.hostname;
            if (!host.includes(".")) return false;
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
            return /^[a-z0-9.-]+$/i.test(host);
        } catch {
            return false;
        }
    };

    const scheduleLinkPreviewRefresh = (items: Item[]) => {
        if (!linkAutoPreviewRef.current || linkPreviewRefreshingRef.current) return;
        const urls = items
            .filter(item => item.getType() === ItemType.Link)
            .slice(0, 10)
            .map(item => parseLinkContent(item.getContent()).url)
            .filter(isPreviewableDomainLink);

        if (urls.length === 0) return;

        linkPreviewRefreshingRef.current = true;
        void invoke<LinkPreviewUpdate[]>("refresh_link_previews", { urls })
            .then(updates => {
                if (updates.length > 0) {
                    window.setTimeout(() => {
                        void fetchHistoryWith(searchWordRef.current, activeTabRef.current, { background: true });
                    }, 220);
                }
            })
            .catch(e => error(`Failed to refresh link previews: ${e}`))
            .finally(() => {
                linkPreviewRefreshingRef.current = false;
            });
    };

    const scheduleImageClipboardCachePrewarm = (items: Item[]) => {
        const paths = items
            .filter(item => item.getType() === ItemType.Image)
            .map(item => item.getContent())
            .filter(path => path && !imageClipboardCachePrewarmRef.current.has(path))
            .slice(0, 18);

        if (paths.length === 0) return;
        paths.forEach(path => imageClipboardCachePrewarmRef.current.add(path));
        if (imagePrewarmTimerRef.current !== null) {
            window.clearTimeout(imagePrewarmTimerRef.current);
        }
        imagePrewarmTimerRef.current = window.setTimeout(() => {
            imagePrewarmTimerRef.current = null;
            const firstWave = paths.slice(0, 8);
            const secondWave = paths.slice(8, 18);
            void Promise.all([
                invoke("prewarm_image_preview_cache", { paths: firstWave }),
                invoke("prewarm_image_clipboard_cache", { paths: firstWave.slice(0, 4) }),
            ])
                .catch(e => {
                    firstWave.forEach(path => imageClipboardCachePrewarmRef.current.delete(path));
                    error(`Failed to prewarm image caches: ${e}`);
                });
            if (secondWave.length > 0) {
                window.setTimeout(() => {
                    void invoke("prewarm_image_preview_cache", { paths: secondWave })
                        .catch(e => {
                            secondWave.forEach(path => imageClipboardCachePrewarmRef.current.delete(path));
                            error(`Failed to prewarm deferred image previews: ${e}`);
                        });
                }, 1400);
            }
        }, 900);
    };

    async function fetchHistoryWith(keywords: string, tab: string, options: { selectFirst?: boolean, background?: boolean } = {}) {
        const requestSeq = ++searchRequestSeqRef.current;
        try {
            const tagSearch = parseTagSearch(keywords);
            const label = mergeTagSearchFilter(tabLabelForBackend(tab), tagSearch.tagNames);
            const page = await fetchSearchPage(
                tagSearch.keywords,
                label,
                0,
                0,
                HISTORY_PAGE_LIMIT,
                () => requestSeq === searchRequestSeqRef.current,
            );
            if (!page) return;
            const items = page.items;
            pageListRef.current = items;
            lastHistoryFetchRef.current = { keywords, tab };
            setPage(new ClipboardPage(items, page.consumed));
            setHasMoreHistory(page.hasMore);
            const selectedIndex = items.findIndex((item: Item) => item.getHash() === selectedRef.current);
            if (options.selectFirst || selectedIndex === -1) {
                const firstHash = items[0]?.getHash() as string | undefined;
                selectedRef.current = firstHash || "";
                setSelected(firstHash || "");
                if (firstHash) {
                    scrollCardIntoView(0);
                }
            } else if (selectedIndex >= 0) {
                scrollCardIntoView(selectedIndex);
            }
            if (!options.background) {
                scheduleLinkPreviewRefresh(items);
                scheduleImageClipboardCachePrewarm(items);
            }
        } catch (e) {
            error(`Failed to fetch history: ${e}`);
        }
    }

    const loadMoreHistory = async () => {
        const currentList = pageListRef.current;
        if (isLoadingMoreRef.current || !hasMoreHistoryRef.current || currentList.length === 0) {
            return;
        }

        const lastItem = currentList[currentList.length - 1];
        setIsLoadingMore(true);
        isLoadingMoreRef.current = true;
        try {
            const requestSeq = searchRequestSeqRef.current;
            const tagSearch = parseTagSearch(searchWordRef.current);
            const label = mergeTagSearchFilter(tabLabelForBackend(activeTabRef.current), tagSearch.tagNames);
            const page = await fetchSearchPage(
                tagSearch.keywords,
                label,
                lastItem.getId(),
                lastItem.getTime(),
                HISTORY_PAGE_LIMIT,
                () => requestSeq === searchRequestSeqRef.current,
            );
            if (!page) return;
            const nextItems = page.items;
            const existingHashes = new Set(currentList.map(item => item.getHash()));
            const merged = currentList.concat(nextItems.filter((item: Item) => !existingHashes.has(item.getHash())));
            pageListRef.current = merged;
            setPage(new ClipboardPage(merged, page.consumed));
            setHasMoreHistory(page.hasMore);
            scheduleImageClipboardCachePrewarm(nextItems);
        } catch (e) {
            error(`Failed to load more history: ${e}`);
        } finally {
            setIsLoadingMore(false);
            isLoadingMoreRef.current = false;
        }
    };

    const maybeLoadMoreHistory = (force: boolean = false) => {
        const now = performance.now();
        if (!force && now - lastLoadMoreCheckRef.current < 120) {
            return;
        }
        lastLoadMoreCheckRef.current = now;
        const container = cardsContainerRef.current;
        if (!container) return;
        const distanceToEnd = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (distanceToEnd < 360) {
            void loadMoreHistory();
        }
    };
    maybeLoadMoreHistoryRef.current = maybeLoadMoreHistory;

    const fetchHistory = async () => {
        await fetchHistoryWith(searchWordRef.current, activeTabRef.current);
    };

    const applyShowPreferences = async () => {
        const config = await loadBehaviorConfig();
        pasteAsTextShortcutRef.current = config.shortcut_keys?.paste_into_plain_text || DEFAULT_PASTE_AS_TEXT_SHORTCUT;
        quickInputEnabledRef.current = config.quick_input_enabled !== false;
        if (!quickInputEnabledRef.current) {
            hideAltHints();
        }
        tabQuickSelectEnabledRef.current = config.tab_quick_select_enabled !== false;
        linkAutoPreviewRef.current = config.link_auto_preview !== false;
        const nextSearchWord = config.retain_search_history ? searchWordRef.current : "";
        const nextActiveTab = config.retain_tab_position ? activeTabRef.current : "all";

        if (!config.retain_search_history) {
            setSearchWord("");
            setSearchOpen(false);
        }

        if (!config.retain_tab_position) {
            activeTabRef.current = "all";
            setActiveTab("all");
        }

        if (!config.retain_last_position) {
            if (cardsContainerRef.current) {
                cardsContainerRef.current.scrollLeft = 0;
            }
            selectFirstLoadedItem(true);
        } else if (!selectedRef.current) {
            selectFirstLoadedItem(false);
        }

        const cachedFetch = lastHistoryFetchRef.current;
        if (
            cachedFetch?.keywords === nextSearchWord
            && cachedFetch?.tab === nextActiveTab
            && pageListRef.current.length > 0
        ) {
            return;
        }

        await fetchHistoryWith(nextSearchWord, nextActiveTab, { selectFirst: !config.retain_last_position });
    };

    useClipboardLifecycleSubscriptions({
        tauri: {
            onWindowShow: payload => {
                resetCardsPointerState();
                selectFirstLoadedItem(true);
                void applyShowPreferences();
                if (payload) {
                    window.requestAnimationFrame(() => {
                        const card = document
                            .elementFromPoint(payload.x, payload.y)
                            ?.closest<HTMLElement>(`.${styles["clipboard-card"]}`);
                        setSimulatedHoverHash(card?.dataset.hash || "");
                    });
                } else {
                    setSimulatedHoverHash("");
                }
                syncAltHintsFromNative();
                window.setTimeout(syncAltHintsFromNative, 70);
                window.setTimeout(syncAltHintsFromNative, 160);
                scheduleFileRefresh(CLIPBOARD_SHOW_REFRESH_DELAY_MS);
                setAnimationState("entering");
            },
            onWindowShowComplete: () => {
                setAnimationState("entered");
            },
            onWindowHide: () => {
                resetCardsPointerState();
                searchRequestSeqRef.current += 1;
                if (scrollRefreshTimerRef.current !== null) {
                    window.clearTimeout(scrollRefreshTimerRef.current);
                    scrollRefreshTimerRef.current = null;
                }
                if (imagePrewarmTimerRef.current !== null) {
                    window.clearTimeout(imagePrewarmTimerRef.current);
                    imagePrewarmTimerRef.current = null;
                }
                hideAltHints();
                setAnimationState("exiting");
            },
            onWindowHidden: () => {
                setAnimationState("hidden");
            },
            onClipboardChanged: () => {
                void fetchHistory();
            },
            onTutorialStarted: () => {
                void startTutorial();
            },
            onTutorialCompleted: () => {
                setTutorialActive(false);
            },
            onPermissionStatusChanged: () => {
                void refreshTutorialPermissionStatus();
            },
            onCustomTabsChanged: payload => {
                const tabs = Array.isArray(payload.tabs) ? payload.tabs : loadCustomTabs();
                persistCustomTabs(tabs);
                setCustomTabs(tabs);
                if (payload.activeId) {
                    appendTabOrderId(payload.activeId);
                    activeTabRef.current = payload.activeId;
                    setActiveTab(payload.activeId);
                }
                void fetchHistoryWith(searchWordRef.current, activeTabRef.current);
            },
            onItemTagsChanged: payload => {
                localStorage.removeItem(PENDING_ITEM_TAGS_CHANGED_KEY);
                applyItemTagsChanged(payload);
            },
            onPreviewNavigation: payload => {
                if (payload.key === "Tab" && !tabQuickSelectEnabledRef.current) return;
                navigateSelectedCard(payload.direction === -1 ? -1 : 1);
            },
        },
        browser: {
            onMouseMove: () => setSimulatedHoverHash(""),
            onFocus: () => {
                consumePendingItemTagsChanged();
                if (isMacPlatform()) {
                    void refreshTutorialPermissionStatus();
                }
            },
            onVisibilityChange: () => {
                if (document.visibilityState === "visible" && isMacPlatform()) {
                    void refreshTutorialPermissionStatus();
                }
            },
            onStorage: event => {
                if (event.key === PENDING_ITEM_TAGS_CHANGED_KEY && event.newValue) {
                    consumePendingItemTagsChanged();
                }
            },
            onBlur: () => {
                setContextMenu(null);
                setTabContextMenu(null);
                window.setTimeout(() => {
                    void invoke("hide_clipboard_if_inactive")
                        .catch(e => error(`Failed to hide inactive clipboard window: ${e}`));
                }, 60);
            },
            onDismissMenus: () => {
                setContextMenu(null);
                setTabContextMenu(null);
                setTagCreateChoice(null);
            },
        },
        onMount: () => {
            if (isMacPlatform()) {
                void refreshTutorialPermissionStatus();
            }
            void loadBehaviorConfig()
                .then(config => {
                    if (config.onboarding_completed === false && !tutorialActiveRef.current) {
                        void startTutorial();
                    }
                })
                .catch(e => error(`Failed to check tutorial state: ${e}`));
        },
        onBeforeCleanup: () => {
            if (toastTimerRef.current !== null) {
                window.clearTimeout(toastTimerRef.current);
            }
            if (scrollRefreshTimerRef.current !== null) {
                window.clearTimeout(scrollRefreshTimerRef.current);
            }
            if (imagePrewarmTimerRef.current !== null) {
                window.clearTimeout(imagePrewarmTimerRef.current);
            }
            if (searchDebounceTimerRef.current !== null) {
                window.clearTimeout(searchDebounceTimerRef.current);
            }
            clearAltHintTimer();
        },
        onUnlistenError: (label, unlistenError) => {
            error(`Failed to unlisten ${label}: ${unlistenError}`);
        },
    });

    useEffect(() => {
        if (searchDebounceTimerRef.current !== null) {
            window.clearTimeout(searchDebounceTimerRef.current);
        }
        const keywords = searchWord as string;
        const delay = keywords.trim() ? 120 : 40;
        searchDebounceTimerRef.current = window.setTimeout(() => {
            searchDebounceTimerRef.current = null;
            void fetchHistoryWith(keywords, activeTabRef.current, { selectFirst: true });
        }, delay);
        return () => {
            if (searchDebounceTimerRef.current !== null) {
                window.clearTimeout(searchDebounceTimerRef.current);
                searchDebounceTimerRef.current = null;
            }
        };
    }, [searchWord]);

    useEffect(() => {
        void fetchHistoryWith(searchWordRef.current, activeTab, { selectFirst: true });
    }, [activeTab, customTabs]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const action = clipboardKeyDownAction(event, {
                contextMenuOpen: contextMenu !== null,
                isMac: isMacPlatform(),
                pasteAsTextShortcut: pasteAsTextShortcutRef.current,
                quickInputEnabled: quickInputEnabledRef.current,
                searchHasText: Boolean(searchWord),
                searchInput: searchInputRef.current,
                searchOpen,
                tabQuickSelectEnabled: tabQuickSelectEnabledRef.current,
            });
            if (!action) return;

            event.preventDefault();
            if ("stopPropagation" in action && action.stopPropagation) {
                event.stopPropagation();
            }

            switch (action.type) {
                case "alt-press":
                    if (action.showHints) {
                        showAltHintsWhilePressed();
                    }
                    return;
                case "quick-tab":
                    switchToTabWithShortcut(action.tabId);
                    return;
                case "quick-item":
                    activateItemShortcut(action.index);
                    return;
                case "focus-search":
                    focusSearchInput();
                    return;
                case "submit-search": {
                    const firstHash = pageListRef.current[0]?.getHash() as string | undefined;
                    if (firstHash) {
                        void clickClipboardItem(firstHash, false);
                    }
                    return;
                }
                case "dismiss-search":
                    if (action.clear) {
                        setSearchWord("");
                    } else {
                        setSearchOpen(false);
                    }
                    return;
                case "move-context-menu-selection": {
                    if (!contextMenu) return;
                    const options = buildContextMenuOptions(
                        contextMenu.item,
                        contextMenu.itemTags,
                        contextMenu.colorOptions,
                    );
                    setContextMenuIndex(index => {
                        if (options.length === 0) return 0;
                        return (index + action.direction + options.length) % options.length;
                    });
                    return;
                }
                case "activate-context-menu-option": {
                    if (!contextMenu) return;
                    const options = buildContextMenuOptions(
                        contextMenu.item,
                        contextMenu.itemTags,
                        contextMenu.colorOptions,
                    );
                    const option = options[Math.max(0, Math.min(contextMenuIndex, options.length - 1))];
                    if (option?.action) {
                        void option.action();
                    }
                    return;
                }
                case "close-context-menu":
                    setContextMenu(null);
                    return;
                case "hide-window":
                    setContextMenu(null);
                    void hideCurrentWindowWithAnimation();
                    return;
                case "navigate-selection":
                    setContextMenu(null);
                    navigateSelectedCard(action.direction);
                    return;
                case "open-selected-context-menu":
                    openSelectedContextMenu();
                    return;
                case "toggle-preview":
                    setContextMenu(null);
                    invoke<boolean>('is_preview_window_visible')
                        .then(visible => {
                            if (visible) {
                                previewRequestSeqRef.current += 1;
                                return invoke('hide_preview_window');
                            }
                            const selectedItem = pageListRef.current.find(
                                item => item.getHash() === selectedRef.current,
                            ) || pageListRef.current[0];
                            if (selectedItem) {
                                return openPreviewItem(selectedItem);
                            }
                        })
                        .catch(e => error(`Failed to toggle preview: ${e}`));
                    return;
                case "paste-selected":
                    setContextMenu(null);
                    if (action.plainText) {
                        const selectedItem = pageListRef.current.find(
                            item => item.getHash() === selectedRef.current,
                        ) || pageListRef.current[0];
                        if (selectedItem) {
                            void clickClipboardItem(selectedItem.getHash(), true);
                        }
                        return;
                    }
                    {
                        const selectedHash = selectedRef.current
                            || (pageListRef.current[0]?.getHash() as string | undefined);
                        if (selectedHash) {
                            void clickClipboardItem(selectedHash, false);
                        }
                    }
                    return;
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.key === 'Alt') {
                event.preventDefault();
                hideAltHints();
            }
        };

        const handleBlur = () => {
            hideAltHints();
        };

        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('keyup', handleKeyUp, true);
        window.addEventListener('blur', handleBlur);
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('keyup', handleKeyUp, true);
            window.removeEventListener('blur', handleBlur);
        };
    }, [searchOpen, searchWord, contextMenu, contextMenuIndex, t]);

    const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setSearchWord(event.target.value);
    };

    const waitForQuickInputModifierRelease = async (triggerKey: string, timeoutMs: number = 3000): Promise<boolean> => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            try {
                const pressed = await invoke<boolean>('is_quick_input_modifier_pressed', { triggerKey });
                if (!pressed) return true;
            } catch (e) {
                error(`Failed to wait for quick input modifier release: ${e}`);
                return false;
            }
            await new Promise(resolve => window.setTimeout(resolve, 16));
        }
        return false;
    };

    const finishCopyWithoutAutoPaste = async () => {
        await invoke('show_paste_fallback_notice')
            .catch(e => error(`Failed to show paste fallback notice: ${e}`));
        try {
            await hideCurrentWindowWithAnimation();
        } finally {
            await invoke('restore_foreground_app')
                .catch(e => error(`Failed to restore foreground app: ${e}`));
        }
    };

    const clickClipboardItem = async (hash: string, plainText: boolean = false, restoreAlt: boolean = false, triggerKey: string = "") => {
        const hasPermission = await checkPasteAccessibilityPermission();
        const item = pageListRef.current.find(i => i.getHash() === hash);
        if (item) {
            selectedRef.current = hash;
            setSelected(hash);
            let content = item.getContent();
            let itemType = getBackendTypeLabel(item.getType());
            if (plainText && item.getTextContent()) {
                content = item.getTextContent();
                itemType = "Text";
            } else if (item.getType() === ItemType.TextFile) {
                content = await invoke<string>('plain_text_content', { hash: item.getHash() });
                itemType = "Text";
            } else if (item.getType() === ItemType.Link) {
                content = content.split('|||')[0];
            } else if (item.getType() === ItemType.File) {
                const missingPaths = await invoke<string[]>('validate_file_item', { content });
                if (missingPaths.length > 0) {
                    const message = missingPaths.length === 1
                        ? t("clipboard.sourceMissingOne", { path: compactPath(missingPaths[0], 46) })
                        : t("clipboard.sourceMissingMany", { path: compactPath(missingPaths[0], 42) });
                    showToast(message, 'warning');
                    return;
                }
            }

            try {
                const copyHash = plainText ? null : hash;
                if (restoreAlt) {
                    await waitForQuickInputModifierRelease(triggerKey);
                }
                if (itemType === "Image" && hasPermission) {
                    const hidePromise = hideCurrentWindowWithAnimation();
                    await invoke('copy', { item: content, itemType, hash: copyHash });
                    await hidePromise;
                } else {
                    await invoke('copy', { item: content, itemType, hash: copyHash });
                    if (hasPermission) {
                        await hideCurrentWindowWithAnimation();
                    }
                }
                if (!hasPermission) {
                    await finishCopyWithoutAutoPaste();
                    return;
                }
                await invoke('paste', { hash, restoreAlt, triggerKey });
                await fetchHistoryWith(searchWordRef.current, activeTabRef.current);
            } catch (e) {
                error(`Failed to copy/paste: ${e}`);
                showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
            }
        }
    };

    activateClipboardCardRef.current = (hash: string, plainText: boolean) => {
        void clickClipboardItem(hash, plainText);
    };

    const pastePlainTextItem = async (item: Item) => {
        const hasPermission = await checkPasteAccessibilityPermission();
        setContextMenu(null);
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash());
        try {
            const text = await invoke<string>('plain_text_content', { hash: item.getHash() });
            await invoke('copy', { item: text, itemType: 'Text', hash: null });
            if (!hasPermission) {
                await finishCopyWithoutAutoPaste();
                return;
            }
            await hideCurrentWindowWithAnimation();
            await invoke<unknown>('paste', { hash: item.getHash(), triggerKey: "" });
        } catch (e) {
            error(`Failed to paste plain text: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const openContextMenu = async (item: Item, clientX: number, clientY: number) => {
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash());
        const currentItemTags = await loadItemTags();
        const colorOptions = item.getType() === ItemType.Color
            ? await invoke<ColorCopyOption[]>('color_conversion_options', { content: item.getContent() }).catch(e => {
                error(`Failed to load color conversion options: ${e}`);
                return [];
            })
            : [];
        const options = buildContextMenuOptions(item, currentItemTags, colorOptions);
        const menuHeight = contextMenuHeight(options.length);
        const { x, y } = floatingPositionFromClick(clientX, clientY, CONTEXT_MENU_WIDTH, menuHeight);
        const submenuSide = x + CONTEXT_MENU_WIDTH + CONTEXT_MENU_GAP + CONTEXT_SUBMENU_WIDTH <= window.innerWidth - VIEWPORT_MARGIN
            ? "right"
            : "left";
        setContextMenuIndex(0);
        setContextMenu({
            item,
            x,
            y,
            originX: clientX,
            originY: clientY,
            submenuSide,
            itemTags: currentItemTags,
            colorOptions,
        });
    };

    openClipboardContextMenuRef.current = openContextMenu;

    const openSelectedContextMenu = () => {
        const item = pageListRef.current.find(i => i.getHash() === selectedRef.current)
            || pageListRef.current[0];
        if (!item) return;

        const cards = cardsContainerRef.current?.querySelectorAll<HTMLElement>(`.${styles["clipboard-card"]}`);
        const index = pageListRef.current.findIndex(i => i.getHash() === item.getHash());
        const rect = cards?.item(Math.max(0, index))?.getBoundingClientRect();
        if (rect) {
            void openContextMenu(item, rect.left + 14, rect.top + 40);
        } else {
            void openContextMenu(item, Math.round(window.innerWidth / 2 - 94), 64);
        }
    };

    const openPreviewItem = async (item: Item, requestSeq: number = ++previewRequestSeqRef.current) => {
        setContextMenu(null);
        if (item.getType() === ItemType.File) {
            try {
                const info = await invoke<FilePreviewInfo>("file_preview_info", { content: item.getContent() });
                if (requestSeq !== previewRequestSeqRef.current) return;
                const previewableFile = (info.kind === "single-preview" && !!info.preview_path)
                    || info.kind === "pdf-preview"
                    || info.kind === "text-preview";
                const simpleFileInfo = info.kind === "multiple" || info.kind === "single-folder" || info.kind === "single-icon";
                if (!previewableFile && !simpleFileInfo) {
                    showToast(t("clipboard.previewUnsupported"), 'warning');
                    return;
                }
            } catch (e) {
                error(`Failed to prepare file preview: ${e}`);
                showToast(t("clipboard.previewUnsupported"), 'warning');
                return;
            }
        }
        if (requestSeq !== previewRequestSeqRef.current) return;
        selectedRef.current = item.getHash() as string;
        setSelected(item.getHash());
        try {
            await invoke('show_preview_window', {
                itemType: item.getType(),
                content: item.getContent(),
                previewContent: item.getPreviewContent(),
                textContent: item.getTextContent(),
                richHtml: item.getRichHtml(),
                appSource: item.getAppSource(),
            });
        } catch (e) {
            error(`Failed to open preview: ${e}`);
            showToast(t("clipboard.previewFailed", { error: String(e) }), 'error');
        }
    };

    const refreshPreviewIfVisible = (item: Item) => {
        const requestSeq = ++previewRequestSeqRef.current;
        void invoke<boolean>('is_preview_window_visible')
            .then(visible => {
                if (!visible || requestSeq !== previewRequestSeqRef.current) return;
                return openPreviewItem(item, requestSeq);
            })
            .catch(e => error(`Failed to refresh preview after selection: ${e}`));
    };

    const navigateSelectedCard = (direction: number) => {
        const list = pageListRef.current;
        if (list.length === 0) return;
        const currentIndex = list.findIndex(item => item.getHash() === selectedRef.current);
        const item = selectCardAt(currentIndex === -1 ? 0 : currentIndex + direction);
        if (item) {
            refreshPreviewIfVisible(item);
        }
    };

    const toggleFavorite = async (item: Item) => {
        setContextMenu(null);
        const favorite = !item.isFavorite();
        try {
            await invoke('set_item_favorite', { hash: item.getHash(), favorite });
            showToast(favorite ? t("clipboard.favoriteAdded") : t("clipboard.favoriteRemoved"));
            await fetchHistory();
        } catch (e) {
            error(`Failed to update favorite: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const assignExistingTag = async (item: Item, tag: ItemTag) => {
        setContextMenu(null);
        try {
            await invoke('assign_item_tag', { hash: item.getHash(), tagId: tag.id });
            updateItemTagsInPage(item, [...item.getTags().filter(candidate => candidate.id !== tag.id), tag]);
            showToast(t("tags.assigned", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const removeAllAssignedTags = async (item: Item) => {
        setContextMenu(null);
        try {
            await Promise.all(item.getTags().map(tag =>
                invoke('remove_item_tag', { hash: item.getHash(), tagId: tag.id })
            ));
            updateItemTagsInPage(item, []);
            showToast(t("tags.removedAll"));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const removeAssignedTag = async (item: Item, tag: ItemTag) => {
        setContextMenu(null);
        try {
            await invoke('remove_item_tag', { hash: item.getHash(), tagId: tag.id });
            updateItemTagsInPage(item, item.getTags().filter(candidate => candidate.id !== tag.id));
            showToast(t("tags.removed", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const deleteClipboardItem = async (item: Item) => {
        setContextMenu(null);
        const hash = item.getHash() as string;
        try {
            await invoke('delete_clipboard_item', { hash });
            const currentList = pageListRef.current;
            const deletedIndex = currentList.findIndex(candidate => candidate.getHash() === hash);
            const nextList = currentList.filter(candidate => candidate.getHash() !== hash);
            pageListRef.current = nextList;
            setPage(new ClipboardPage(nextList, clipboardPage.consumed));
            if (selectedRef.current === hash) {
                const nextIndex = Math.max(0, Math.min(deletedIndex, nextList.length - 1));
                const nextHash = nextList[nextIndex]?.getHash() as string | undefined;
                selectedRef.current = nextHash || "";
                setSelected(nextHash || "");
                if (nextHash) {
                    window.requestAnimationFrame(() => scrollCardIntoView(nextIndex));
                }
            }
            showToast(t("clipboard.recordDeleted"));
        } catch (e) {
            error(`Failed to delete clipboard item: ${e}`);
            showToast(t("clipboard.deleteFailed", { error: String(e) }), 'error');
        }
    };

    const exportImageItem = async (item: Item) => {
        setContextMenu(null);
        const sourcePath = imageExportSourcePath(item);
        if (!sourcePath) {
            showToast(t("clipboard.actionFailed", { error: t("clipboard.exportImageNoSource") }), "error");
            return;
        }

        try {
            const cachedDir = localStorage.getItem(IMAGE_EXPORT_DIR_KEY) || "";
            const fallbackDir = isMacPlatform() ? await downloadDir() : await desktopDir();
            const defaultDir = cachedDir || fallbackDir;
            const defaultPath = joinPath(defaultDir, `vpaste-image-${Date.now()}.png`);
            await invoke("set_clipboard_blur_hide_suppressed", { suppressed: true })
                .catch(e => error(`Failed to suppress clipboard blur hide: ${e}`));
            const targetPath = await save({
                defaultPath,
                filters: [
                    { name: "PNG Image", extensions: ["png"] },
                    { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
                    { name: "WebP Image", extensions: ["webp"] },
                    { name: "Bitmap Image", extensions: ["bmp"] },
                ],
            }).finally(() => {
                void invoke("set_clipboard_blur_hide_suppressed", { suppressed: false })
                    .catch(e => error(`Failed to restore clipboard blur hide: ${e}`));
            });
            if (!targetPath) return;

            await invoke("export_image_item", { sourcePath, targetPath });
            const nextDir = dirName(targetPath);
            if (nextDir) {
                localStorage.setItem(IMAGE_EXPORT_DIR_KEY, nextDir);
            }
            try {
                await invoke("reveal_file_in_folder", { path: targetPath });
            } catch (revealError) {
                error(`Failed to reveal exported image file: ${revealError}`);
                showToast(t("clipboard.actionFailed", { error: String(revealError) }), "error");
                return;
            }
            await hideCurrentWindowWithAnimation();
            showToast(t("clipboard.imageExported"));
        } catch (e) {
            error(`Failed to export image item: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const openContainingFolder = async (item: Item) => {
        setContextMenu(null);
        try {
            await invoke('open_containing_folder', { content: item.getContent() });
        } catch (e) {
            error(`Failed to open containing folder: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const copyContainingFolderPath = async (item: Item) => {
        setContextMenu(null);
        try {
            const path = await invoke<string>('containing_folder_path', { content: item.getContent() });
            await invoke('copy', { item: path, itemType: 'Text', hash: null });
            await invoke('record_text_history', { content: path });
            await fetchHistory();
            showToast(t("clipboard.folderCopied"));
        } catch (e) {
            error(`Failed to copy containing folder path: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const copyColorValue = async (value: string) => {
        setContextMenu(null);
        try {
            await invoke('copy', { item: value, itemType: 'Text', hash: null });
            await invoke('record_text_history', { content: value });
            await fetchHistory();
            showToast(t("clipboard.colorCopied", { value }));
        } catch (e) {
            error(`Failed to copy converted color: ${e}`);
            showToast(t("clipboard.actionFailed", { error: String(e) }), 'error');
        }
    };

    const buildContextMenuOptions = (
        item: Item,
        currentItemTags: ItemTag[] = itemTags,
        colorOptions: ColorCopyOption[] = [],
    ) => buildClipboardContextMenuOptions({
        actions: {
            onAssignTag: assignExistingTag,
            onCopyColor: copyColorValue,
            onCopyContainingFolder: copyContainingFolderPath,
            onCreateRecordTag: openRecordTagCreateEditorForItem,
            onDelete: deleteClipboardItem,
            onExportImage: exportImageItem,
            onOpenContainingFolder: openContainingFolder,
            onPastePlainText: pastePlainTextItem,
            onPreview: openPreviewItem,
            onRemoveAllTags: removeAllAssignedTags,
            onRemoveTag: removeAssignedTag,
            onToggleFavorite: toggleFavorite,
        },
        colorOptions,
        currentItemTags,
        item,
        t,
    });

    const openConfigWindow = async () => {
        try {
            await hideCurrentWindowWithAnimation();
            await invoke('open_config_window');
        } catch (e) {
            error(`Failed to open config window: ${e}`);
        }
    };

    const openUpdateSettings = async () => {
        try {
            await hideCurrentWindowWithAnimation();
            await invoke('open_config_window', { target: 'about' });
        } catch (e) {
            error(`Failed to open update settings: ${e}`);
        }
    };

    const openUiLab = () => {
        if (!import.meta.env.DEV) return;
        const url = new URL("/__ui-lab", window.location.origin).toString();
        void invoke("open_url_in_browser", { url })
            .catch(e => error(`Failed to open UI lab: ${e}`));
    };

    const openTutorialFromDebug = (platform: TutorialPlatform) => {
        void startTutorial(platform);
    };

    const openPermissionCenter = async () => {
        try {
            await hideCurrentWindowWithAnimation();
            await invoke('open_config_window', { target: 'permissions' });
        } catch (e) {
            error(`Failed to open permission settings: ${e}`);
        }
    };

    const toggleDeveloperLanguage = () => {
        setPreviewLanguageCode(languageCode === "Chinese" ? "English" : "Chinese");
    };

    const toggleDeveloperTheme = () => {
        const nextTheme: ResolvedTheme = getResolvedTheme() === "dark" ? "light" : "dark";
        setThemePreview(nextTheme);
        setDeveloperTheme(nextTheme);
    };

    const blockTutorialNavigation = () => {
        showToast(t("tutorial.finishFirst"), "info", 2200);
    };

    const tutorialPermissions: TutorialPermission[] = [
        {
            id: "background",
            title: t("tutorial.permission.background"),
            description: t("tutorial.permission.background.desc"),
            done: tutorialPermissionStatus?.background.done === true,
            actionLabel: t("tutorial.permission.enable"),
        },
        {
            id: "paste",
            title: t("tutorial.permission.paste"),
            description: t("tutorial.permission.paste.desc"),
            done: tutorialPermissionStatus?.paste.done === true,
            actionLabel: t("tutorial.permission.openSettings"),
        },
    ];
    const tutorialFilters: TutorialFilterTab[] = TUTORIAL_FILTER_TABS.map(filter => ({
        id: filter.id,
        name: `${filter.emoji} ${t(filter.titleKey)}`,
        enabled: customTabs.some(tab => tab.id === tutorialFilterTabId(filter.id)),
    }));
    const tutorialShortcutText = formatShortcutLabel(mainShortcut, tutorialPlatform === "mac");

    const contextMenuOptions = contextMenu
        ? buildContextMenuOptions(contextMenu.item, contextMenu.itemTags, contextMenu.colorOptions)
        : [];
    const selectedContextOption = contextMenuOptions[Math.max(0, Math.min(contextMenuIndex, contextMenuOptions.length - 1))];
    const selectedSubmenuOptions = selectedContextOption?.children || [];
    const submenuHeight = contextMenuHeight(selectedSubmenuOptions.length);
    const submenuTop = contextMenu
        ? clampToViewport(
            contextMenu.y + CONTEXT_MENU_PADDING + contextMenuIndex * CONTEXT_MENU_ROW_HEIGHT,
            submenuHeight,
            window.innerHeight,
        )
        : 0;
    const submenuLeft = contextMenu
        ? contextMenu.submenuSide === "left"
            ? contextMenu.x - CONTEXT_SUBMENU_WIDTH - CONTEXT_MENU_GAP
            : contextMenu.x + CONTEXT_MENU_WIDTH + CONTEXT_MENU_GAP
        : 0;

    return (
        <div
            className={classes(styles, `clipboard-container ${animationState}`)}
            ref={containerRef}
            tabIndex={-1}
            onContextMenu={event => event.preventDefault()}
        >
            {toast && (
                <div className={classes(styles, `clipboard-toast ${toast.kind}`)} key={toast.id}>
                    <span>{toast.message}</span>
                    {toast.actionLabel && toast.onAction && (
                        <button
                            type="button"
                            className={classes(styles, "clipboard-toast-action")}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (toastTimerRef.current !== null) {
                                    window.clearTimeout(toastTimerRef.current);
                                    toastTimerRef.current = null;
                                }
                                setToast(null);
                                toast.onAction?.();
                            }}
                        >
                            {toast.actionLabel}
                        </button>
                    )}
                </div>
            )}
            {/* Header */}
            <div className={classes(styles, "clipboard-header")}>
                {tutorialActive ? (
                    <div className={classes(styles, "tutorial-header-spacer")} />
                ) : (
                    <div className={classes(styles, `search-box ${searchOpen || searchWord ? 'open' : ''}`)}>
                        <button
                            type="button"
                            className={classes(styles, "search-button")}
                            title={t("common.search")}
                            aria-label={t("common.search")}
                            onClick={focusSearchInput}
                        >
                            <SearchIcon className={classes(styles, "search-icon")} fontSize="inherit" />
                        </button>
                        {(searchOpen || searchWord) && (
                            <input
                                ref={searchInputRef}
                                type="text"
                                className={classes(styles, "search-input")}
                                placeholder={t("common.search")}
                                value={searchWord as string}
                                onChange={handleSearchChange}
                                onBlur={() => {
                                    if (!searchWord) {
                                        setSearchOpen(false);
                                    }
                                }}
                            />
                        )}
                    </div>
                )}
                <ClipboardTabBar
                    activeTab={activeTab}
                    dynamicTabs={dynamicTabs}
                    draggingTabId={draggingTabId}
                    tutorialActive={tutorialActive}
                    altHintsVisible={altHintsVisible}
                    addButtonRef={addTabButtonRef}
                    t={t}
                    onSelectTab={setActiveTab}
                    onBlockedNavigation={blockTutorialNavigation}
                    onEditTab={(entry, anchor) => {
                        if (entry.kind === "filter") {
                            openEditTabEditor(entry.tab, anchor);
                        } else {
                            openEditRecordTagEditor(entry.tag, anchor);
                        }
                    }}
                    onOpenContextMenu={(entry, clientX, clientY) => {
                        setContextMenu(null);
                        const position = floatingPositionFromClick(
                            clientX,
                            clientY,
                            TAB_CONTEXT_MENU_WIDTH,
                            contextMenuHeight(2),
                        );
                        setTabContextMenu(entry.kind === "filter"
                            ? {
                                kind: "filter",
                                tab: entry.tab,
                                x: position.x,
                                y: position.y,
                                originX: clientX,
                                originY: clientY,
                            }
                            : {
                                kind: "record",
                                tag: entry.tag,
                                x: position.x,
                                y: position.y,
                                originX: clientX,
                                originY: clientY,
                            });
                    }}
                    onDragStart={setDraggingTabId}
                    onDragEnd={() => setDraggingTabId("")}
                    onDrop={handleTabDrop}
                    onAdd={openTagCreateChoice}
                />
                <ClipboardHeaderActions
                    isMac={isMacPlatform()}
                    tutorialActive={tutorialActive}
                    tutorialPlatform={tutorialPlatform}
                    permissionIncomplete={Boolean(
                        tutorialPermissionStatus
                        && (!tutorialPermissionStatus.background.done || !tutorialPermissionStatus.paste.done)
                    )}
                    developerMode={developerMode}
                    showDeveloperToolbar={import.meta.env.DEV && developerMode}
                    languageCode={languageCode}
                    developerTheme={developerTheme}
                    t={t}
                    onOpenPermissionCenter={openPermissionCenter}
                    onOpenTutorial={openTutorialFromDebug}
                    onToggleLanguage={toggleDeveloperLanguage}
                    onToggleTheme={toggleDeveloperTheme}
                    onOpenUiLab={openUiLab}
                    onOpenSettings={tutorialActive ? blockTutorialNavigation : openConfigWindow}
                />
            </div>

            {!tutorialActive && updateReady(updateState) && (
                <ClipboardUpdateBanner
                    version={updateState.availableVersion || ""}
                    t={t}
                    onOpen={() => void openUpdateSettings()}
                />
            )}

            {/* Cards Grid */}
            <div
                className={classes(styles, "cards-container")}
                ref={cardsContainerRef}
                onScroll={() => {
                    if (!tutorialActive) maybeLoadMoreHistory();
                }}
                onPointerDown={(event) => {
                    if (!tutorialActive) handleCardsPointerDown(event);
                }}
                onPointerMove={(event) => {
                    if (!tutorialActive) handleCardsPointerMove(event);
                }}
                onPointerUp={(event) => {
                    if (!tutorialActive) finishCardsPointerDrag(event);
                }}
                onPointerCancel={(event) => {
                    if (!tutorialActive) finishCardsPointerDrag(event);
                }}
                onLostPointerCapture={(event) => {
                    if (!tutorialActive) finishCardsPointerDrag(event);
                }}
                onClickCapture={handleCardsClickCapture}
            >
                {tutorialActive ? (
                    <TutorialOverlay
                        key={tutorialRunId}
                        t={t}
                        logoSrc={appIcon}
                        shortcutText={tutorialShortcutText}
                        platform={tutorialPlatform}
                        permissions={tutorialPermissions}
                        filters={tutorialFilters}
                        onPermissionAction={handleTutorialPermissionAction}
                        onToggleFilter={handleTutorialFilterToggle}
                        onComplete={completeTutorial}
                    />
                ) : (
                    <div className={classes(styles, "cards-grid")}>
                        {clipboardPage.list.map((item, index) => (
                            <ClipboardCard
                                key={item.getHash() as string}
                                item={item}
                                selected={selected === item.getHash()}
                                simulatedHover={simulatedHoverHash === item.getHash()}
                                refreshKey={fileRefreshKey}
                                searchQuery={searchWord as string}
                                shortcutHint={altHintsVisible && index < 9 ? String(index + 1) : undefined}
                                mediaPlaybackReady={animationState === 'entered'}
                                t={t}
                                onContextMenu={openClipboardContextMenu}
                            />
                        ))}
                        {isLoadingMore && (
                            <div className={classes(styles, "history-loading-card")}>{t("common.loading")}</div>
                        )}
                    </div>
                )}
            </div>
            {tagCreateChoice && (
                <TagCreateChoicePopover
                    state={tagCreateChoice}
                    t={t}
                    onSelect={(kind, originX, originY) => {
                        setTagCreateChoice(null);
                        openTabEditorWindowAt("add", kind, undefined, undefined, originX, originY);
                    }}
                />
            )}
            {contextMenu && (
                <ClipboardContextMenus
                    state={contextMenu}
                    options={contextMenuOptions}
                    selectedIndex={contextMenuIndex}
                    submenuOptions={selectedSubmenuOptions}
                    submenuLeft={submenuLeft}
                    submenuTop={submenuTop}
                    onSelectedIndexChange={setContextMenuIndex}
                />
            )}
            {tabContextMenu && (
                <TabContextMenu
                    state={tabContextMenu}
                    t={t}
                    onEdit={state => {
                        if (state.kind === "record") {
                            openTabEditorWindowAt("edit", "record", undefined, state.tag, state.originX, state.originY);
                        } else {
                            openTabEditorWindowAt("edit", "filter", state.tab, undefined, state.originX, state.originY);
                        }
                        setTabContextMenu(null);
                    }}
                    onDelete={state => {
                        if (state.kind === "record") {
                            setDeleteConfirmRecordTag(state.tag);
                        } else {
                            setDeleteConfirmTab(state.tab);
                        }
                        setTabContextMenu(null);
                    }}
                />
            )}
            {deleteConfirmTab && (
                <DeleteConfirmDialog
                    title={t("tabs.deleteConfirmTitle")}
                    description={t("tabs.deleteConfirmDesc", { name: deleteConfirmTab.name })}
                    cancelLabel={t("tabs.cancel")}
                    confirmLabel={t("tabs.delete")}
                    onCancel={() => setDeleteConfirmTab(null)}
                    onConfirm={() => deleteCustomTab(deleteConfirmTab)}
                />
            )}
            {deleteConfirmRecordTag && (
                <DeleteConfirmDialog
                    title={t("tabs.deleteConfirmTitle")}
                    description={t("tags.deleteConfirm", { name: deleteConfirmRecordTag.name })}
                    cancelLabel={t("tabs.cancel")}
                    confirmLabel={t("tabs.delete")}
                    onCancel={() => setDeleteConfirmRecordTag(null)}
                    onConfirm={() => void deleteRecordTag(deleteConfirmRecordTag)}
                />
            )}
        </div>
    );
}
