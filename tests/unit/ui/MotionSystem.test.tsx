import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    AnimatePresence,
    m,
    motionPresetFor,
    syncMotionCssVariables,
    useMotionPreset,
} from "../../../src/ui/motion";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

afterEach(cleanup);

describe("Motion system", () => {
    it("synchronizes the approved timing, distance, and easing CSS variables", () => {
        const root = document.createElement("div");
        syncMotionCssVariables(root);

        expect(root.style.getPropertyValue("--motion-duration-quick")).toBe("120ms");
        expect(root.style.getPropertyValue("--motion-duration-fast")).toBe("180ms");
        expect(root.style.getPropertyValue("--motion-duration-standard")).toBe("240ms");
        expect(root.style.getPropertyValue("--motion-duration-slow")).toBe("320ms");
        expect(root.style.getPropertyValue("--motion-distance-subtle")).toBe("6px");
        expect(root.style.getPropertyValue("--motion-distance-standard")).toBe("10px");
        expect(root.style.getPropertyValue("--motion-distance-emphasis")).toBe("16px");
    });

    it("removes transform values from reduced-motion presets", () => {
        const standardInitial = motionPresetFor("popover", false).initial as Record<string, unknown>;
        const reducedInitial = motionPresetFor("popover", true).initial as Record<string, unknown>;
        const reducedAnimate = motionPresetFor("popover", true).animate as Record<string, unknown>;

        expect(standardInitial).toMatchObject({ opacity: 0, y: -6, scale: 0.98 });
        expect(reducedInitial).toEqual({ opacity: 0 });
        expect(reducedAnimate).not.toHaveProperty("x");
        expect(reducedAnimate).not.toHaveProperty("y");
        expect(reducedAnimate).not.toHaveProperty("scale");
        expect(reducedAnimate).not.toHaveProperty("scaleX");
    });

    it("uses the MotionConfig reduced-motion policy for shared presets", () => {
        function Harness() {
            const preset = useMotionPreset("popover");
            return <div data-testid="preset" data-initial={JSON.stringify(preset.initial)} />;
        }

        render(
            <MotionTestProvider reducedMotion="always">
                <Harness />
            </MotionTestProvider>,
        );

        expect(screen.getByTestId("preset")).toHaveAttribute("data-initial", JSON.stringify({ opacity: 0 }));
    });

    it.each(["never", "always"] as const)(
        "completes conditional exit in %s reduced-motion mode",
        async reducedMotion => {
            const user = userEvent.setup();
            const onExitComplete = vi.fn();

            function Harness() {
                const [visible, setVisible] = useState(true);
                const variants = motionPresetFor("toast", reducedMotion === "always");
                return (
                    <>
                        <button type="button" onClick={() => setVisible(false)}>Hide</button>
                        <AnimatePresence mode="wait" onExitComplete={onExitComplete}>
                            {visible && (
                                <m.div
                                    data-testid="motion-target"
                                    variants={variants}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                />
                            )}
                        </AnimatePresence>
                    </>
                );
            }

            render(
                <MotionTestProvider reducedMotion={reducedMotion}>
                    <Harness />
                </MotionTestProvider>,
            );
            await user.click(screen.getByRole("button", { name: "Hide" }));

            await waitFor(() => expect(screen.queryByTestId("motion-target")).not.toBeInTheDocument());
            expect(onExitComplete).toHaveBeenCalledOnce();
        },
    );
});
