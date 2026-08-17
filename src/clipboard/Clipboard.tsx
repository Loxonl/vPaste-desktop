import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { Item, ItemTag, ItemType } from "./Item.ts";
import { useLanguage } from "../lang";
import { formatShortcutLabel, isMacPlatform } from "../shortcutDisplay";
import SearchIcon from "@mui/icons-material/Search";
import TutorialOverlay from "./TutorialOverlay.tsx";
import appIcon from "../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import { getResolvedTheme, setThemePreview, type ResolvedTheme } from "../theme";
import { restartReady, useAppUpdateState } from "../update";
import {
    arraysEqual,
    customTabFilterPayload,
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
import {
    searchDebounceDelay,
    shouldMaskSearchResults,
} from "./clipboardSearch";
import ClipboardCard from "./ClipboardCard";
import {
    parseLinkContent,
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
} from "./useClipboardLifecycleSubscriptions";
import { useClipboardListInteractions } from "./useClipboardListInteractions";
import { useClipboardAltHints } from "./useClipboardAltHints";
import {
    loadClipboardBehaviorConfig,
    resolveClipboardShowPreferences,
} from "./clipboardBehavior";
import {
    DEFAULT_MAIN_SHORTCUT,
    DEFAULT_PASTE_AS_TEXT_SHORTCUT,
} from "../config/shortcutDefaults";
import {
    buildTutorialFilterTabs,
    buildTutorialPermissions,
    tutorialFilterTabId,
    updateTutorialFilterTabs,
    type TutorialFilterId,
    type TutorialPermissionStatus,
    type TutorialPlatform,
} from "./clipboardTutorial";
import { createClipboardTutorialRuntime } from "./clipboardTutorialRuntime";
import {
    PENDING_ITEM_TAGS_CHANGED_KEY,
    assignItemTag,
    parseItemTagsChangedPayload,
    removeItemTag,
    removeRecordTagFromItems,
    updateItemTagsForPage,
    updateRecordTagInItems,
    upsertItemTag,
    type ItemTagsChangedPayload,
} from "./clipboardTags";
import { createClipboardItemActions } from "./clipboardItemActions";
import { createClipboardPasteRuntime } from "./clipboardPasteRuntime";
import { createClipboardPreviewRuntime } from "./clipboardPreviewRuntime";
import { parsePasteQueueState } from "./pasteQueueState";

const CLIPBOARD_SHOW_REFRESH_DELAY_MS = 310;
const HISTORY_PAGE_LIMIT = 36;

type ToastKind = 'info' | 'warning' | 'error';

type ToastState = {
    id: number;
    message: string;
    kind: ToastKind;
    actionLabel?: string;
    onAction?: () => void;
} | null;

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
    const { state: updateState, restartToUpdate } = useAppUpdateState();
    const [selected, setSelected] = useState<String>("");
    const [searchWord, setSearchWord] = useState<String>("");
    const [searchOpen, setSearchOpen] = useState<boolean>(false);
    const [isSearchComposing, setIsSearchComposing] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
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
    const [simulatedHoverHash, setSimulatedHoverHash] = useState("");
    const [tutorialActive, setTutorialActive] = useState(false);
    const [tutorialRunId, setTutorialRunId] = useState(0);
    const [tutorialPermissionStatus, setTutorialPermissionStatus] = useState<TutorialPermissionStatus | null>(null);
    const [tutorialPlatform, setTutorialPlatform] = useState<TutorialPlatform>(() => isMacPlatform() ? "mac" : "windows");
    const [developerMode, setDeveloperMode] = useState(false);
    const [developerTheme, setDeveloperTheme] = useState<ResolvedTheme>(() => getResolvedTheme());
    const [mainShortcut, setMainShortcut] = useState(DEFAULT_MAIN_SHORTCUT);
    const [pasteQueueActive, setPasteQueueActive] = useState(false);
    const queueSelectionMode = pasteQueueActive;
    const [queueSelectedHashes, setQueueSelectedHashes] = useState<string[]>([]);

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
    const scrollRefreshTimerRef = useRef<number | null>(null);
    const imagePrewarmTimerRef = useRef<number | null>(null);
    const imagePrewarmIdleRef = useRef<number | null>(null);
    const loadMoreCheckFrameRef = useRef<number | null>(null);
    const searchDebounceTimerRef = useRef<number | null>(null);
    const searchRequestSeqRef = useRef(0);
    const lastHistoryFetchRef = useRef<{ keywords: string; tab: string } | null>(null);
    const maybeLoadMoreHistoryRef = useRef<(force?: boolean) => void>(() => undefined);
    const refreshHistoryRef = useRef<() => void>(() => undefined);
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
    const pasteQueueRevisionRef = useRef(0);
    const {
        clearTimer: clearAltHintTimer,
        hide: hideAltHints,
        showWhilePressed: showAltHintsWhilePressed,
        syncFromNative: syncAltHintsFromNative,
        visible: altHintsVisible,
    } = useClipboardAltHints(quickInputEnabledRef);
    const dynamicTabs = useMemo(
        () => orderedDynamicTabs(customTabs, itemTags, tabOrder),
        [customTabs, itemTags, tabOrder],
    );
    const openClipboardContextMenuRef = useRef<(item: Item, clientX: number, clientY: number) => void>(() => { });

    const applyPasteQueueState = useCallback((payload: Parameters<typeof parsePasteQueueState>[0]) => {
        const state = parsePasteQueueState(payload);
        if (state.revision < pasteQueueRevisionRef.current) return;
        pasteQueueRevisionRef.current = state.revision;
        setPasteQueueActive(state.active);
        if (!state.active) {
            setQueueSelectedHashes([]);
        }
    }, []);

    useEffect(() => {
        void invoke<Parameters<typeof parsePasteQueueState>[0]>("get_paste_queue_state")
            .then(applyPasteQueueState)
            .catch(() => undefined);
        const unlisten = listen<Parameters<typeof parsePasteQueueState>[0]>(
            "paste-queue-state-changed",
            event => applyPasteQueueState(event.payload),
        );
        return () => {
            void unlisten.then(remove => remove());
        };
    }, [applyPasteQueueState]);

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
        if (queueSelectionMode) {
            activateClipboardCardRef.current(item.getHash() as string, false);
        } else {
            void clickClipboardItem(item.getHash(), false, true, String(index + 1));
        }
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
        if (tutorialActiveRef.current) return;
        setAnimationState('exiting');
        const generation = await invoke<number>('begin_hide_clipboard_window')
            .catch(e => {
                error(`Failed to mark clipboard hiding: ${e}`);
                return 0;
            });
        if (generation === 0) {
            setAnimationState(tutorialActiveRef.current ? 'entered' : 'hidden');
            return;
        }
        await invoke('finish_hide_clipboard_window', { generation });
        setAnimationState(tutorialActiveRef.current ? 'entered' : 'hidden');
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
            const nextList = updateItemTagsForPage(
                page.list,
                hash,
                nextTags,
                activeRecordTagId,
            );
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const removeRecordTagFromPageItems = (tagId: number) => {
        setPage(page => {
            const nextList = removeRecordTagFromItems(page.list, tagId);
            pageListRef.current = nextList;
            return new ClipboardPage(nextList, page.consumed);
        });
    };

    const updateRecordTagOnPageItems = (updatedTag: ItemTag) => {
        setPage(page => {
            const nextList = updateRecordTagInItems(page.list, updatedTag);
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
            updateItemTagsInPage(target, assignItemTag(target.getTags(), tag));
            showToast(t("tags.createdAndAssigned", { name: tag.name }));
        } catch (e) {
            showToast(t("clipboard.actionFailed", { error: String(e) }), "error");
        }
    };

    const applyItemTagsChanged = (payload: ItemTagsChangedPayload | null | undefined) => {
        const updatedTag = payload?.tag;
        if (updatedTag) {
            setItemTags(tags => upsertItemTag(tags, updatedTag));
            updateRecordTagOnPageItems(updatedTag);
        }
        void loadItemTags();
        if (payload?.activeId) {
            appendTabOrderId(payload.activeId);
            activeTabRef.current = payload.activeId;
            setActiveTab(payload.activeId);
        }
        if (updatedTag) {
            void assignPendingRecordTagToItem(updatedTag);
        }
    };

    const consumePendingItemTagsChanged = () => {
        const raw = localStorage.getItem(PENDING_ITEM_TAGS_CHANGED_KEY);
        if (!raw) return;
        localStorage.removeItem(PENDING_ITEM_TAGS_CHANGED_KEY);
        try {
            applyItemTagsChanged(parseItemTagsChangedPayload(raw));
        } catch (e) {
            error(`Failed to consume pending item tag change: ${e}`);
            void loadItemTags();
        }
    };

    const deleteRecordTag = async (tag: ItemTag) => {
        try {
            await invoke('delete_item_tag', { id: tag.id });
            removeTabOrderId(recordTagTabId(tag.id));
            setItemTags(tags => removeItemTag(tags, tag.id));
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

    const {
        complete: completeTutorial,
        initialize: initializeTutorial,
        markCompleted: markTutorialCompleted,
        openPermission: handleTutorialPermissionAction,
        refreshPermissionStatus: refreshTutorialPermissionStatus,
        start: startTutorial,
    } = createClipboardTutorialRuntime({
        incrementRunId: () => setTutorialRunId(id => id + 1),
        isActive: () => tutorialActiveRef.current,
        languageCode,
        onActionError: actionError => {
            showToast(
                t("clipboard.actionFailed", { error: String(actionError) }),
                "error",
            );
        },
        onBeforeStart: () => {
            setAnimationState("entered");
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
        },
        onComplete: () => refreshHistoryRef.current(),
        setActive: active => {
            tutorialActiveRef.current = active;
            setTutorialActive(active);
        },
        setMainShortcut,
        setPermissionStatus: setTutorialPermissionStatus,
        setPlatform: setTutorialPlatform,
    });

    const handleTutorialFilterToggle = (id: TutorialFilterId, enabled: boolean) => {
        const tabId = tutorialFilterTabId(id);
        setCustomTabs(tabs => updateTutorialFilterTabs(tabs, id, enabled, t));

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
            .slice(0, 6);

        if (paths.length === 0) return;
        paths.forEach(path => imageClipboardCachePrewarmRef.current.add(path));
        if (imagePrewarmTimerRef.current !== null) {
            window.clearTimeout(imagePrewarmTimerRef.current);
        }
        imagePrewarmTimerRef.current = window.setTimeout(() => {
            imagePrewarmTimerRef.current = null;
            const prewarm = () => {
                imagePrewarmIdleRef.current = null;
                void invoke("prewarm_image_preview_cache", { paths })
                    .then(() => {
                        window.setTimeout(() => {
                            void invoke("prewarm_image_clipboard_cache", { paths: paths.slice(0, 2) })
                                .catch(e => error(`Failed to prewarm image clipboard cache: ${e}`));
                        }, 1800);
                    })
                    .catch(e => {
                        paths.forEach(path => imageClipboardCachePrewarmRef.current.delete(path));
                        error(`Failed to prewarm image preview cache: ${e}`);
                    });
            };
            if (typeof window.requestIdleCallback === "function") {
                imagePrewarmIdleRef.current = window.requestIdleCallback(prewarm, { timeout: 1800 });
            } else {
                imagePrewarmIdleRef.current = window.setTimeout(prewarm, 320);
            }
        }, 900);
    };

    async function fetchHistoryWith(keywords: string, tab: string, options: { selectFirst?: boolean, background?: boolean } = {}) {
        const requestSeq = ++searchRequestSeqRef.current;
        if (!options.background && keywords.trim()) {
            setIsSearching(true);
        }
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
            if (requestSeq === searchRequestSeqRef.current) {
                error(`Failed to fetch history: ${e}`);
            }
        } finally {
            if (requestSeq === searchRequestSeqRef.current) {
                setIsSearching(false);
            }
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

    const runLoadMoreHistoryCheck = () => {
        const container = cardsContainerRef.current;
        if (!container) return;
        const distanceToEnd = container.scrollWidth - container.scrollLeft - container.clientWidth;
        if (distanceToEnd < 360) {
            void loadMoreHistory();
        }
    };

    const maybeLoadMoreHistory = (force: boolean = false) => {
        if (force) {
            if (loadMoreCheckFrameRef.current !== null) {
                window.cancelAnimationFrame(loadMoreCheckFrameRef.current);
                loadMoreCheckFrameRef.current = null;
            }
            runLoadMoreHistoryCheck();
            return;
        }
        if (loadMoreCheckFrameRef.current !== null) return;
        loadMoreCheckFrameRef.current = window.requestAnimationFrame(() => {
            loadMoreCheckFrameRef.current = null;
            runLoadMoreHistoryCheck();
        });
    };
    maybeLoadMoreHistoryRef.current = maybeLoadMoreHistory;

    const fetchHistory = async () => {
        await fetchHistoryWith(searchWordRef.current, activeTabRef.current);
    };
    refreshHistoryRef.current = () => {
        void fetchHistory();
    };

    const applyShowPreferences = async () => {
        const config = await loadClipboardBehaviorConfig();
        const preferences = resolveClipboardShowPreferences(
            config,
            searchWordRef.current,
            activeTabRef.current,
        );
        pasteAsTextShortcutRef.current = preferences.pasteAsTextShortcut;
        quickInputEnabledRef.current = preferences.quickInputEnabled;
        if (!quickInputEnabledRef.current) {
            hideAltHints();
        }
        tabQuickSelectEnabledRef.current = preferences.tabQuickSelectEnabled;
        linkAutoPreviewRef.current = preferences.linkAutoPreview;

        if (!preferences.retainSearchHistory) {
            setSearchWord("");
            setSearchOpen(false);
        }

        if (!preferences.retainTabPosition) {
            activeTabRef.current = "all";
            setActiveTab("all");
        }

        if (!preferences.retainLastPosition) {
            if (cardsContainerRef.current) {
                cardsContainerRef.current.scrollLeft = 0;
            }
            selectFirstLoadedItem(true);
        } else if (!selectedRef.current) {
            selectFirstLoadedItem(false);
        }

        const cachedFetch = lastHistoryFetchRef.current;
        if (
            cachedFetch?.keywords === preferences.searchWord
            && cachedFetch?.tab === preferences.activeTab
            && pageListRef.current.length > 0
        ) {
            return;
        }

        await fetchHistoryWith(
            preferences.searchWord,
            preferences.activeTab,
            { selectFirst: !preferences.retainLastPosition },
        );
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
                if (imagePrewarmIdleRef.current !== null) {
                    if (typeof window.cancelIdleCallback === "function") {
                        window.cancelIdleCallback(imagePrewarmIdleRef.current);
                    } else {
                        window.clearTimeout(imagePrewarmIdleRef.current);
                    }
                    imagePrewarmIdleRef.current = null;
                }
                if (loadMoreCheckFrameRef.current !== null) {
                    window.cancelAnimationFrame(loadMoreCheckFrameRef.current);
                    loadMoreCheckFrameRef.current = null;
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
                markTutorialCompleted();
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
            initializeTutorial();
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
            if (loadMoreCheckFrameRef.current !== null) {
                window.cancelAnimationFrame(loadMoreCheckFrameRef.current);
                loadMoreCheckFrameRef.current = null;
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
        const delay = searchDebounceDelay(keywords, isSearchComposing);
        if (delay === null) {
            return;
        }
        setIsSearching(Boolean(keywords.trim()));
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
    }, [searchWord, isSearchComposing]);

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
                searchComposing: isSearchComposing,
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
                        if (queueSelectionMode) {
                            activateClipboardCardRef.current(firstHash, false);
                        } else {
                            void clickClipboardItem(firstHash, false);
                        }
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
                    togglePreview(
                        pageListRef.current.find(
                            item => item.getHash() === selectedRef.current,
                        ) || pageListRef.current[0],
                    );
                    return;
                case "paste-selected":
                    setContextMenu(null);
                    if (action.plainText) {
                        const selectedItem = pageListRef.current.find(
                            item => item.getHash() === selectedRef.current,
                        ) || pageListRef.current[0];
                        if (selectedItem) {
                            if (queueSelectionMode) {
                                activateClipboardCardRef.current(selectedItem.getHash() as string, true);
                            } else {
                                void clickClipboardItem(selectedItem.getHash(), true);
                            }
                        }
                        return;
                    }
                    {
                        const selectedHash = selectedRef.current
                            || (pageListRef.current[0]?.getHash() as string | undefined);
                        if (selectedHash) {
                            if (queueSelectionMode) {
                                activateClipboardCardRef.current(selectedHash, false);
                            } else {
                                void clickClipboardItem(selectedHash, false);
                            }
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
    }, [searchOpen, searchWord, isSearchComposing, contextMenu, contextMenuIndex, queueSelectionMode, t]);

    const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setSearchWord(event.target.value);
    };

    const {
        pasteItem: clickClipboardItem,
        pastePlainTextItem,
    } = createClipboardPasteRuntime({
        closeContextMenu: () => setContextMenu(null),
        getItems: () => pageListRef.current,
        hideWindow: hideCurrentWindowWithAnimation,
        refreshHistory: fetchHistory,
        selectItem: hash => {
            selectedRef.current = hash;
            setSelected(hash);
        },
        showToast,
        t,
    });

    activateClipboardCardRef.current = (hash: string, plainText: boolean) => {
        if (queueSelectionMode) {
            setQueueSelectedHashes(current => (
                current.includes(hash)
                    ? current.filter(candidate => candidate !== hash)
                    : [...current, hash]
            ));
            return;
        }
        void clickClipboardItem(hash, plainText);
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

    const {
        openPreviewItem,
        refreshPreviewIfVisible,
        togglePreview,
    } = createClipboardPreviewRuntime({
        closeContextMenu: () => setContextMenu(null),
        requestSequence: previewRequestSeqRef,
        selectItem: hash => {
            selectedRef.current = hash;
            setSelected(hash);
        },
        showToast,
        t,
    });

    const navigateSelectedCard = (direction: number) => {
        const list = pageListRef.current;
        if (list.length === 0) return;
        const currentIndex = list.findIndex(item => item.getHash() === selectedRef.current);
        const item = selectCardAt(currentIndex === -1 ? 0 : currentIndex + direction);
        if (item) {
            refreshPreviewIfVisible(item);
        }
    };

    const removeDeletedItemFromPage = (item: Item) => {
        const hash = item.getHash() as string;
        const currentList = pageListRef.current;
        const deletedIndex = currentList.findIndex(
            candidate => candidate.getHash() === hash,
        );
        const nextList = currentList.filter(
            candidate => candidate.getHash() !== hash,
        );
        pageListRef.current = nextList;
        setPage(page => new ClipboardPage(nextList, page.consumed));
        if (selectedRef.current === hash) {
            const nextIndex = Math.max(
                0,
                Math.min(deletedIndex, nextList.length - 1),
            );
            const nextHash = nextList[nextIndex]?.getHash() as
                | string
                | undefined;
            selectedRef.current = nextHash || "";
            setSelected(nextHash || "");
            if (nextHash) {
                window.requestAnimationFrame(() => {
                    scrollCardIntoView(nextIndex);
                });
            }
        }
    };

    const {
        assignExistingTag,
        copyColorValue,
        copyContainingFolderPath,
        deleteClipboardItem,
        exportImageItem,
        openContainingFolder,
        removeAllAssignedTags,
        removeAssignedTag,
        toggleFavorite,
    } = createClipboardItemActions({
        closeContextMenu: () => setContextMenu(null),
        hideWindow: hideCurrentWindowWithAnimation,
        onDelete: removeDeletedItemFromPage,
        refreshHistory: fetchHistory,
        showToast,
        t,
        updateItemTags: updateItemTagsInPage,
    });

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

    const openPasteQueueSelection = async () => {
        try {
            const payload = await invoke<Parameters<typeof parsePasteQueueState>[0]>(
                "set_paste_queue_active",
                { active: !pasteQueueActive },
            );
            applyPasteQueueState(payload);
            setQueueSelectedHashes([]);
            setContextMenu(null);
            setTabContextMenu(null);
        } catch (reason) {
            showToast(t("clipboard.actionFailed", { error: String(reason) }), "error");
        }
    };

    const addSelectedItemsToPasteQueue = async () => {
        if (queueSelectedHashes.length === 0) return;
        try {
            await invoke("add_paste_queue_items", { hashes: queueSelectedHashes });
            setQueueSelectedHashes([]);
        } catch (reason) {
            showToast(t("clipboard.actionFailed", { error: String(reason) }), "error");
        }
    };

    const restartForUpdate = async () => {
        try {
            await restartToUpdate();
        } catch (e) {
            error(`Failed to restart and install update: ${e}`);
        }
    };

    const openUiLab = () => {
        if (!import.meta.env.DEV) return;
        const url = new URL("/__ui-lab", window.location.origin).toString();
        void invoke("open_url_in_browser", { url })
            .catch(e => error(`Failed to open UI lab: ${e}`));
    };

    const openTestRoom = () => {
        if (!import.meta.env.DEV || !developerMode) return;
        void invoke("open_test_room_window")
            .catch(e => error(`Failed to open test room: ${e}`));
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

    const tutorialPermissions = buildTutorialPermissions(
        tutorialPermissionStatus,
        t,
    );
    const tutorialFilters = buildTutorialFilterTabs(customTabs, t);
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
                                onCompositionStart={() => setIsSearchComposing(true)}
                                onCompositionEnd={(event) => {
                                    setSearchWord(event.currentTarget.value);
                                    setIsSearchComposing(false);
                                }}
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
                    showDeveloperToolbar={import.meta.env.DEV && developerMode}
                    languageCode={languageCode}
                    developerTheme={developerTheme}
                    t={t}
                    pasteQueueActive={pasteQueueActive}
                    onOpenPasteQueue={tutorialActive ? blockTutorialNavigation : openPasteQueueSelection}
                    onOpenPermissionCenter={openPermissionCenter}
                    onOpenTutorial={openTutorialFromDebug}
                    onToggleLanguage={toggleDeveloperLanguage}
                    onToggleTheme={toggleDeveloperTheme}
                    onOpenUiLab={openUiLab}
                    onOpenTestRoom={openTestRoom}
                    onOpenSettings={tutorialActive ? blockTutorialNavigation : openConfigWindow}
                />
            </div>

            {!tutorialActive && restartReady(updateState) && (
                <ClipboardUpdateBanner
                    version={updateState.availableVersion || ""}
                    t={t}
                    onRestart={() => void restartForUpdate()}
                />
            )}

            {/* Cards Grid */}
            <div
                className={classes(styles, `cards-container${queueSelectionMode ? " queue-selection-mode" : ""}`)}
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
                ) : shouldMaskSearchResults(searchWord as string, isSearching) ? (
                    <div className={classes(styles, "cards-grid")} role="status" aria-live="polite">
                        <div className={classes(styles, "history-loading-card")}>{t("common.loading")}</div>
                    </div>
                ) : (
                    <div className={classes(styles, "cards-grid")}>
                        {clipboardPage.list.map((item, index) => (
                            <ClipboardCard
                                key={item.getHash() as string}
                                item={item}
                                selected={queueSelectionMode
                                    ? queueSelectedHashes.includes(item.getHash() as string)
                                    : selected === item.getHash()}
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
            {queueSelectionMode && (
                <div className={classes(styles, "paste-queue-selection-bar")} role="toolbar" aria-label={t("pasteQueue.selectTitle")}>
                    <strong>{t("pasteQueue.selectTitle")}</strong>
                    <span>{queueSelectedHashes.length}</span>
                    <button type="button" className={classes(styles, "primary")} onClick={() => void addSelectedItemsToPasteQueue()}>
                        {t("pasteQueue.addSelected", { count: queueSelectedHashes.length })}
                    </button>
                </div>
            )}
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
