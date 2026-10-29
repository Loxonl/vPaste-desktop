import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import InputBase from "@mui/material/InputBase";
import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { StatusToast, type StatusToastKind } from "../ui/StatusToast";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import {
    AnimatePresence,
    m,
    useMotionPreset,
    useReducedMotionConfig,
} from "../ui/motion";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { Item, ItemTag, ItemType } from "./Item.ts";
import { useLanguage } from "../lang";
import { formatShortcutLabel, isMacPlatform } from "../shortcutDisplay";
import SearchIcon from "@mui/icons-material/Search";
import ContentPasteSearchOutlinedIcon from "@mui/icons-material/ContentPasteSearchOutlined";
import TutorialOverlay from "./TutorialOverlay.tsx";
import appIcon from "../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import { getResolvedTheme, setThemePreview, type ResolvedTheme } from "../theme";
import { restartReady, storeUpdateAvailable, updateEntryVisible, useAppUpdateState } from "../update";
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
    resolveClipboardEmptyState,
    searchDebounceDelay,
    shouldMaskSearchResults,
    type LoadedClipboardRequest,
} from "./clipboardSearch";
import ClipboardCard from "./ClipboardCard";
import { ClipboardResultsSurface } from "./ClipboardResultsSurface";
import {
    isEditableTextItem,
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
    UpdateConfirmDialog,
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
} from "./ClipboardHeader";
import { clipboardKeyDownAction } from "./clipboardKeyboard";
import { buildClipboardContextMenuOptions } from "./clipboardContextMenu";
import {
    useClipboardLifecycleSubscriptions,
} from "./useClipboardLifecycleSubscriptions";
import { useClipboardListInteractions } from "./useClipboardListInteractions";
import { useClipboardAltHints } from "./useClipboardAltHints";
import {
    clampRetainedScrollLeft,
    loadClipboardBehaviorConfig,
    resolveClipboardShowPreferences,
    resolveClipboardShowPlan,
    type ClipboardBehaviorConfig,
    type ClipboardShowPreferences,
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
import { createClipboardShowGate } from "./clipboardShowGate";
import { createClipboardPreviewRuntime } from "./clipboardPreviewRuntime";
import { createClipboardHoverPreview } from "./clipboardHoverPreview";
import { parsePasteQueueState } from "./pasteQueueState";

const CLIPBOARD_SHOW_REFRESH_DELAY_MS = 310;
const HISTORY_PAGE_LIMIT = 36;

type ToastState = {
    id: number;
    message: string;
    kind: StatusToastKind;
    actionLabel?: string;
    onAction?: () => void;
} | null;


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
    const { state: updateState, restartToUpdate, openAppStore } = useAppUpdateState();
    const fadeMotion = useMotionPreset("fade");
    const listItemMotion = useMotionPreset("listItem");
    const stateIndicatorMotion = useMotionPreset("stateIndicator");
    const [selected, setSelected] = useState<String>("");
    const [searchWord, setSearchWord] = useState<String>("");
    const [searchOpen, setSearchOpen] = useState<boolean>(false);
    const [isSearchComposing, setIsSearchComposing] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [filterMotionRequest, setFilterMotionRequest] = useState<{
        requestSeq: number;
        hashes: string[];
    } | null>(null);
    const [loadedHistoryRequest, setLoadedHistoryRequest] = useState<LoadedClipboardRequest | null>(null);
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
    const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
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
    const reduceMotion = Boolean(useReducedMotionConfig());

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
    const retainedScrollLeftRef = useRef(0);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const addTabButtonRef = useRef<HTMLButtonElement>(null);
    const toastTimerRef = useRef<number | null>(null);
    const scrollRefreshTimerRef = useRef<number | null>(null);
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
    const deleteInFlightRef = useRef(false);
    const deleteClipboardItemRef = useRef<(item: Item) => Promise<void>>();
    const historyRefreshingRef = useRef(false);
    const restoreFocusedResultRef = useRef(false);
    const pageListRef = useRef<Item[]>([]);
    const clipboardBehaviorConfigRef = useRef<ClipboardBehaviorConfig | null>(null);
    const retainLastPositionRef = useRef<boolean | null>(null);
    const pasteAsTextShortcutRef = useRef(DEFAULT_PASTE_AS_TEXT_SHORTCUT);
    const quickInputEnabledRef = useRef(true);
    const pasteInFlightRef = useRef(false);
    const mainWindowActiveRef = useRef(true);
    const resourceEpochRef = useRef<number | null>(null);
    const pendingResourceEpochRef = useRef<number | null>(null);
    const flushResourceRefreshRef = useRef<() => void>(() => undefined);
    const showGateRef = useRef<ReturnType<typeof createClipboardShowGate> | null>(null);
    if (!showGateRef.current) {
        showGateRef.current = createClipboardShowGate(reason => {
            error(`Failed to synchronize clipboard before activation: ${reason}`);
            showToast(t("clipboard.actionFailed", { error: String(reason) }), "error");
        }, () => flushResourceRefreshRef.current());
    }
    const tabQuickSelectEnabledRef = useRef(true);
    const hasMoreHistoryRef = useRef(true);
    const nextHistoryCursorRef = useRef({ id: 0, time: 0 });
    const isLoadingMoreRef = useRef(false);
    const customTabsStorageReadyRef = useRef(false);
    const pendingRecordTagAssignTargetRef = useRef<Item | null>(null);
    const previewRequestSeqRef = useRef(0);
    const hoverPreviewRef = useRef<ReturnType<typeof createClipboardHoverPreview> | null>(null);
    const hoverAllowedRef = useRef<() => boolean>(() => false);
    const cycleTabRef = useRef<(direction: -1 | 1) => void>(() => { });
    const activateClipboardCardRef = useRef<(hash: string, plainText: boolean) => void>(() => { });
    const mouseCardClickRef = useRef<(hash: string, plainText: boolean, doubleClick?: boolean) => void>(() => { });
    const hoverCardRef = useRef<(hash: string, target: Element) => void>(() => { });
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

    const activateClipboardCard = useCallback((hash: string, plainText: boolean, doubleClick?: boolean) => {
        mouseCardClickRef.current(hash, plainText, doubleClick);
    }, []);

    const openClipboardContextMenu = useCallback((item: Item, clientX: number, clientY: number) => {
        openClipboardContextMenuRef.current(item, clientX, clientY);
    }, []);

    const {
        clearClickSuppression: clearCardsClickSuppression,
        finishPointerDrag: finishCardsPointerDrag,
        handleClickCapture: handleCardsClickCapture,
        handleDoubleClick: handleCardsDoubleClick,
        handlePointerDown: handleCardsPointerDown,
        handlePointerLeave: handleCardsPointerLeave,
        handlePointerMove: handleCardsPointerMove,
        handleScroll: handleCardsScroll,
        resetPointerState: resetCardsPointerState,
        stopWheelScroll,
        suspendPointerSelection,
    } = useClipboardListInteractions({
        containerRef: cardsContainerRef,
        tutorialActive,
        draggingClassName: styles.dragging,
        wheelScrollingClassName: styles["wheel-scrolling"],
        cardSelector: `[data-results-active="true"] .${styles["clipboard-card"]}`,
        contextMenuSelector: `.${styles["context-menu"]}`,
        onActivateCard: activateClipboardCard,
        onHoverCard: (hash, target) => hoverCardRef.current(hash, target),
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

    cycleTabRef.current = direction => {
        if (tutorialActiveRef.current || contextMenu || tabContextMenu || isSearchComposing) return;
        const tabIds = ["all", "favorite", ...dynamicTabs.map(tab => tab.id)];
        const currentIndex = Math.max(0, tabIds.indexOf(activeTabRef.current));
        const nextTab = tabIds[(currentIndex + direction + tabIds.length) % tabIds.length];
        showGateRef.current!.cancel();
        previewRequestSeqRef.current += 1;
        void invoke<boolean>("is_preview_window_visible").then(visible => {
            if (visible) return invoke("hide_preview_window");
        }).catch(previewError => error(`Failed to close preview before switching category: ${previewError}`));
        switchToTabWithShortcut(nextTab);
        if (cardsContainerRef.current) cardsContainerRef.current.scrollLeft = 0;
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

    const restoreRetainedScrollPosition = () => {
        const retainedScrollLeft = retainedScrollLeftRef.current;
        window.requestAnimationFrame(() => {
            const container = cardsContainerRef.current;
            if (!container) return;
            container.scrollLeft = clampRetainedScrollLeft(
                retainedScrollLeft,
                container.scrollWidth,
                container.clientWidth,
            );
        });
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

    const rememberFocusedResultExit = useCallback(() => {
        restoreFocusedResultRef.current = true;
    }, []);

    const restoreFocusedResult = useCallback((surface: HTMLDivElement) => {
        if (!restoreFocusedResultRef.current) return;
        restoreFocusedResultRef.current = false;
        if (queueSelectionMode) return;
        const focused = document.activeElement;
        if (focused !== document.body && focused !== containerRef.current) return;
        const selectedCard = Array.from(surface.querySelectorAll<HTMLElement>(`.${styles["clipboard-card"]}`))
            .find(card => card.dataset.hash === selectedRef.current);
        selectedCard?.focus({ preventScroll: true });
    }, [queueSelectionMode]);

    useLayoutEffect(() => {
        if (queueSelectionMode || !selected) return;
        const focused = document.activeElement;
        if (focused !== document.body && focused !== containerRef.current
            && !(focused instanceof HTMLElement && focused.classList.contains(styles["clipboard-card"]))) return;
        const selectedCard = Array.from(
            cardsContainerRef.current?.querySelectorAll<HTMLElement>(`[data-results-active="true"] .${styles["clipboard-card"]}`) ?? [],
        ).find(card => card.dataset.hash === selected);
        if (selectedCard && selectedCard !== focused) selectedCard.focus({ preventScroll: true });
    }, [selected, clipboardPage, queueSelectionMode]);

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
        kind: StatusToastKind = 'info',
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
        const cards = container?.querySelectorAll<HTMLElement>(`[data-results-active="true"] .${styles["clipboard-card"]}`);
        const card = cards?.item(index);
        if (!container || !card) return;

        // Use layout coordinates so the filter animation does not shift the scroll target.
        let cardLeft = 0;
        for (let element: HTMLElement | null = card; element && element !== container; element = element.offsetParent as HTMLElement | null) {
            cardLeft += element.offsetLeft;
        }
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

    async function fetchHistoryWith(keywords: string, tab: string, options: { selectFirst?: boolean, background?: boolean, isCurrent?: () => boolean } = {}) {
        if (!mainWindowActiveRef.current || (showGateRef.current!.pending && !options.isCurrent)) return false;
        const requestSeq = ++searchRequestSeqRef.current;
        historyRefreshingRef.current = true;
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
                () => requestSeq === searchRequestSeqRef.current && (options.isCurrent?.() ?? true),
                undefined,
                { background: options.background },
            );
            if (!page || !(options.isCurrent?.() ?? true)) return false;
            const items = page.items;
            resourceEpochRef.current = page.resourceEpoch ?? 0;
            nextHistoryCursorRef.current = { id: page.nextId, time: page.nextTime };
            const previousRequest = lastHistoryFetchRef.current;
            const filterChanged = previousRequest !== null
                && (previousRequest.keywords !== keywords || previousRequest.tab !== tab);
            const shouldAnimateFilteredResults = !options.background
                && !reduceMotion
                && filterChanged
                && pageListRef.current.length > 0
                && !arraysEqual(
                    pageListRef.current.map(item => item.getHash()),
                    items.map(item => item.getHash()),
                );
            pageListRef.current = items;
            lastHistoryFetchRef.current = { keywords, tab };
            setFilterMotionRequest(shouldAnimateFilteredResults
                ? {
                    requestSeq,
                    hashes: items.map(item => item.getHash() as string),
                }
                : null);
            setPage(new ClipboardPage(items, page.consumed));
            setLoadedHistoryRequest({ keywords, activeTab: tab });
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
            return true;
        } catch (e) {
            if (requestSeq === searchRequestSeqRef.current) {
                error(`Failed to fetch history: ${e}`);
            }
        } finally {
            if (requestSeq === searchRequestSeqRef.current) {
                historyRefreshingRef.current = false;
                setIsSearching(false);
                flushResourceRefreshRef.current();
            }
        }
    }

    flushResourceRefreshRef.current = () => {
        if (!mainWindowActiveRef.current || historyRefreshingRef.current || showGateRef.current!.pending
            || pendingResourceEpochRef.current === null || pendingResourceEpochRef.current !== resourceEpochRef.current) return;
        pendingResourceEpochRef.current = null;
        void fetchHistoryWith(searchWordRef.current, activeTabRef.current, { background: true });
    };

    const loadMoreHistory = async () => {
        const currentList = pageListRef.current;
        if (!mainWindowActiveRef.current || isLoadingMoreRef.current || !hasMoreHistoryRef.current || currentList.length === 0) {
            return;
        }

        const cursor = nextHistoryCursorRef.current;
        setIsLoadingMore(true);
        isLoadingMoreRef.current = true;
        try {
            const requestSeq = searchRequestSeqRef.current;
            const tagSearch = parseTagSearch(searchWordRef.current);
            const label = mergeTagSearchFilter(tabLabelForBackend(activeTabRef.current), tagSearch.tagNames);
            const page = await fetchSearchPage(
                tagSearch.keywords,
                label,
                cursor.id,
                cursor.time,
                HISTORY_PAGE_LIMIT,
                () => requestSeq === searchRequestSeqRef.current,
            );
            if (!page) return;
            const nextItems = page.items;
            nextHistoryCursorRef.current = { id: page.nextId, time: page.nextTime };
            const existingHashes = new Set(currentList.map(item => item.getHash()));
            const merged = currentList.concat(nextItems.filter((item: Item) => !existingHashes.has(item.getHash())));
            pageListRef.current = merged;
            setPage(new ClipboardPage(merged, page.consumed));
            setHasMoreHistory(page.hasMore);
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

    const applyRuntimeBehaviorPreferences = (
        preferences: ClipboardShowPreferences,
    ) => {
        pasteAsTextShortcutRef.current = preferences.pasteAsTextShortcut;
        quickInputEnabledRef.current = preferences.quickInputEnabled;
        if (!quickInputEnabledRef.current) {
            hideAltHints();
        }
        tabQuickSelectEnabledRef.current = preferences.tabQuickSelectEnabled;
    };

    const synchronizeClipboardHistory = async (isCurrent: () => boolean) => {
        const capturedHash = await invoke<string | null>("wait_for_clipboard_capture");
        if (!isCurrent()) return;
        const keywords = searchWordRef.current;
        const tab = activeTabRef.current;
        const retainLastPosition = Boolean(retainLastPositionRef.current);
        const refreshed = await fetchHistoryWith(
            keywords,
            tab,
            { selectFirst: !retainLastPosition, isCurrent },
        );
        if (!isCurrent()) return;
        if (!refreshed) throw new Error("Clipboard history refresh did not complete");
        if (capturedHash && !retainLastPosition
            && !keywords.trim() && tab === "all"
            && !pageListRef.current.some(item => item.getHash() === capturedHash)) {
            throw new Error("The latest clipboard item is not available in history");
        }
    };

    const applyShowPreferences = async (isCurrent: () => boolean) => {
        const config = clipboardBehaviorConfigRef.current ?? await loadClipboardBehaviorConfig();
        if (!isCurrent()) return;
        if (Object.keys(config).length > 0) {
            clipboardBehaviorConfigRef.current ??= config;
        }
        const preferences = resolveClipboardShowPreferences(
            clipboardBehaviorConfigRef.current ?? config,
            searchWordRef.current,
            activeTabRef.current,
        );
        retainLastPositionRef.current = preferences.retainLastPosition;
        const plan = resolveClipboardShowPlan(
            preferences,
            Boolean(selectedRef.current),
        );
        applyRuntimeBehaviorPreferences(preferences);

        if (plan.clearSearch) {
            searchWordRef.current = "";
            setSearchWord("");
            setSearchOpen(false);
        }

        if (plan.resetTab) {
            activeTabRef.current = "all";
            setActiveTab("all");
        }

        if (plan.resetPosition) {
            selectFirstLoadedItem(true);
        } else if (plan.selectFirstWithoutScrolling) {
            selectFirstLoadedItem(false);
        }

        await synchronizeClipboardHistory(isCurrent);
        if (!isCurrent()) return;
        if (plan.restorePosition) {
            restoreRetainedScrollPosition();
        }
    };

    useClipboardLifecycleSubscriptions({
        tauri: {
            onBehaviorConfigChanged: config => {
                clipboardBehaviorConfigRef.current = config;
                if (!config.hover_preview_enabled) hoverPreviewRef.current?.cancel();
                const preferences = resolveClipboardShowPreferences(
                    config,
                    searchWordRef.current,
                    activeTabRef.current,
                );
                retainLastPositionRef.current = preferences.retainLastPosition;
                applyRuntimeBehaviorPreferences(preferences);
            },
            onWindowShow: payload => {
                mainWindowActiveRef.current = true;
                resourceEpochRef.current = null;
                pendingResourceEpochRef.current = null;
                resetCardsPointerState();
                if (retainLastPositionRef.current === false) {
                    selectFirstLoadedItem(true);
                }
                if (!showGateRef.current!.pending) {
                    searchRequestSeqRef.current += 1;
                    showGateRef.current!.start(applyShowPreferences);
                }
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
                mainWindowActiveRef.current = false;
                resourceEpochRef.current = null;
                pendingResourceEpochRef.current = null;
                hoverPreviewRef.current?.cancel();
                showGateRef.current!.cancel(true);
                retainedScrollLeftRef.current = cardsContainerRef.current?.scrollLeft ?? 0;
                resetCardsPointerState();
                searchRequestSeqRef.current += 1;
                if (scrollRefreshTimerRef.current !== null) {
                    window.clearTimeout(scrollRefreshTimerRef.current);
                    scrollRefreshTimerRef.current = null;
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
                if (!mainWindowActiveRef.current || showGateRef.current!.pending) return;
                void fetchHistory();
            },
            onCaptureRejected: () => {
                showToast(t("clipboard.captureTooLarge"), "warning");
            },
            onResourcesUpdated: payload => {
                if (!mainWindowActiveRef.current) return;
                if (resourceEpochRef.current !== null && payload.epoch !== resourceEpochRef.current) return;
                pendingResourceEpochRef.current = payload.epoch;
                flushResourceRefreshRef.current();
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
                suspendPointerSelection();
                hoverPreviewRef.current?.cancel();
                if (payload.key === "Tab" && payload.ctrlKey) {
                    cycleTabRef.current(payload.direction === -1 ? -1 : 1);
                    return;
                }
                if (payload.key === "Tab" && !tabQuickSelectEnabledRef.current) return;
                if (showGateRef.current!.queueNavigation(() => navigateSelectedCard(payload.direction === -1 ? -1 : 1))) return;
                showGateRef.current!.cancel();
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
                showGateRef.current!.discardIntents();
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
            mainWindowActiveRef.current = true;
            void loadClipboardBehaviorConfig().then(config => {
                if (Object.keys(config).length > 0) {
                    clipboardBehaviorConfigRef.current ??= config;
                }
                if (retainLastPositionRef.current === null) {
                    retainLastPositionRef.current = Boolean((clipboardBehaviorConfigRef.current ?? config).retain_last_position);
                }
            });
            initializeTutorial();
        },
        onBeforeCleanup: () => {
            mainWindowActiveRef.current = false;
            searchRequestSeqRef.current += 1;
            pendingResourceEpochRef.current = null;
            showGateRef.current!.cancel(true);
            if (toastTimerRef.current !== null) {
                window.clearTimeout(toastTimerRef.current);
            }
            if (scrollRefreshTimerRef.current !== null) {
                window.clearTimeout(scrollRefreshTimerRef.current);
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
        onReady: () => {
            void invoke("clipboard_window_ready")
                .catch(reason => error(`Failed to acknowledge clipboard readiness: ${reason}`));
        },
        onSubscriptionError: (label, subscriptionError) => {
            error(`Clipboard lifecycle subscription failed (${label}): ${subscriptionError}`);
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

    const editedHandlerRef = useRef<(hash: string, previousHash?: string) => void>(() => {});
    editedHandlerRef.current = (hash, previousHash) => {
        if (selectedRef.current === previousHash) {
            selectedRef.current = hash;
            setSelected(hash);
        }
        void fetchHistoryWith(searchWordRef.current, activeTabRef.current);
    };
    useEffect(() => {
        const unlisten = listen<{ hash: string; previousHash?: string }>("clipboard-item-edited", event => {
            editedHandlerRef.current(event.payload.hash, event.payload.previousHash);
        });
        return () => { void unlisten.then(dispose => dispose()); };
    }, []);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            suspendPointerSelection();
            hoverPreviewRef.current?.cancel();
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

            if (action.type === "navigate-tab" && (tutorialActiveRef.current || tabContextMenu !== null)) return;

            if ((action.type === "delete-selected" || action.type === "edit-selected") && (
                !document.hasFocus() || tutorialActiveRef.current
                || historyRefreshingRef.current || isSearching
                || showGateRef.current!.needsSync || showGateRef.current!.pending || showGateRef.current!.failed
                || lastHistoryFetchRef.current?.keywords !== searchWordRef.current
                || lastHistoryFetchRef.current?.tab !== activeTabRef.current
            )) return;

            event.preventDefault();
            if ("stopPropagation" in action && action.stopPropagation) {
                event.stopPropagation();
            }

            if (action.type === "paste-selected" || action.type === "submit-search" || action.type === "quick-item") {
                if (showGateRef.current!.needsSync) {
                    showGateRef.current!.start(synchronizeClipboardHistory);
                } else if (!showGateRef.current!.pending && !showGateRef.current!.failed && (
                    isSearching
                    || lastHistoryFetchRef.current?.keywords !== searchWordRef.current
                    || lastHistoryFetchRef.current?.tab !== activeTabRef.current
                )) {
                    const keywords = searchWordRef.current;
                    const tab = activeTabRef.current;
                    if (searchDebounceTimerRef.current !== null) {
                        window.clearTimeout(searchDebounceTimerRef.current);
                        searchDebounceTimerRef.current = null;
                    }
                    showGateRef.current!.start(async isCurrent => {
                        const refreshed = await fetchHistoryWith(keywords, tab, {
                            selectFirst: true,
                            isCurrent,
                        });
                        if (isCurrent() && !refreshed) {
                            throw new Error("Clipboard search did not complete");
                        }
                    });
                }
                if (showGateRef.current!.defer(() => {
                    const item = action.type === "quick-item"
                        ? pageListRef.current[action.index]
                        : action.type === "submit-search" ? pageListRef.current[0]
                            : pageListRef.current.find(item => item.getHash() === selectedRef.current) || pageListRef.current[0];
                    if (!item) return;
                    if (queueSelectionMode) activateClipboardCardRef.current(item.getHash(), "plainText" in action && action.plainText);
                    else void clickClipboardItem(item.getHash(), "plainText" in action && action.plainText,
                        action.type === "quick-item", action.type === "quick-item" ? String(action.index + 1) : "");
                })) return;
            } else if (action.type === "navigate-selection" && showGateRef.current!.queueNavigation(() => {
                navigateSelectedCard(action.direction);
            })) {
                return;
            } else if (action.type !== "alt-press") {
                showGateRef.current!.cancel();
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
                case "navigate-tab":
                    cycleTabRef.current(action.direction);
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
                            activateClipboardCardRef.current(firstHash, action.plainText);
                        } else {
                            void clickClipboardItem(firstHash, action.plainText);
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
                case "delete-selected": {
                    const item = pageListRef.current.find(candidate => candidate.getHash() === selectedRef.current);
                    if (item) void deleteClipboardItemRef.current?.(item);
                    return;
                }
                case "edit-selected": {
                    const item = pageListRef.current.find(candidate => candidate.getHash() === selectedRef.current);
                    if (item) void openTextEditor(item);
                    return;
                }
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
    }, [searchOpen, searchWord, isSearching, isSearchComposing, contextMenu, contextMenuIndex, tabContextMenu, queueSelectionMode, t]);

    const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        showGateRef.current!.cancel();
        setSearchWord(event.target.value);
    };

    const {
        pasteItem: clickClipboardItem,
        pastePlainTextItem,
    } = createClipboardPasteRuntime({
        pasteInFlight: pasteInFlightRef,
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
        showGateRef.current!.cancel();
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

    mouseCardClickRef.current = (hash, plainText, doubleClick = false) => {
        const doubleMode = clipboardBehaviorConfigRef.current?.mouse_paste_mode === "double";
        if (doubleClick) {
            if (!queueSelectionMode && doubleMode) activateClipboardCardRef.current(hash, plainText);
            return;
        }
        if (!queueSelectionMode && doubleMode) {
            const item = pageListRef.current.find(candidate => candidate.getHash() === hash);
            if (!item) return;
            showGateRef.current!.cancel();
            if (selectedRef.current === hash) return;
            selectedRef.current = hash;
            setSelected(hash);
            refreshPreviewIfVisible(item);
            return;
        }
        activateClipboardCardRef.current(hash, plainText);
    };

    const openContextMenu = async (item: Item, clientX: number, clientY: number) => {
        suspendPointerSelection();
        showGateRef.current!.cancel();
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

        const cards = cardsContainerRef.current?.querySelectorAll<HTMLElement>(`[data-results-active="true"] .${styles["clipboard-card"]}`);
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

    const pointerSelectionAllowed = () => !tutorialActiveRef.current && !queueSelectionMode && !isSearchComposing && !isSearching
        && !historyRefreshingRef.current && !showGateRef.current!.pending
        && !contextMenu && !tabContextMenu && !tagCreateChoice && !deleteConfirmTab && !deleteConfirmRecordTag
        && !updateConfirmOpen && !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
    hoverAllowedRef.current = () => Boolean(clipboardBehaviorConfigRef.current?.hover_preview_enabled)
        && pointerSelectionAllowed();
    hoverCardRef.current = (hash, target) => {
        if (!pointerSelectionAllowed()) return;
        const item = pageListRef.current.find(candidate => candidate.getHash() === hash);
        if (!item) return;
        // A real pointer choice owns selection just like explicit card navigation.
        showGateRef.current!.cancel();
        if (selectedRef.current !== hash) {
            hoverPreviewRef.current?.cancel();
            selectedRef.current = hash;
            setSelected(hash);
            refreshPreviewIfVisible(item);
        }
        if (target.closest("button, a, input, textarea, [contenteditable=true]")) {
            hoverPreviewRef.current?.leave();
        } else {
            hoverPreviewRef.current?.enter(item);
        }
    };
    if (!hoverPreviewRef.current) {
        hoverPreviewRef.current = createClipboardHoverPreview({
            allowed: () => hoverAllowedRef.current(),
            requestSequence: previewRequestSeqRef,
            open: (item, sequence, request, isCurrent) => openPreviewItem(item, sequence, "hover", request, isCurrent),
            dismiss: request => invoke("dismiss_hover_preview_window", { request }),
            onError: hoverError => error(`Failed to update hover preview: ${hoverError}`),
        });
    }
    useEffect(() => {
        const cancel = () => hoverPreviewRef.current?.cancel();
        const unlisten = listen<boolean>("preview-hover", event => hoverPreviewRef.current?.previewHover(event.payload));
        window.addEventListener("pointerdown", cancel, true);
        window.addEventListener("wheel", cancel, { capture: true, passive: true });
        return () => {
            cancel();
            window.removeEventListener("pointerdown", cancel, true);
            window.removeEventListener("wheel", cancel, true);
            void unlisten.then(dispose => dispose()).catch(e => error(`Failed to unlisten hover preview: ${e}`));
        };
    }, []);
    useEffect(() => {
        suspendPointerSelection();
        hoverPreviewRef.current?.cancel();
    }, [activeTab, searchWord, queueSelectionMode, contextMenu, tabContextMenu, tagCreateChoice, isSearchComposing]);

    const navigateSelectedCard = (direction: number) => {
        const list = pageListRef.current;
        if (list.length === 0) return;
        const currentIndex = list.findIndex(item => item.getHash() === selectedRef.current);
        const item = selectCardAt(currentIndex === -1 ? 0 : currentIndex + direction);
        if (item && item.getHash() !== list[currentIndex]?.getHash()) {
            refreshPreviewIfVisible(item, direction < 0 ? -1 : 1);
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
        deleteInFlight: deleteInFlightRef,
        hideWindow: hideCurrentWindowWithAnimation,
        onDelete: removeDeletedItemFromPage,
        refreshHistory: fetchHistory,
        showToast,
        t,
        updateItemTags: updateItemTagsInPage,
    });
    deleteClipboardItemRef.current = deleteClipboardItem;

    async function openTextEditor(item: Item) {
        if (!isEditableTextItem(item)) return;
        setContextMenu(null);
        try { await invoke("open_text_editor_window", { hash: item.getHash() }); }
        catch (reason) { showToast(t("editor.failed", { error: String(reason) }), "error"); }
    }

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
            onEditText: openTextEditor,
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
        if (!restartReady(updateState)) return;
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

    const openMemoryMonitor = () => {
        if (!import.meta.env.DEV || !developerMode) return;
        void invoke("open_dev_memory_window", { languageCode, themePreview: getResolvedTheme() })
            .catch(e => error(`Failed to open memory monitor: ${e}`));
    };

    const publishMemoryPreview = (language: string, theme: ResolvedTheme) => {
        if (!import.meta.env.DEV || !developerMode) return;
        void emitTo("devMemory", "dev-memory-open", { languageCode: language, themePreview: theme })
            .catch(e => error(`Failed to update memory preview: ${e}`));
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
        const next = languageCode === "Chinese" ? "English" : "Chinese";
        setPreviewLanguageCode(next);
        publishMemoryPreview(next, getResolvedTheme());
    };

    const toggleDeveloperTheme = () => {
        const nextTheme: ResolvedTheme = getResolvedTheme() === "dark" ? "light" : "dark";
        setThemePreview(nextTheme);
        setDeveloperTheme(nextTheme);
        publishMemoryPreview(languageCode, nextTheme);
    };

    const blockTutorialNavigation = () => {
        showToast(t("tutorial.finishFirst"), "info", 2200);
    };

    const setTutorialShortcutDemoAvailability = useCallback((enabled: boolean) => {
        void invoke("set_onboarding_shortcut_demo_enabled", { enabled })
            .catch(reason => error(`Failed to update tutorial shortcut demo state: ${reason}`));
    }, []);

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
    const emptyState = resolveClipboardEmptyState({
        loadedRequest: loadedHistoryRequest,
        resultCount: clipboardPage.list.length,
        keywords: searchWord as string,
        activeTab,
        isSearching,
    });
    const filteringResults = shouldMaskSearchResults(searchWord as string, isSearching);
    const resultsMotionKey = loadedHistoryRequest
        ? `clipboard-results:${loadedHistoryRequest.activeTab}:${loadedHistoryRequest.keywords}`
        : "clipboard-results:initial";
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
            <AnimatePresence mode="wait" initial={false}>
                {toast && (
                    <StatusToast
                        key={toast.id}
                        className={classes(styles, "clipboard-toast")}
                        kind={toast.kind}
                        message={toast.message}
                        actionLabel={toast.actionLabel}
                        onAction={toast.actionLabel && toast.onAction ? () => {
                            if (toastTimerRef.current !== null) {
                                window.clearTimeout(toastTimerRef.current);
                                toastTimerRef.current = null;
                            }
                            setToast(null);
                            toast.onAction?.();
                        } : undefined}
                    />
                )}
            </AnimatePresence>
            {/* Header */}
            <div className={classes(styles, "clipboard-header")}>
                {tutorialActive ? (
                    <div className={classes(styles, "tutorial-header-spacer")} />
                ) : (
                    <div
                        className={classes(styles, `search-box ${searchOpen || searchWord ? 'open' : ''}`)}
                        data-testid="clipboard-search-layout"
                    >
                        <ToolbarIconButton
                            className={classes(styles, "search-button")}
                            label={t("common.search")}
                            onClick={focusSearchInput}
                        >
                            <SearchIcon className={classes(styles, "search-icon")} fontSize="inherit" />
                        </ToolbarIconButton>
                        <AnimatePresence mode="wait" initial={false}>
                            {(searchOpen || searchWord) && (
                                <m.div
                                    key="clipboard-search-input"
                                    className={classes(styles, "search-input-motion")}
                                    variants={fadeMotion}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                >
                                    <InputBase
                                        inputRef={searchInputRef}
                                        className={classes(styles, "search-input")}
                                        inputProps={{
                                            "aria-label": t("common.search"),
                                            className: classes(styles, "search-input-field"),
                                        }}
                                        placeholder={t("common.search")}
                                        value={searchWord as string}
                                        onChange={handleSearchChange}
                                        onCompositionStart={() => setIsSearchComposing(true)}
                                        onCompositionEnd={(event) => {
                                            setSearchWord((event.target as HTMLInputElement).value);
                                            setIsSearchComposing(false);
                                        }}
                                        onBlur={() => {
                                            if (!searchWord) {
                                                setSearchOpen(false);
                                            }
                                        }}
                                    />
                                </m.div>
                            )}
                        </AnimatePresence>
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
                    onSelectTab={tab => {
                        showGateRef.current!.cancel();
                        setActiveTab(tab);
                    }}
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
                    onOpenMemoryMonitor={openMemoryMonitor}
                    onOpenSettings={tutorialActive ? blockTutorialNavigation : openConfigWindow}
                    updateReadyVersion={updateEntryVisible(updateState) ? updateState.availableVersion || "" : null}
                    updateInstalling={updateState.status === "installing"}
                    updateInAppStore={storeUpdateAvailable(updateState)}
                    onRestartToUpdate={() => {
                        if (storeUpdateAvailable(updateState)) {
                            void openAppStore().catch(e => error(`Failed to open App Store: ${e}`));
                        } else if (restartReady(updateState)) {
                            setUpdateConfirmOpen(true);
                        }
                    }}
                />
            </div>

            {/* Cards Grid */}
            <div
                className={classes(styles, `cards-container${queueSelectionMode ? " queue-selection-mode" : ""}`)}
                ref={cardsContainerRef}
                aria-busy={filteringResults}
                onScroll={() => {
                    hoverPreviewRef.current?.cancel();
                    handleCardsScroll();
                    if (!tutorialActive) maybeLoadMoreHistory();
                }}
                onPointerLeave={handleCardsPointerLeave}
                onPointerOut={event => {
                    const card = (event.target as Element).closest<HTMLElement>(`.${styles["clipboard-card"]}`);
                    if (card && event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
                    hoverPreviewRef.current?.leave();
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
                onDoubleClickCapture={handleCardsDoubleClick}
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
                        onShortcutDemoAvailabilityChange={setTutorialShortcutDemoAvailability}
                        onComplete={completeTutorial}
                    />
                ) : (
                    <div className={styles["cards-results-stack"]}>
                        <AnimatePresence mode="wait" initial={false}>
                            <ClipboardResultsSurface
                                key={resultsMotionKey}
                                className={classes(styles, `cards-grid${emptyState ? " clipboard-empty-grid" : ""}`)}
                                masked={filteringResults}
                                onFocusedExit={rememberFocusedResultExit}
                                onActiveMount={restoreFocusedResult}
                            >
                                {emptyState ? (
                                    <div
                                        className={classes(styles, "clipboard-empty-state")}
                                        role="status"
                                        aria-live="polite"
                                        aria-atomic="true"
                                    >
                                        <span className={classes(styles, "clipboard-empty-icon")} aria-hidden="true">
                                            <ContentPasteSearchOutlinedIcon />
                                        </span>
                                        <strong>{t(emptyState === "filtered" ? "clipboard.noResults" : "clipboard.emptyHistory")}</strong>
                                        <span>{t(emptyState === "filtered" ? "clipboard.noResults.desc" : "clipboard.emptyHistory.desc")}</span>
                                    </div>
                                ) : (
                                    <>
                                        <AnimatePresence mode="popLayout" initial={false}>
                                            {clipboardPage.list.map((item, index) => (
                                                <ClipboardCard
                                                    key={item.getHash() as string}
                                                    item={item}
                                                    selected={queueSelectionMode
                                                        ? queueSelectedHashes.includes(item.getHash() as string)
                                                        : selected === item.getHash()}
                                                    selectionMode={queueSelectionMode}
                                                    dragDisabled={tutorialActive}
                                                    simulatedHover={simulatedHoverHash === item.getHash()}
                                                    refreshKey={fileRefreshKey}
                                                    searchQuery={searchWord as string}
                                                    shortcutHint={altHintsVisible && index < 9 ? String(index + 1) : undefined}
                                                    filterMotionRequestSeq={filterMotionRequest?.hashes.includes(item.getHash() as string)
                                                        ? filterMotionRequest.requestSeq
                                                        : undefined}
                                                    filterMotionIndex={index}
                                                    mediaPlaybackReady={animationState === 'entered'}
                                                    t={t}
                                                    onContextMenu={openClipboardContextMenu}
                                                    onActivate={activateClipboardCard}
                                                    onDragUnavailable={() => showToast(t("clipboard.dragTextPreparing"), "warning")}
                                                />
                                            ))}
                                        </AnimatePresence>
                                        <AnimatePresence mode="wait" initial={false}>
                                            {isLoadingMore && (
                                                <m.div
                                                    key="history-loading-more"
                                                    className={classes(styles, "history-loading-card")}
                                                    role="status"
                                                    aria-live="polite"
                                                    variants={listItemMotion}
                                                    initial="initial"
                                                    animate="animate"
                                                    exit="exit"
                                                >
                                                    {t("common.loading")}
                                                </m.div>
                                            )}
                                        </AnimatePresence>
                                    </>
                                )}
                            </ClipboardResultsSurface>
                        </AnimatePresence>
                    </div>
                )}
                <AnimatePresence mode="wait" initial={false}>
                    {!tutorialActive && filteringResults && (
                        <m.div
                            key="search-filtering-overlay"
                            className={classes(styles, "search-filtering-overlay")}
                            role="status"
                            aria-live="polite"
                            variants={fadeMotion}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                        >
                            <span className={classes(styles, "search-filtering-status")}>
                                <CircularProgress size={18} thickness={5} aria-hidden="true" />
                                <span>{t("common.loading")}</span>
                            </span>
                        </m.div>
                    )}
                </AnimatePresence>
            </div>
            <AnimatePresence mode="wait" initial={false}>
                {queueSelectionMode && (
                    <m.div
                        key="paste-queue-selection"
                        className={classes(styles, "paste-queue-selection-positioner")}
                        variants={fadeMotion}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                    >
                        <m.div
                            className={classes(styles, "paste-queue-selection-bar")}
                            role="toolbar"
                            aria-label={t("pasteQueue.selectTitle")}
                            variants={listItemMotion}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                        >
                            <strong>{t("pasteQueue.selectTitle")}</strong>
                            <AnimatePresence mode="wait" initial={false}>
                                <m.span
                                    key={queueSelectedHashes.length}
                                    data-motion-preset="stateIndicator"
                                    variants={stateIndicatorMotion}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                >
                                    {queueSelectedHashes.length}
                                </m.span>
                            </AnimatePresence>
                            <Button variant="contained" className={classes(styles, "primary")} onClick={() => void addSelectedItemsToPasteQueue()}>
                                {t("pasteQueue.addSelected", { count: queueSelectedHashes.length })}
                            </Button>
                        </m.div>
                    </m.div>
                )}
            </AnimatePresence>
            <AnimatePresence mode="wait" initial={false}>
                {tagCreateChoice && (
                    <TagCreateChoicePopover
                        key="tag-create-choice"
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
                        key="clipboard-context-menu"
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
                        key="tab-context-menu"
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
            </AnimatePresence>
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
            <UpdateConfirmDialog
                open={updateConfirmOpen && restartReady(updateState)}
                title={t("clipboard.updateConfirmTitle")}
                description={t("clipboard.updateConfirmDesc", { version: updateState.availableVersion || "" })}
                cancelLabel={t("common.cancel")}
                confirmLabel={t("clipboard.updateReadyAction")}
                onCancel={() => setUpdateConfirmOpen(false)}
                onConfirm={() => {
                    setUpdateConfirmOpen(false);
                    void restartForUpdate();
                }}
            />
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
