import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Button from "@mui/material/Button";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DragIndicatorRoundedIcon from "@mui/icons-material/DragIndicatorRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import SwapVertRoundedIcon from "@mui/icons-material/SwapVertRounded";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineMenuItem, InlineMenuSurface } from "../ui/InlineMenu";
import { StatusToast } from "../ui/StatusToast";
import { ToolbarIconButton } from "../ui/ToolbarIconButton";
import { AnimatePresence, m, useMotionPreset } from "../ui/motion";
import { Item, ItemType } from "./Item";
import {
    emptyPasteQueueState,
    parsePasteQueueState,
    type PasteQueueState,
} from "./pasteQueueState";
import {
    clampQueueDragOffset,
    queueOrderForOffset,
    queueVerticalTransforms,
    type QueueRowMetric,
} from "./pasteQueueDrag";
import styles from "./PasteQueue.module.css";

type QueuePointerDrag = {
    hash: string;
    pointerId: number;
    startY: number;
    offsetY: number;
    order: string[];
    metrics: QueueRowMetric[];
};

type NativePointerPosition = {
    x: number;
    y: number;
    inside: boolean;
};

function demoState(): PasteQueueState {
    const now = Date.now();
    const variant = new URLSearchParams(window.location.search).get("state");
    const state: PasteQueueState = {
        ...emptyPasteQueueState(),
        active: true,
        revision: 1,
        items: [
            new Item(1, "demo-1", ItemType.Text, "function doClickAction() {", now),
            new Item(2, "demo-2", ItemType.Link, "https://vpaste.app", now - 1),
            new Item(3, "demo-3", ItemType.Color, "#5B8CFF", now - 2),
            new Item(4, "demo-4", ItemType.File, JSON.stringify(["/Users/demo/notes.txt"]), now - 3),
        ],
    };
    if (variant === "empty") {
        state.items = [];
    } else if (variant === "error") {
        state.error = { hash: "demo-1", message: "无法写入目标应用，请重试或删除此项" };
    } else if (variant === "undo") {
        state.undoHash = "consumed-demo";
        state.undoExpiresAt = now + 5_000;
    }
    return state;
}

function queueItemLabel(item: Item) {
    if (item.getType() === ItemType.File) {
        try {
            const paths = JSON.parse(item.getContent()) as string[];
            const first = paths[0]?.split(/[\\/]/).pop() || "";
            return paths.length > 1 ? `${first} +${paths.length - 1}` : first;
        } catch {
            return item.getContent();
        }
    }
    if (item.getType() === ItemType.Link) {
        return item.getContent().split("|||")[0];
    }
    if (item.getType() === ItemType.TextFile) {
        return item.getPreviewContent();
    }
    return item.getTextContent() || item.getContent();
}

function QueueImagePreview({ item }: { item: Item }) {
    const previewPath = item.getPreviewContent();
    const sourcePath = item.getContent();
    const [src, setSrc] = useState("");
    const fallbackAttempted = useRef(false);

    useEffect(() => {
        let cancelled = false;
        fallbackAttempted.current = false;
        setSrc("");

        const load = async () => {
            try {
                const assetPath = await invoke<string>(
                    "history_image_card_preview_asset_path",
                    { path: previewPath },
                );
                if (!cancelled) setSrc(convertFileSrc(assetPath));
            } catch {
                try {
                    const dataUrl = await invoke<string>("history_file_data_url", {
                        path: previewPath,
                    });
                    if (!cancelled) setSrc(dataUrl);
                } catch (reason) {
                    if (!cancelled) {
                        error(`Failed to load paste queue image preview: ${reason}`);
                    }
                }
            }
        };

        if (previewPath) void load();
        return () => {
            cancelled = true;
        };
    }, [item.getHash(), previewPath]);

    const recoverSource = () => {
        if (fallbackAttempted.current || !sourcePath) {
            setSrc("");
            return;
        }
        fallbackAttempted.current = true;
        setSrc("");
        void invoke<string>("history_file_data_url", { path: sourcePath })
            .then(setSrc)
            .catch(reason => error(`Failed to recover paste queue image preview: ${reason}`));
    };

    return (
        <span className={styles.thumbnailFrame} aria-hidden="true">
            {src && (
                <img
                    className={styles.thumbnail}
                    src={src}
                    alt=""
                    draggable={false}
                    decoding="async"
                    onError={recoverSource}
                />
            )}
        </span>
    );
}

function QueuePreview({ item }: { item: Item }) {
    if (item.getType() === ItemType.Image) {
        return <QueueImagePreview item={item} />;
    }
    if (item.getType() === ItemType.Color) {
        return <span className={styles.swatch} style={{ background: item.getContent().trim() }} aria-hidden="true" />;
    }
    return null;
}

export default function PasteQueue() {
    const { t } = useLanguage();
    const fadeMotion = useMotionPreset("fade");
    const listItemMotion = useMotionPreset("listItem");
    const [state, setState] = useState<PasteQueueState>(() => (
        "__TAURI_INTERNALS__" in window ? emptyPasteQueueState() : demoState()
    ));
    const [drag, setDrag] = useState<QueuePointerDrag | null>(null);
    const [pointerHash, setPointerHash] = useState<string | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmingClear, setConfirmingClear] = useState(false);
    const [clock, setClock] = useState(Date.now());
    const rowElements = useRef(new Map<string, HTMLLIElement>());
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!("__TAURI_INTERNALS__" in window)) return;
        void invoke<Parameters<typeof parsePasteQueueState>[0]>("get_paste_queue_state")
            .then(payload => setState(current => {
                const next = parsePasteQueueState(payload);
                return next.revision >= current.revision ? next : current;
            }))
            .catch(reason => error(`Failed to load paste queue: ${reason}`));
        const unlisten = listen<Parameters<typeof parsePasteQueueState>[0]>(
            "paste-queue-state-changed",
            event => setState(current => {
                const next = parsePasteQueueState(event.payload);
                return next.revision >= current.revision ? next : current;
            }),
        );
        const unlistenMenuDismiss = listen(
            "paste-queue-dismiss-menu",
            () => setMenuOpen(false),
        );
        const unlistenPointerPosition = listen<NativePointerPosition>(
            "paste-queue-pointer-position",
            event => {
                if (!event.payload.inside) {
                    setPointerHash(null);
                    return;
                }
                const row = document
                    .elementFromPoint(event.payload.x, event.payload.y)
                    ?.closest<HTMLElement>("[data-queue-hash]");
                setPointerHash(row?.dataset.queueHash ?? null);
            },
        );
        return () => {
            void unlisten.then(remove => remove());
            void unlistenMenuDismiss.then(remove => remove());
            void unlistenPointerPosition.then(remove => remove());
        };
    }, []);

    useEffect(() => {
        if (!("__TAURI_INTERNALS__" in window)) return;
        void invoke("set_paste_queue_menu_open", { open: menuOpen })
            .catch(reason => error(`Failed to sync paste queue menu state: ${reason}`));
    }, [menuOpen]);

    useEffect(() => () => {
        if (!("__TAURI_INTERNALS__" in window)) return;
        void invoke("set_paste_queue_menu_open", { open: false })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!state.undoExpiresAt) return;
        const timer = window.setInterval(() => setClock(Date.now()), 200);
        return () => window.clearInterval(timer);
    }, [state.undoExpiresAt]);

    useEffect(() => {
        if (!menuOpen) return;

        const isInsideMenu = (target: EventTarget | null) => (
            target instanceof Node
            && (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target))
        );
        const dismissFromOutside = (event: Event) => {
            if (!isInsideMenu(event.target)) setMenuOpen(false);
        };
        const dismissFromWindowBlur = () => setMenuOpen(false);
        const dismissWhenHidden = () => {
            if (document.hidden) setMenuOpen(false);
        };
        const dismissFromEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setMenuOpen(false);
            menuButtonRef.current?.focus();
        };

        document.addEventListener("pointerdown", dismissFromOutside, true);
        document.addEventListener("focusin", dismissFromOutside, true);
        document.addEventListener("keydown", dismissFromEscape, true);
        document.addEventListener("visibilitychange", dismissWhenHidden);
        window.addEventListener("blur", dismissFromWindowBlur);
        return () => {
            document.removeEventListener("pointerdown", dismissFromOutside, true);
            document.removeEventListener("focusin", dismissFromOutside, true);
            document.removeEventListener("keydown", dismissFromEscape, true);
            document.removeEventListener("visibilitychange", dismissWhenHidden);
            window.removeEventListener("blur", dismissFromWindowBlur);
        };
    }, [menuOpen]);

    useEffect(() => {
        const hashes = state.items.map(item => item.getHash() as string);
        setDrag(current => {
            if (!current) return current;
            const startedWith = current.metrics.map(metric => metric.hash);
            return hashes.length === startedWith.length
                && hashes.every((hash, index) => hash === startedWith[index])
                ? current
                : null;
        });
    }, [state.items]);

    const undoVisible = Boolean(state.undoHash && state.undoExpiresAt && state.undoExpiresAt > clock);
    const dragTransforms = useMemo(
        () => drag
            ? queueVerticalTransforms(drag.metrics, drag.order, drag.hash, drag.offsetY)
            : {},
        [drag],
    );
    const countLabel = useMemo(
        () => t("pasteQueue.count", { count: state.items.length, capacity: state.capacity }),
        [state.items.length, state.capacity, t],
    );

    const run = async <T,>(command: string, args?: Record<string, unknown>) => {
        try {
            const payload = await invoke<Parameters<typeof parsePasteQueueState>[0] | T>(command, args);
            if (payload && typeof payload === "object" && "revision" in payload) {
                setState(current => {
                    const next = parsePasteQueueState(
                        payload as Parameters<typeof parsePasteQueueState>[0],
                    );
                    return next.revision >= current.revision ? next : current;
                });
            }
            return payload;
        } catch (reason) {
            error(`Paste queue command ${command} failed: ${reason}`);
            return null;
        }
    };

    const close = () => void run("set_paste_queue_active", { active: false });
    const paste = (hash: string) => void run("paste_queue_item", { hash });
    const remove = (hash: string) => void run("remove_paste_queue_item", { hash });
    const reverse = () => void run("reverse_paste_queue");
    const undo = () => void run("undo_paste_queue_consume");

    const clear = () => {
        setMenuOpen(false);
        setConfirmingClear(false);
        void run("clear_paste_queue");
    };

    const startPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, hash: string) => {
        if (event.isPrimary === false || event.button !== 0 || state.busy) return;
        const metrics = state.items.flatMap(item => {
            const itemHash = item.getHash() as string;
            const element = rowElements.current.get(itemHash);
            if (!element) return [];
            const bounds = element.getBoundingClientRect();
            return [{ hash: itemHash, top: bounds.top, height: bounds.height }];
        });
        if (metrics.length !== state.items.length) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDrag({
            hash,
            pointerId: event.pointerId,
            startY: event.clientY,
            offsetY: 0,
            order: metrics.map(metric => metric.hash),
            metrics,
        });
    };

    const movePointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        setDrag(current => {
            if (!current || current.pointerId !== event.pointerId) return current;
            const rawOffset = event.clientY - current.startY;
            return {
                ...current,
                offsetY: clampQueueDragOffset(current.metrics, current.hash, rawOffset),
                order: queueOrderForOffset(current.metrics, current.hash, rawOffset),
            };
        });
    };

    const finishPointerDrag = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const nextOrder = drag.order;
        const previousOrder = state.items.map(item => item.getHash() as string);
        setDrag(null);
        if (!commit || nextOrder.every((hash, index) => hash === previousOrder[index])) return;

        setState(current => {
            const byHash = new Map(current.items.map(item => [item.getHash() as string, item]));
            const items = nextOrder.flatMap(hash => {
                const item = byHash.get(hash);
                return item ? [item] : [];
            });
            return items.length === current.items.length ? { ...current, items } : current;
        });
        void run("reorder_paste_queue", { hashes: nextOrder }).then(result => {
            if (result === null) void run("get_paste_queue_state");
        });
    };

    const moveByKeyboard = (hash: string, offset: number) => {
        const hashes = state.items.map(item => item.getHash() as string);
        const from = hashes.indexOf(hash);
        const target = from + offset;
        if (from < 0 || target < 0 || target >= hashes.length) return;
        hashes.splice(from, 1);
        hashes.splice(target, 0, hash);
        void run("reorder_paste_queue", { hashes });
    };

    return (
        <main
            className={styles.shell}
            data-testid="paste-queue"
            onPointerMove={movePointerDrag}
            onPointerUp={event => finishPointerDrag(event, true)}
            onPointerCancel={event => finishPointerDrag(event, false)}
        >
            <section className={styles.panel} aria-label={t("pasteQueue.title")}>
                <header
                    className={styles.header}
                    onMouseDown={event => {
                        if ((event.target as HTMLElement).closest("button")) return;
                        void getCurrentWindow().startDragging();
                    }}
                >
                    <ToolbarIconButton className={styles.iconButton} onClick={close} label={t("pasteQueue.close")}>
                        <CloseRoundedIcon fontSize="small" />
                    </ToolbarIconButton>
                    <div className={styles.titleGroup}>
                        <strong>{t("pasteQueue.title")}</strong>
                        <span>{countLabel}</span>
                    </div>
                    <div className={styles.headerActions}>
                        <ToolbarIconButton className={styles.iconButton} onClick={reverse} disabled={state.busy || state.items.length < 2} label={t("pasteQueue.reverse")}>
                            <SwapVertRoundedIcon fontSize="small" />
                        </ToolbarIconButton>
                        <ToolbarIconButton ref={menuButtonRef} className={styles.iconButton} onClick={() => setMenuOpen(open => !open)} disabled={state.busy} label={t("pasteQueue.more")} aria-haspopup="menu" aria-expanded={menuOpen}>
                            <MoreHorizRoundedIcon fontSize="small" />
                        </ToolbarIconButton>
                    </div>
                    <AnimatePresence mode="wait" initial={false}>
                        {menuOpen && (
                            <InlineMenuSurface key="paste-queue-menu" ref={menuRef} className={styles.menu}>
                                <InlineMenuItem danger onClick={() => {
                                    menuButtonRef.current?.focus();
                                    setMenuOpen(false);
                                    setConfirmingClear(true);
                                }} disabled={state.busy || state.items.length === 0}>
                                    {t("pasteQueue.clear")}
                                </InlineMenuItem>
                            </InlineMenuSurface>
                        )}
                    </AnimatePresence>
                </header>

                <AnimatePresence mode="sync" initial={false}>
                    {state.items.length === 0 ? (
                        <m.div
                            key="paste-queue-empty"
                            className={styles.empty}
                            role="status"
                            variants={fadeMotion}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                        >
                            <strong>{t("pasteQueue.empty")}</strong>
                            <span>{t("pasteQueue.emptyIntercepting")}</span>
                        </m.div>
                    ) : (
                        <m.ol
                            key="paste-queue-list"
                            className={styles.list}
                            aria-label={t("pasteQueue.items")}
                            variants={fadeMotion}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                        >
                        {state.items.map((item, index) => {
                            const hash = item.getHash() as string;
                            const visualIndex = drag ? drag.order.indexOf(hash) : index;
                            return (
                                <li
                                    key={hash}
                                    ref={element => {
                                        if (element) rowElements.current.set(hash, element);
                                        else rowElements.current.delete(hash);
                                    }}
                                    className={`${styles.row} ${drag?.hash === hash ? styles.dragging : ""} ${drag ? styles.sorting : ""} ${pointerHash === hash ? styles.pointerInside : ""}`}
                                    style={{ transform: `translate3d(0, ${dragTransforms[hash] ?? 0}px, 0)` }}
                                    data-queue-hash={hash}
                                    data-pointer-hovered={pointerHash === hash}
                                    onPointerEnter={() => setPointerHash(hash)}
                                    onPointerMove={() => setPointerHash(hash)}
                                    onPointerLeave={() => setPointerHash(current => current === hash ? null : current)}
                                >
                                    <button
                                        type="button"
                                        className={styles.dragHandle}
                                        onPointerDown={event => startPointerDrag(event, hash)}
                                        disabled={state.busy}
                                        onKeyDown={event => {
                                            if (event.key === "ArrowUp") {
                                                event.preventDefault();
                                                moveByKeyboard(hash, -1);
                                            } else if (event.key === "ArrowDown") {
                                                event.preventDefault();
                                                moveByKeyboard(hash, 1);
                                            }
                                        }}
                                        aria-label={t("pasteQueue.drag")}
                                    >
                                        <DragIndicatorRoundedIcon fontSize="small" />
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.itemButton}
                                        onPointerDown={event => {
                                            if (event.pointerType === "mouse") event.preventDefault();
                                        }}
                                        onClick={() => paste(hash)}
                                        disabled={state.busy}
                                    >
                                        <QueuePreview item={item} />
                                        <span className={styles.itemText}>
                                            <span>{queueItemLabel(item)}</span>
                                            <small>{visualIndex === 0 ? t("pasteQueue.next") : item.getType()}</small>
                                        </span>
                                    </button>
                                    <ToolbarIconButton
                                        className={styles.deleteButton}
                                        data-pointer-visible={pointerHash === hash}
                                        onClick={() => remove(hash)}
                                        disabled={state.busy}
                                        label={t("pasteQueue.remove")}
                                    >
                                        <DeleteOutlineRoundedIcon fontSize="small" />
                                    </ToolbarIconButton>
                                </li>
                            );
                        })}
                        </m.ol>
                    )}
                </AnimatePresence>

                <AnimatePresence mode="wait" initial={false}>
                    {state.error && (
                        <m.div
                            key={`${state.error.hash ?? "queue"}:${state.error.message}`}
                            className={styles.error}
                            role="alert"
                            variants={listItemMotion}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                        >
                            <span>{state.error.message}</span>
                            {state.error.hash && (
                                <div className={styles.errorActions}>
                                    <Button onClick={() => paste(state.error?.hash as string)} disabled={state.busy}>
                                        {t("pasteQueue.retry")}
                                    </Button>
                                    <Button color="error" onClick={() => remove(state.error?.hash as string)} disabled={state.busy}>
                                        {t("pasteQueue.deleteFailed")}
                                    </Button>
                                </div>
                            )}
                        </m.div>
                    )}
                </AnimatePresence>
                <ConfirmDialog
                    open={confirmingClear}
                    title={t("pasteQueue.clear")}
                    description={t("pasteQueue.clearConfirm")}
                    cancelLabel={t("pasteQueue.keep")}
                    confirmLabel={t("pasteQueue.clear")}
                    confirmDisabled={state.busy}
                    onCancel={() => setConfirmingClear(false)}
                    onConfirm={clear}
                />
                <AnimatePresence mode="wait" initial={false}>
                    {undoVisible && (
                        <StatusToast
                            key={state.undoHash}
                            className={styles.undo}
                            message={t("pasteQueue.pasted")}
                            actionLabel={t("pasteQueue.undo")}
                            actionIcon={<UndoRoundedIcon fontSize="inherit" />}
                            actionDisabled={state.busy}
                            onAction={undo}
                        />
                    )}
                </AnimatePresence>
            </section>
        </main>
    );
}
