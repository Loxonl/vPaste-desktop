import { useLayoutEffect, useRef, type ReactNode } from "react";
import { m, useIsPresent, useMotionPreset } from "../ui/motion";

export function ClipboardResultsSurface({ className, masked, children, onFocusedExit, onActiveMount }: {
    className: string;
    masked: boolean;
    children: ReactNode;
    onFocusedExit?: () => void;
    onActiveMount?: (surface: HTMLDivElement) => void;
}) {
    const present = useIsPresent();
    const surfaceRef = useRef<HTMLDivElement>(null);
    const fadeMotion = useMotionPreset("fade");
    const inactive = !present || masked;

    useLayoutEffect(() => {
        const surface = surfaceRef.current;
        if (!surface) return;
        if (!present && surface.contains(document.activeElement)) onFocusedExit?.();
        surface.inert = inactive;
        if (present && !inactive) onActiveMount?.(surface);
    }, [inactive, onActiveMount, onFocusedExit, present]);

    return (
        <m.div
            ref={surfaceRef}
            className={className}
            data-testid={present ? "clipboard-results" : undefined}
            data-results-active={present}
            aria-hidden={inactive || undefined}
            variants={fadeMotion}
            initial="initial"
            animate="animate"
            exit="exit"
        >
            {children}
        </m.div>
    );
}
