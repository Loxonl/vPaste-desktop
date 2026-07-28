import { useEffect, useRef, useState } from "react";
import styles from "./TabEditor.module.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import CloseIcon from "@mui/icons-material/Close";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import { type AppSourceOption, compactAppSourceName, displayAppSource } from "./appSource";
import { loadAndApplyTheme } from "../theme";
import { applyNameEmoji, selectedNameEmoji } from "./nameEmoji";

type FavoriteFilter = "any" | "yes" | "no";
type DateUnit = "minute" | "hour" | "day" | "week" | "month";
type TabEditorMode = "add" | "edit";
type TagKind = "filter" | "record";

type CustomTabFilter = {
    itemType: string;
    appSource: string;
    appSources: string[];
    favorite: FavoriteFilter;
    relativeAmount: string;
    relativeUnit: DateUnit;
};

type CustomTab = {
    id: string;
    name: string;
    filter: CustomTabFilter;
};

type ItemTag = {
    id: number;
    name: string;
};

type TabEditorPayload = {
    mode: TabEditorMode;
    kind?: TagKind;
    tab?: CustomTab;
    recordTag?: ItemTag;
    tabs?: CustomTab[];
    languageCode?: string;
};

const CUSTOM_TABS_STORAGE_KEY = "vpaste.customTabs.v1";
const PENDING_TAB_EDITOR_PAYLOAD_KEY = "vpaste.pendingTabEditorPayload";
const PENDING_ITEM_TAGS_CHANGED_KEY = "vpaste.pendingItemTagsChangedPayload";
const PENDING_EMOJI_PICKER_PAYLOAD_KEY = "vpaste.pendingEmojiPickerPayload";
const PENDING_EMOJI_SELECTION_KEY = "vpaste.pendingEmojiSelection";
const TAB_EDITOR_WIDTH = 286;
const MIN_TAG_EDITOR_HEIGHT = 154;
const MAX_TAG_EDITOR_HEIGHT = 520;
const RECORD_TAG_TAB_PREFIX = "record:";
const DEFAULT_CUSTOM_FILTER: CustomTabFilter = {
    itemType: "",
    appSource: "",
    appSources: [],
    favorite: "any",
    relativeAmount: "",
    relativeUnit: "day",
};
function recordTagTabId(id: number): string {
    return `${RECORD_TAG_TAB_PREFIX}${id}`;
}

function loadCustomTabs(): CustomTab[] {
    return normalizeCustomTabs(localStorage.getItem(CUSTOM_TABS_STORAGE_KEY));
}

function normalizeAppSources(filter: Partial<CustomTabFilter> & { appSource?: unknown; appSources?: unknown }): string[] {
    if (Array.isArray(filter.appSources)) {
        return filter.appSources.filter(source => typeof source === "string" && source.trim()).map(source => source.trim());
    }
    return typeof filter.appSource === "string" && filter.appSource.trim() ? [filter.appSource.trim()] : [];
}

function normalizeCustomTabs(raw: unknown): CustomTab[] {
    try {
        if (!raw) return [];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed)
            ? parsed
                .filter(tab => typeof tab?.id === "string" && typeof tab?.name === "string")
                .map(tab => {
                    const filter = { ...DEFAULT_CUSTOM_FILTER, ...(tab.filter || {}) };
                    const { tagName: _legacyRecordTagName, ...filterWithoutRecordTag } = filter as typeof DEFAULT_CUSTOM_FILTER & { tagName?: unknown };
                    return {
                        id: tab.id,
                        name: tab.name,
                        filter: { ...filterWithoutRecordTag, appSources: normalizeAppSources(filter) },
                    };
                })
            : [];
    } catch {
        return [];
    }
}

function saveCustomTabs(tabs: CustomTab[]) {
    localStorage.setItem(CUSTOM_TABS_STORAGE_KEY, JSON.stringify(tabs));
    void invoke('save_custom_tabs', { tabs })
        .catch(e => error(`Failed to persist custom tabs: ${e}`));
}

export default function TabEditor() {
    const { t, setLanguageCode, languageCode } = useLanguage();
    const [mode, setMode] = useState<TabEditorMode>("add");
    const [draft, setDraft] = useState<CustomTab>({
        id: "",
        name: "",
        filter: { ...DEFAULT_CUSTOM_FILTER },
    });
    const [baseTabs, setBaseTabs] = useState<CustomTab[]>([]);
    const [tagKind, setTagKind] = useState<TagKind>("filter");
    const [recordTagId, setRecordTagId] = useState<number | null>(null);
    const [recentAppSources, setRecentAppSources] = useState<AppSourceOption[]>([]);
    const [appSourceOpen, setAppSourceOpen] = useState(false);
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const emojiButtonRef = useRef<HTMLButtonElement>(null);

    const closeWindow = () => {
        void invoke('hide_tab_editor_window').catch(e => error(`Failed to hide tab editor: ${e}`));
    };

    const openFromPendingPayload = () => {
        const pendingPayload = localStorage.getItem(PENDING_TAB_EDITOR_PAYLOAD_KEY);
        if (!pendingPayload) return;
        try {
            openFromPayload(JSON.parse(pendingPayload) as TabEditorPayload);
        } catch (e) {
            error(`Failed to parse pending tab editor payload: ${e}`);
        }
    };

    const applyPendingEmojiSelection = () => {
        const pendingEmoji = localStorage.getItem(PENDING_EMOJI_SELECTION_KEY);
        if (pendingEmoji === null) return;
        localStorage.removeItem(PENDING_EMOJI_SELECTION_KEY);
        chooseNameEmoji(pendingEmoji);
    };

    const openFromPayload = (payload: TabEditorPayload) => {
        void loadAndApplyTheme();
        if (payload.languageCode) {
            setLanguageCode(payload.languageCode);
        }
        const kind = payload.kind || "filter";
        setMode(payload.mode);
        setTagKind(kind);
        setRecordTagId(kind === "record" ? payload.recordTag?.id ?? null : null);
        setBaseTabs(Array.isArray(payload.tabs) ? normalizeCustomTabs(payload.tabs) : loadCustomTabs());
        setDraft(kind === "record"
            ? { id: "", name: payload.recordTag?.name || "", filter: { ...DEFAULT_CUSTOM_FILTER } }
            : payload.tab
                ? normalizeCustomTabs([payload.tab])[0] || { ...payload.tab, filter: { ...DEFAULT_CUSTOM_FILTER, ...payload.tab.filter, appSources: normalizeAppSources(payload.tab.filter || {}) } }
                : { id: "", name: "", filter: { ...DEFAULT_CUSTOM_FILTER } });
        localStorage.removeItem(PENDING_TAB_EDITOR_PAYLOAD_KEY);
        setAppSourceOpen(false);
        setEmojiPickerOpen(false);
        if (kind === "filter") {
            void invoke<AppSourceOption[]>('list_recent_app_source_options', { days: 7 })
                .then(setRecentAppSources)
                .catch(e => error(`Failed to load recent app sources: ${e}`));
        } else {
            setRecentAppSources([]);
        }
        window.setTimeout(() => {
            document.querySelector<HTMLInputElement>(`.${styles["tab-editor-panel"]} input`)?.focus();
        }, 0);
    };

    useEffect(() => {
        openFromPendingPayload();

        const unlistenOpen = listen<string>('tab-editor-open', event => {
            try {
                openFromPayload(JSON.parse(event.payload) as TabEditorPayload);
            } catch (e) {
                error(`Failed to parse tab editor payload: ${e}`);
            }
        });
        const unlistenEmoji = listen<string>('emoji-prefix-selected', event => {
            chooseNameEmoji(event.payload || "");
        });

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeWindow();
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "enter") {
                event.preventDefault();
                saveDraft();
            }
        };
        const handleFocus = () => {
            setEmojiPickerOpen(false);
            applyPendingEmojiSelection();
            openFromPendingPayload();
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                applyPendingEmojiSelection();
                openFromPendingPayload();
            }
        };
        const handleStorage = (event: StorageEvent) => {
            if (event.key === PENDING_EMOJI_SELECTION_KEY) {
                applyPendingEmojiSelection();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("focus", handleFocus);
        window.addEventListener("storage", handleStorage);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            unlistenOpen.then(f => f()).catch(e => error(`Failed to unlisten tab editor: ${e}`));
            unlistenEmoji.then(f => f()).catch(e => error(`Failed to unlisten emoji picker: ${e}`));
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("focus", handleFocus);
            window.removeEventListener("storage", handleStorage);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [draft, mode, tagKind, recordTagId]);

    useEffect(() => {
        const resizeToContent = () => {
            const panel = panelRef.current;
            if (!panel) return;
            const maxHeight = Math.min(MAX_TAG_EDITOR_HEIGHT, Math.max(MIN_TAG_EDITOR_HEIGHT, window.screen.availHeight - 24));
            const height = Math.ceil(Math.max(MIN_TAG_EDITOR_HEIGHT, Math.min(panel.offsetHeight, maxHeight)));
            void invoke('set_window_size', { width: TAB_EDITOR_WIDTH, height })
                .catch(e => error(`Failed to resize tab editor: ${e}`));
        };
        const frame = window.requestAnimationFrame(resizeToContent);
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeToContent);
        if (panelRef.current && observer) {
            observer.observe(panelRef.current);
        }
        return () => {
            window.cancelAnimationFrame(frame);
            observer?.disconnect();
        };
    }, [mode, tagKind, draft, appSourceOpen, recentAppSources.length]);

    const selectedAppSources = normalizeAppSources(draft.filter);
    const selectedAppSourceOptions = selectedAppSources
        .map(source => recentAppSources.find(option => option.source === source) || { source })
        .filter((option, index, options) => options.findIndex(candidate => candidate.source === option.source) === index);
    const selectedEmoji = selectedNameEmoji(draft.name);

    const chooseNameEmoji = (emoji: string) => {
        setDraft(tab => ({
            ...tab,
            name: applyNameEmoji(tab.name, emoji),
        }));
        setEmojiPickerOpen(false);
    };

    const openEmojiPicker = () => {
        const button = emojiButtonRef.current;
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const payload = {
            selectedEmoji,
            languageCode,
        };
        localStorage.setItem(PENDING_EMOJI_PICKER_PAYLOAD_KEY, JSON.stringify(payload));
        setEmojiPickerOpen(true);
        setAppSourceOpen(false);
        void invoke('open_emoji_picker_window', {
            anchorLeft: rect.left,
            anchorTop: rect.top,
            anchorRight: rect.right,
            payload: JSON.stringify(payload),
        })
            .catch(e => {
                setEmojiPickerOpen(false);
                error(`Failed to open emoji picker: ${e}`);
            });
    };

    const toggleAppSourcePicker = () => {
        setAppSourceOpen(open => !open);
        setEmojiPickerOpen(false);
        void invoke('hide_emoji_picker_window').catch(e => error(`Failed to hide emoji picker: ${e}`));
    };

    const clearAppSources = () => {
        setDraft(tab => ({
            ...tab,
            filter: { ...tab.filter, appSource: "", appSources: [] },
        }));
    };

    const toggleAppSource = (source: string) => {
        setDraft(tab => {
            const current = normalizeAppSources(tab.filter);
            const appSources = current.includes(source)
                ? current.filter(value => value !== source)
                : [...current, source];
            return {
                ...tab,
                filter: { ...tab.filter, appSource: appSources[0] || "", appSources },
            };
        });
    };

    const appSourceSummary = () => {
        if (selectedAppSources.length === 0) return t("tabs.any");
        if (selectedAppSources.length === 1) return displayAppSource(selectedAppSources[0], t);
        return t("tabs.selectedCount", { count: selectedAppSources.length });
    };

    const defaultTabName = () => {
        if (selectedAppSources.length === 1) return compactAppSourceName(selectedAppSources[0], t);
        if (selectedAppSources.length > 1) return appSourceSummary();
        if (draft.filter.itemType) {
            const typeLabels: Record<string, string> = {
                Text: t("type.text"),
                Image: t("type.image"),
                File: t("type.file"),
                Link: t("type.link"),
                Color: t("type.color"),
            };
            return typeLabels[draft.filter.itemType] || draft.filter.itemType;
        }
        if (draft.filter.favorite === "yes") return t("tabs.favoriteOnly");
        if (draft.filter.favorite === "no") return t("tabs.notFavorite");
        if (draft.filter.relativeAmount) {
            return `${t("tabs.recent")}${draft.filter.relativeAmount}${t(`tabs.unit.${draft.filter.relativeUnit}`)}`;
        }
        return t("tabs.add");
    };

    const saveDraft = async () => {
        if (tagKind === "record") {
            const name = draft.name.trim();
            if (!name) return;
            try {
                const tag = mode === "edit" && recordTagId !== null
                    ? await invoke<ItemTag>('rename_item_tag', { id: recordTagId, name })
                    : await invoke<ItemTag>('create_item_tag', { name });
                const activeId = mode === "add" ? recordTagTabId(tag.id) : undefined;
                const payload = { activeId, tag };
                localStorage.setItem(PENDING_ITEM_TAGS_CHANGED_KEY, JSON.stringify(payload));
                try {
                    await emit("item-tags-changed", payload);
                } catch (e) {
                    error(`Failed to notify item tags changed: ${e}`);
                }
                closeWindow();
            } catch (e) {
                error(`Failed to save record tag: ${e}`);
            }
            return;
        }

        const name = draft.name.trim() || defaultTabName();
        const tabs = baseTabs.length > 0 ? baseTabs : loadCustomTabs();
        let activeId = draft.id;
        let nextTabs: CustomTab[];
        if (mode === "edit" && draft.id) {
            const savedDraft = {
                ...draft,
                filter: {
                    ...draft.filter,
                    appSource: selectedAppSources[0] || "",
                    appSources: selectedAppSources,
                },
                name,
            };
            nextTabs = tabs.map(tab => tab.id === draft.id ? savedDraft : tab);
        } else {
            activeId = `tab-${Date.now()}`;
            nextTabs = [...tabs, {
                ...draft,
                filter: {
                    ...draft.filter,
                    appSource: selectedAppSources[0] || "",
                    appSources: selectedAppSources,
                },
                id: activeId,
                name,
            }];
        }
        const payload = { activeId, tabs: nextTabs };
        saveCustomTabs(nextTabs);
        void emitTo("clipboard", "custom-tabs-changed", payload)
            .catch(e => error(`Failed to notify custom tabs changed: ${e}`));
        void invoke("apply_custom_tabs_from_editor", { payload })
            .catch(e => error(`Failed to apply custom tabs through backend: ${e}`));
        closeWindow();
    };

    return (
        <div className={styles["tab-editor-window"]} onContextMenu={event => event.preventDefault()}>
            <div className={styles["tab-editor-panel"]} ref={panelRef}>
                <div className={styles["tab-editor-header"]}>
                    <strong>{tagKind === "record"
                        ? mode === "edit" ? t("tabs.editRecordTag") : t("tabs.addRecordTag")
                        : mode === "edit" ? t("tabs.edit") : t("tabs.add")}</strong>
                    <button type="button" className={styles["tab-editor-close"]} aria-label={t("common.close")} onClick={closeWindow}>
                        <CloseIcon fontSize="small" />
                    </button>
                </div>
                <label>
                    <span>{t("tabs.name")}</span>
                    <div className={styles["tab-name-composer"]}>
                        <div className={styles["emoji-prefix-select"]}>
                            <button
                                ref={emojiButtonRef}
                                type="button"
                                className={[styles["emoji-prefix-trigger"], selectedEmoji ? styles.selected : ""].join(" ")}
                                title={t("tabs.emojiPrefix")}
                                aria-label={t("tabs.emojiPrefix")}
                                aria-haspopup="menu"
                                aria-expanded={emojiPickerOpen}
                                onClick={openEmojiPicker}
                            >
                                {selectedEmoji || "＋"}
                            </button>
                        </div>
                        <input
                            value={draft.name}
                            maxLength={20}
                            onChange={event => setDraft(tab => ({ ...tab, name: event.target.value }))}
                        />
                    </div>
                </label>
                {tagKind === "record" && (
                    <p className={styles["record-tag-hint"]}>{t("tabs.recordTagHint")}</p>
                )}
                {tagKind === "filter" && (
                    <>
                        <label>
                            <span>{t("tabs.type")}</span>
                            <select
                                value={draft.filter.itemType}
                                onChange={event => setDraft(tab => ({
                                    ...tab,
                                    filter: { ...tab.filter, itemType: event.target.value },
                                }))}
                            >
                                <option value="">{t("tabs.any")}</option>
                                <option value="Text">{t("type.text")}</option>
                                <option value="Image">{t("type.image")}</option>
                                <option value="File">{t("type.file")}</option>
                                <option value="Link">{t("type.link")}</option>
                                <option value="Color">{t("type.color")}</option>
                            </select>
                        </label>
                        <label>
                            <span>{t("tabs.sourceApp")}</span>
                            <div className={styles["app-source-select"]}>
                                <button
                                    type="button"
                                    className={styles["app-source-trigger"]}
                                    onClick={toggleAppSourcePicker}
                                >
                                    {selectedAppSources.length > 0 && (
                                        selectedAppSourceOptions.slice(0, 2).map(option => (
                                            option.icon_path ? (
                                                <img key={option.source} src={convertFileSrc(option.icon_path)} alt="" />
                                            ) : (
                                                <span key={option.source} className={styles["app-source-placeholder-icon"]} />
                                            )
                                        ))
                                    )}
                                    <span className={styles["app-source-label"]}>{appSourceSummary()}</span>
                                </button>
                                {appSourceOpen && (
                                    <div className={styles["app-source-menu"]}>
                                        <button type="button" className={[styles["app-source-option"], styles["app-source-option-plain"], selectedAppSources.length === 0 ? styles.selected : ""].join(" ")} onClick={clearAppSources}>
                                            <span>{t("tabs.any")}</span>
                                        </button>
                                        {recentAppSources.map(option => (
                                            <button
                                                key={option.source}
                                                type="button"
                                                className={[styles["app-source-option"], selectedAppSources.includes(option.source) ? styles.selected : ""].join(" ")}
                                                onClick={() => toggleAppSource(option.source)}
                                            >
                                                {option.icon_path ? (
                                                    <img src={convertFileSrc(option.icon_path)} alt="" />
                                                ) : (
                                                    <span className={styles["app-source-placeholder-icon"]} />
                                                )}
                                                <span className={styles["app-source-option-label"]}>{displayAppSource(option.source, t)}</span>
                                                {selectedAppSources.includes(option.source) && <span className={styles["app-source-check"]}>✓</span>}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </label>
                        <label>
                            <span>{t("tabs.favoriteFilter")}</span>
                            <select
                                value={draft.filter.favorite}
                                onChange={event => setDraft(tab => ({
                                    ...tab,
                                    filter: { ...tab.filter, favorite: event.target.value as FavoriteFilter },
                                }))}
                            >
                                <option value="any">{t("tabs.any")}</option>
                                <option value="yes">{t("tabs.favoriteOnly")}</option>
                                <option value="no">{t("tabs.notFavorite")}</option>
                            </select>
                        </label>
                        <div className={styles["tab-editor-row"]}>
                            <label>
                                <span>{t("tabs.recent")}</span>
                                <input
                                    type="number"
                                    min="1"
                                    value={draft.filter.relativeAmount}
                                    placeholder={t("tabs.unlimited")}
                                    onChange={event => setDraft(tab => ({
                                        ...tab,
                                        filter: { ...tab.filter, relativeAmount: event.target.value },
                                    }))}
                                />
                            </label>
                            <label>
                                <span>{t("tabs.unit")}</span>
                                <select
                                    value={draft.filter.relativeUnit}
                                    onChange={event => setDraft(tab => ({
                                        ...tab,
                                        filter: { ...tab.filter, relativeUnit: event.target.value as DateUnit },
                                    }))}
                                >
                                    <option value="minute">{t("tabs.unit.minute")}</option>
                                    <option value="hour">{t("tabs.unit.hour")}</option>
                                    <option value="day">{t("tabs.unit.day")}</option>
                                    <option value="week">{t("tabs.unit.week")}</option>
                                    <option value="month">{t("tabs.unit.month")}</option>
                                </select>
                            </label>
                        </div>
                    </>
                )}
                <div className={styles["tab-editor-actions"]}>
                    <button type="button" className={styles["tab-save-button"]} onClick={saveDraft}>
                        {t("tabs.save")}
                    </button>
                </div>
            </div>
        </div>
    );
}
