import {
    useCallback,
    useEffect,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";
import {
    WHEEL_MOUSE_TIME_CONSTANT_MS,
    WHEEL_SCROLL_IDLE_MS,
    WHEEL_SCROLL_MAX_FRAME_MS,
    clampDragVelocity,
    isTextInputTarget,
    nextWheelScrollTarget,
    normalizeWheelDelta,
    pointerDragIntent,
    pointerDragVelocity,
    wheelAnimationFrame,
    wheelTimeConstant,
} from "./clipboardInteractions";

type ClipboardListInteractionOptions = {
    containerRef: RefObject<HTMLDivElement>;
    tutorialActive: boolean;
    draggingClassName: string;
    wheelScrollingClassName: string;
    cardSelector: string;
    contextMenuSelector: string;
    onActivateCard: (hash: string, plainText: boolean) => void;
    onLoadMore: (force?: boolean) => void;
    onPointerStart: () => void;
    onWheelStart: () => void;
};

type DragScrollState = {
    active: boolean;
    moved: boolean;
    cancelActivation: boolean;
    targetHash: string;
    startX: number;
    startY: number;
    lastX: number;
    lastTime: number;
    velocity: number;
    pendingDelta: number;
    frame: number | null;
};

export function useClipboardListInteractions(options: ClipboardListInteractionOptions) {
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const wheelScrollingRef = useRef(false);
    const wheelScrollIdleTimerRef = useRef<number | null>(null);
    const wheelScrollStateRef = useRef({
        target: 0,
        frame: null as number | null,
        lastFrameTime: null as number | null,
        lastEventTime: 0,
        timeConstant: WHEEL_MOUSE_TIME_CONSTANT_MS,
    });
    const dragScrollRef = useRef<DragScrollState | null>(null);
    const suppressClickAfterDragRef = useRef(false);

    const stopDragInertia = useCallback(() => {
        if (dragScrollRef.current?.frame !== null && dragScrollRef.current?.frame !== undefined) {
            window.cancelAnimationFrame(dragScrollRef.current.frame);
        }
        if (dragScrollRef.current) {
            dragScrollRef.current.frame = null;
        }
    }, []);

    const deactivateWheelScrolling = useCallback(() => {
        wheelScrollIdleTimerRef.current = null;
        wheelScrollingRef.current = false;
        optionsRef.current.containerRef.current?.classList.remove(
            optionsRef.current.wheelScrollingClassName,
        );
    }, []);

    const scheduleWheelScrollIdle = useCallback(() => {
        if (wheelScrollIdleTimerRef.current !== null) {
            window.clearTimeout(wheelScrollIdleTimerRef.current);
        }
        const elapsed = performance.now() - wheelScrollStateRef.current.lastEventTime;
        wheelScrollIdleTimerRef.current = window.setTimeout(
            deactivateWheelScrolling,
            Math.max(0, WHEEL_SCROLL_IDLE_MS - elapsed),
        );
    }, [deactivateWheelScrolling]);

    const stopWheelScroll = useCallback(() => {
        const state = wheelScrollStateRef.current;
        if (state.frame !== null) {
            window.cancelAnimationFrame(state.frame);
            state.frame = null;
        }
        if (wheelScrollIdleTimerRef.current !== null) {
            window.clearTimeout(wheelScrollIdleTimerRef.current);
            wheelScrollIdleTimerRef.current = null;
        }
        state.lastFrameTime = null;
        state.target = optionsRef.current.containerRef.current?.scrollLeft ?? state.target;
        if (wheelScrollingRef.current) {
            deactivateWheelScrolling();
        }
    }, [deactivateWheelScrolling]);

    const resetPointerState = useCallback(() => {
        stopWheelScroll();
        const dragState = dragScrollRef.current;
        if (dragState?.frame !== null && dragState?.frame !== undefined) {
            window.cancelAnimationFrame(dragState.frame);
        }
        dragScrollRef.current = null;
        suppressClickAfterDragRef.current = false;
        optionsRef.current.containerRef.current?.classList.remove(
            optionsRef.current.draggingClassName,
        );
    }, [stopWheelScroll]);

    const clearClickSuppression = useCallback(() => {
        suppressClickAfterDragRef.current = false;
    }, []);

    const startDragInertia = useCallback((initialVelocity: number) => {
        const container = optionsRef.current.containerRef.current;
        if (!container) return;
        let velocity = clampDragVelocity(initialVelocity);
        const startedAt = performance.now();

        const step = (now: number) => {
            if (Math.abs(velocity) < 0.45 || now - startedAt > 260) {
                stopDragInertia();
                optionsRef.current.onLoadMore(true);
                return;
            }

            container.scrollLeft += velocity;
            velocity *= 0.84;
            optionsRef.current.onLoadMore();
            if (dragScrollRef.current) {
                dragScrollRef.current.frame = window.requestAnimationFrame(step);
            }
        };

        if (Math.abs(velocity) >= 0.45) {
            dragScrollRef.current = {
                active: false,
                moved: false,
                cancelActivation: false,
                targetHash: "",
                startX: 0,
                startY: 0,
                lastX: 0,
                lastTime: performance.now(),
                velocity,
                pendingDelta: 0,
                frame: window.requestAnimationFrame(step),
            };
        }
    }, [stopDragInertia]);

    const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary) return;
        stopWheelScroll();
        stopDragInertia();
        if (event.button !== 0 || isTextInputTarget(event.target)) return;
        const target = event.target as HTMLElement;
        const { cardSelector, contextMenuSelector } = optionsRef.current;
        if (target.closest("button") || target.closest(contextMenuSelector)) return;
        const targetCard = target.closest<HTMLElement>(cardSelector);

        optionsRef.current.onPointerStart();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragScrollRef.current = {
            active: true,
            moved: false,
            cancelActivation: false,
            targetHash: targetCard?.dataset.hash || "",
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastTime: performance.now(),
            velocity: 0,
            pendingDelta: 0,
            frame: null,
        };
    }, [stopDragInertia, stopWheelScroll]);

    const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const state = dragScrollRef.current;
        const container = optionsRef.current.containerRef.current;
        if (!state?.active || !container) return;

        const deltaX = event.clientX - state.lastX;
        if (!state.moved) {
            const intent = pointerDragIntent(state.startX, state.startY, event.clientX, event.clientY);
            if (intent === "pending") return;
            if (intent === "vertical") {
                state.cancelActivation = true;
                return;
            }
        }

        event.preventDefault();
        state.moved = true;
        suppressClickAfterDragRef.current = true;
        container.classList.add(optionsRef.current.draggingClassName);

        const now = performance.now();
        state.pendingDelta -= deltaX;
        state.velocity = pointerDragVelocity(deltaX, now - state.lastTime);
        state.lastX = event.clientX;
        state.lastTime = now;

        if (state.frame === null) {
            state.frame = window.requestAnimationFrame(() => {
                const nextState = dragScrollRef.current;
                const nextContainer = optionsRef.current.containerRef.current;
                if (!nextState || !nextContainer) return;
                nextState.frame = null;
                if (nextState.pendingDelta === 0) return;
                nextContainer.scrollLeft += nextState.pendingDelta;
                nextState.pendingDelta = 0;
                optionsRef.current.onLoadMore();
            });
        }
    }, []);

    const finishPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const state = dragScrollRef.current;
        const container = optionsRef.current.containerRef.current;
        if (!state?.active) return;

        container?.classList.remove(optionsRef.current.draggingClassName);
        if (state.frame !== null) {
            window.cancelAnimationFrame(state.frame);
            state.frame = null;
        }
        dragScrollRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (event.type === "pointerup" && !state.moved && !state.cancelActivation && state.targetHash) {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            optionsRef.current.onActivateCard(state.targetHash, event.shiftKey);
            return;
        }
        if (state.moved) {
            event.preventDefault();
            if (state.pendingDelta !== 0 && container) {
                container.scrollLeft += state.pendingDelta;
                state.pendingDelta = 0;
                optionsRef.current.onLoadMore();
            }
            startDragInertia(state.velocity);
            window.setTimeout(() => {
                suppressClickAfterDragRef.current = false;
            }, 120);
        }
    }, [startDragInertia]);

    const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (!suppressClickAfterDragRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickAfterDragRef.current = false;
    }, []);

    const startWheelScrollAnimation = useCallback(() => {
        const state = wheelScrollStateRef.current;
        if (state.frame !== null) return;

        const step = (timestamp: number) => {
            const nextContainer = optionsRef.current.containerRef.current;
            if (!nextContainer) {
                state.frame = null;
                state.lastFrameTime = null;
                scheduleWheelScrollIdle();
                return;
            }

            const elapsed = state.lastFrameTime === null
                ? 1000 / 60
                : Math.min(WHEEL_SCROLL_MAX_FRAME_MS, Math.max(0, timestamp - state.lastFrameTime));
            state.lastFrameTime = timestamp;
            const frame = wheelAnimationFrame(
                nextContainer.scrollLeft,
                state.target,
                elapsed,
                state.timeConstant,
            );
            nextContainer.scrollLeft = frame.scrollLeft;

            if (frame.complete) {
                state.frame = null;
                state.lastFrameTime = null;
                optionsRef.current.onLoadMore(true);
                scheduleWheelScrollIdle();
                return;
            }

            optionsRef.current.onLoadMore();
            state.frame = window.requestAnimationFrame(step);
        };

        state.frame = window.requestAnimationFrame(step);
    }, [scheduleWheelScrollIdle]);

    const handleWheel = useCallback((event: WheelEvent) => {
        if (optionsRef.current.tutorialActive || event.ctrlKey) return;

        optionsRef.current.onWheelStart();
        const container = optionsRef.current.containerRef.current;
        if (!container) return;

        const { delta: scrollAmount, rawDelta } = normalizeWheelDelta(event, container.clientWidth);
        if (scrollAmount === 0) return;

        const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
        if (maxScroll === 0) return;

        event.preventDefault();
        if (wheelScrollIdleTimerRef.current !== null) {
            window.clearTimeout(wheelScrollIdleTimerRef.current);
            wheelScrollIdleTimerRef.current = null;
        }
        if (!wheelScrollingRef.current) {
            wheelScrollingRef.current = true;
            container.classList.add(optionsRef.current.wheelScrollingClassName);
        }

        const state = wheelScrollStateRef.current;
        const now = performance.now();
        const eventInterval = now - state.lastEventTime;
        state.lastEventTime = now;

        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            if (state.frame !== null) {
                window.cancelAnimationFrame(state.frame);
                state.frame = null;
            }
            state.lastFrameTime = null;
            state.target = Math.max(0, Math.min(maxScroll, container.scrollLeft + scrollAmount));
            container.scrollLeft = state.target;
            optionsRef.current.onLoadMore(true);
            scheduleWheelScrollIdle();
            return;
        }

        if (state.frame === null) {
            state.target = container.scrollLeft;
            state.lastFrameTime = null;
        }
        state.target = nextWheelScrollTarget(
            state.target,
            container.scrollLeft,
            scrollAmount,
            maxScroll,
        );
        state.timeConstant = wheelTimeConstant(rawDelta, event.deltaMode, eventInterval);
        startWheelScrollAnimation();
    }, [scheduleWheelScrollIdle, startWheelScrollAnimation]);

    useEffect(() => {
        const container = optionsRef.current.containerRef.current;
        if (!container) return;

        container.addEventListener("wheel", handleWheel, { passive: false });
        return () => {
            container.removeEventListener("wheel", handleWheel);
            resetPointerState();
        };
    }, [handleWheel, resetPointerState]);

    return {
        clearClickSuppression,
        finishPointerDrag,
        handleClickCapture,
        handlePointerDown,
        handlePointerMove,
        resetPointerState,
        stopWheelScroll,
    };
}
