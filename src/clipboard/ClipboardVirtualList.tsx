import {
    createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
    type ReactElement, type Ref, type RefObject,
} from "react";
import { AnimatePresence, usePresence } from "../ui/motion";
import { Item } from "./Item";
import {
    clipboardIndexScrollLeft, clipboardResidentIndices, clipboardSpacerWidth, clipboardViewport,
    InteractionLeases, type ClipboardGeometry,
} from "./clipboardViewport";
import styles from "./Clipboard.module.css";

export type ClipboardVirtualListHandle = {
    scrollToIndex: (index: number, behavior?: ScrollBehavior) => boolean;
    getCard: (hash: string) => HTMLElement | null;
};
export type ClipboardVirtualSource = {
    count: number;
    indexOf: (item: Item) => number;
    ensureRange: (start: number, end: number) => void;
    retain: (hash: string) => () => void;
    enteringHashes: ReadonlySet<string>;
};

type RenderCard = (
    item: Item, index: number, ref: Ref<HTMLDivElement>, retain: () => () => void,
    animateEntry: boolean, left: number,
) => ReactElement;
type ListLife = { active: boolean; hashes: Set<string>; retiring: Set<string>; held: Set<string> };
const ListLifeContext = createContext<ListLife | null>(null);
type RegisterNode = (hash: string, node: HTMLDivElement | null, previous: HTMLDivElement | null) => void;
type SlotProps = {
    item: Item; index: number; left: number; animateEntry: boolean;
    renderCard: RenderCard; retain: () => () => void;
    registerNode: RegisterNode;
};

const CardSlot = forwardRef<HTMLDivElement, SlotProps>(function CardSlot({
    item, index, left, animateEntry, renderCard, retain, registerNode,
}, ref) {
    const life = useContext(ListLifeContext)!;
    const [present, safeToRemove] = usePresence();
    const lastNode = useRef<HTMLDivElement | null>(null);
    const hash = item.getHash();
    useEffect(() => {
        if (!present && (!life.active || !life.held.has(hash))) safeToRemove?.();
    }, [present, life.active, life.held, hash, safeToRemove]);
    const attach = useCallback((node: HTMLDivElement | null) => {
        registerNode(hash, node, lastNode.current);
        lastNode.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
    }, [hash, ref, registerNode]);
    // Scrolling releases DOM immediately. Actual record removal keeps its existing
    // Motion exit. No slot or animation context is retained for offscreen records.
    if (!life.active || (!present && (life.hashes.has(hash) || !life.retiring.has(hash)))) return null;
    return renderCard(item, index, attach, retain, animateEntry, left);
});

export const ClipboardVirtualList = forwardRef<ClipboardVirtualListHandle, {
    items: Item[];
    containerRef: RefObject<HTMLDivElement>;
    active: boolean;
    renderCard: RenderCard;
    source?: ClipboardVirtualSource;
}>(function ClipboardVirtualList({ items, containerRef, active, renderCard, source }, ref) {
    const sourceRef = useRef(source);
    sourceRef.current = source;
    const count = source?.count ?? items.length;
    const countRef = useRef(count);
    countRef.current = count;
    const indexedItems = new Map(items.map((item, localIndex) => [source?.indexOf(item) ?? localIndex, item]));
    const probeRef = useRef<HTMLDivElement>(null);
    const cardsRef = useRef(new Map<string, HTMLDivElement>());
    const mountedHashes = useRef(new Set<string>());
    const mountedRef = useRef(false);
    const leases = useRef(new InteractionLeases());
    const [, invalidateLeases] = useState(0);
    const [geometry, setGeometry] = useState<ClipboardGeometry>({
        scrollLeft: 0, viewportWidth: window.innerWidth, gridLeft: 24, cardWidth: 220, gap: 16,
    });
    const geometryRef = useRef(geometry);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const currentHashes = useMemo(() => new Set(items.map(item => item.getHash())), [items]);
    const life = useRef<ListLife>({ active, hashes: currentHashes, retiring: new Set(), held: new Set() });
    const knownHashes = useRef(new Set<string>());
    const arrivingHashes = useMemo(() => {
        const range = clipboardViewport({ ...geometryRef.current, count: countRef.current });
        if (sourceRef.current) return new Set(sourceRef.current.enteringHashes);
        return new Set(items.slice(range.start, range.end).filter(item => !knownHashes.current.has(item.getHash())).map(item => item.getHash()));
    }, [items]);
    const registerNode = useCallback<RegisterNode>((hash, node, previous) => {
        if (node) {
            cardsRef.current.set(hash, node);
            mountedHashes.current.add(hash);
        } else if (cardsRef.current.get(hash) === previous) {
            cardsRef.current.delete(hash);
            if (life.current.retiring.has(hash)) queueMicrotask(() => {
                if (mountedRef.current && !cardsRef.current.has(hash)) invalidateLeases(value => value + 1);
            });
        }
    }, []);

    useLayoutEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const measure = useCallback(() => {
        const container = containerRef.current;
        const probe = probeRef.current;
        const grid = probe?.parentElement;
        if (!container || !probe || !grid) return;
        let gridLeft = 0;
        for (let node: HTMLElement | null = grid; node && node !== container; node = node.offsetParent as HTMLElement | null) {
            gridLeft += node.offsetLeft;
        }
        const gap = parseFloat(getComputedStyle(grid).columnGap);
        const next = {
            scrollLeft: container.scrollLeft, viewportWidth: container.clientWidth,
            gridLeft, cardWidth: probe.offsetWidth, gap: Number.isFinite(gap) ? gap : 16,
        };
        geometryRef.current = next;
        setGeometry(previous => {
            const before = clipboardViewport({ ...previous, count: countRef.current });
            const after = clipboardViewport({ ...next, count: countRef.current });
            return before.start === after.start && before.end === after.end
                && previous.viewportWidth === next.viewportWidth && previous.gridLeft === next.gridLeft
                && previous.cardWidth === next.cardWidth && previous.gap === next.gap ? previous : next;
        });
    }, [containerRef]);

    useLayoutEffect(() => {
        // Keep only current identities; removed records cannot accumulate here.
        knownHashes.current = currentHashes;
        mountedHashes.current = new Set([...mountedHashes.current].filter(hash => currentHashes.has(hash)));
    }, [currentHashes]);

    useLayoutEffect(() => {
        if (!active) return;
        measure();
        const container = containerRef.current;
        if (!container) return;
        container.addEventListener("scroll", measure, { passive: true });
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => { container.removeEventListener("scroll", measure); observer.disconnect(); };
    }, [active, containerRef, measure]);

    useImperativeHandle(ref, () => ({
        getCard: hash => cardsRef.current.get(hash)?.querySelector<HTMLElement>("[data-hash]") ?? null,
        scrollToIndex: (index, behavior = "auto") => {
            const container = containerRef.current;
            if (!container || index < 0 || index >= countRef.current) return false;
            const current = { ...geometryRef.current, scrollLeft: container.scrollLeft, viewportWidth: container.clientWidth };
            const left = clipboardIndexScrollLeft(index, current);
            container.scrollTo({ left, behavior });
            measure();
            return left !== current.scrollLeft;
        },
    }), [containerRef, measure]);

    const range = clipboardViewport({ ...geometry, count });
    useEffect(() => {
        if (active) sourceRef.current?.ensureRange(range.start, range.end);
    }, [active, range.start, range.end, count]);
    const retiring = new Set<string>();
    const currentGeometry = geometryRef.current;
    const overscan = 2 * (currentGeometry.cardWidth + currentGeometry.gap);
    for (const [hash, node] of cardsRef.current) {
        if (currentHashes.has(hash)) continue;
        const left = currentGeometry.gridLeft + node.offsetLeft;
        const visible = left + node.offsetWidth > currentGeometry.scrollLeft - overscan
            && left < currentGeometry.scrollLeft + currentGeometry.viewportWidth + overscan;
        if (active && (visible || leases.current.has(hash))) retiring.add(hash);
    }
    life.current = { active, hashes: currentHashes, retiring, held: new Set(leases.current.hashes()) };
    const capacity = clipboardViewport({ ...geometry, count: Number.MAX_SAFE_INTEGER });
    let indices: number[] = [];
    if (active) {
        const retained = leases.current.hashes().map(hash => {
            const local = items.findIndex(item => item.getHash() === hash);
            return local >= 0 ? (source?.indexOf(items[local]) ?? local) : -1;
        }).filter(index => index >= 0);
        indices = clipboardResidentIndices(range, retained, retiring.size, capacity.visibleEnd - capacity.visibleStart);
    }

    return <ListLifeContext.Provider value={life.current}>
        <div ref={probeRef} aria-hidden="true" className={styles["virtual-list-probe"]} />
        <div className={styles["virtual-list-track"]} style={{ width: clipboardSpacerWidth(count, geometry.cardWidth, geometry.gap) }}>
            <AnimatePresence mode="popLayout" initial={false}>
                {indices.map(index => {
                    const item = indexedItems.get(index);
                    if (!item) return null;
                    const hash = item.getHash();
                    return <CardSlot
                        key={hash}
                        registerNode={registerNode}
                        item={item} index={index} left={index * (geometry.cardWidth + geometry.gap)}
                        animateEntry={arrivingHashes.has(hash) && !mountedHashes.current.has(hash)} renderCard={renderCard}
                        retain={() => {
                            const release = leases.current.acquire(hash);
                            const releaseData = sourceRef.current?.retain(hash);
                            invalidateLeases(value => value + 1);
                            return () => { release(); releaseData?.(); invalidateLeases(value => value + 1); };
                        }}
                    />;
                })}
            </AnimatePresence>
        </div>
    </ListLifeContext.Provider>;
});
