import { act, cleanup, fireEvent, render as renderUi, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TutorialOverlay from "../../../src/clipboard/TutorialOverlay";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const t = (key: string) => key;

const permissions = [
    {
        id: "background" as const,
        title: "Background",
        description: "Background description",
        done: false,
        actionLabel: "Enable background",
    },
    {
        id: "paste" as const,
        title: "Paste",
        description: "Paste description",
        done: false,
        actionLabel: "Enable paste",
    },
];

const filters = [
    { id: "text" as const, name: "Text", enabled: false },
    { id: "image" as const, name: "Image", enabled: true },
];

function renderTutorial(platform: "windows" | "mac", reducedMotion: "always" | "never" = "always") {
    const callbacks = {
        onPermissionAction: vi.fn(),
        onToggleFilter: vi.fn(),
        onComplete: vi.fn(),
        onShortcutDemoAvailabilityChange: vi.fn(),
    };
    renderUi(
        <MotionTestProvider reducedMotion={reducedMotion}>
            <TutorialOverlay
                t={t}
                logoSrc="logo.png"
                shortcutText="Alt+V"
                platform={platform}
                permissions={permissions}
                filters={filters}
                {...callbacks}
            />
        </MotionTestProvider>,
    );
    return callbacks;
}

async function finishReducedMotionWelcome() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
    });
}

describe("TutorialOverlay", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("skips the permission step on Windows and preserves filter and completion actions", async () => {
        const callbacks = renderTutorial("windows");

        await finishReducedMotionWelcome();
        expect(screen.getByRole("heading", { name: "tutorial.filters.title" })).toBeVisible();
        expect(screen.queryByRole("heading", { name: "tutorial.permissions.title" })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("checkbox", { name: "Text" }));
        expect(callbacks.onToggleFilter).toHaveBeenCalledWith("text", true);

        fireEvent.click(screen.getByRole("button", { name: "tutorial.continue" }));
        expect(screen.getByRole("heading", { name: "tutorial.shortcut.title" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "tutorial.finish" }));
        expect(callbacks.onComplete).toHaveBeenCalledOnce();
    });

    it("keeps macOS permission actions and back navigation in the established order", async () => {
        const callbacks = renderTutorial("mac");

        await finishReducedMotionWelcome();
        expect(screen.getByRole("heading", { name: "tutorial.permissions.title" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Enable background" }));
        expect(callbacks.onPermissionAction).toHaveBeenCalledWith("background");

        fireEvent.click(screen.getByRole("button", { name: "tutorial.continue" }));
        expect(screen.getByRole("heading", { name: "tutorial.filters.title" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "tutorial.back" }));
        expect(screen.getByRole("heading", { name: "tutorial.permissions.title" })).toBeVisible();
    });

    it("crossfades the permission status content when authorization succeeds", async () => {
        const callbacks = {
            onPermissionAction: vi.fn(),
            onToggleFilter: vi.fn(),
            onComplete: vi.fn(),
            onShortcutDemoAvailabilityChange: vi.fn(),
        };
        const view = renderUi(
            <MotionTestProvider reducedMotion="always">
                <TutorialOverlay
                    t={t}
                    logoSrc="logo.png"
                    shortcutText="Alt+V"
                    platform="mac"
                    permissions={permissions}
                    filters={filters}
                    {...callbacks}
                />
            </MotionTestProvider>,
        );
        await finishReducedMotionWelcome();
        vi.useRealTimers();

        view.rerender(
            <MotionTestProvider reducedMotion="always">
                <TutorialOverlay
                    t={t}
                    logoSrc="logo.png"
                    shortcutText="Alt+V"
                    platform="mac"
                    permissions={[{ ...permissions[0], done: true }, permissions[1]]}
                    filters={filters}
                    {...callbacks}
                />
            </MotionTestProvider>,
        );

        const success = await screen.findByText("tutorial.permission.ready");
        expect(success.closest("[data-motion-state='permission-status']")).toHaveAttribute(
            "data-motion-preset",
            "stateIndicator",
        );
    });

    it("marks the final shortcut for a finite press emphasis and keeps a reduced-motion fallback", async () => {
        const callbacks = renderTutorial("windows", "always");

        await finishReducedMotionWelcome();
        fireEvent.click(screen.getByRole("button", { name: "tutorial.continue" }));

        const shortcut = screen.getByText("Alt+V").closest("[data-shortcut-emphasis]");
        expect(shortcut).toHaveAttribute("data-shortcut-emphasis", "reduced");
        expect(shortcut?.querySelector("[data-shortcut-pulse]")).toBeInTheDocument();
        expect(callbacks.onShortcutDemoAvailabilityChange).toHaveBeenLastCalledWith(true);

        fireEvent.click(screen.getByRole("button", { name: "tutorial.back" }));
        expect(callbacks.onShortcutDemoAvailabilityChange).toHaveBeenLastCalledWith(false);
    });
});
