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

function renderTutorial(platform: "windows" | "mac") {
    const callbacks = {
        onPermissionAction: vi.fn(),
        onToggleFilter: vi.fn(),
        onComplete: vi.fn(),
    };
    renderUi(
        <MotionTestProvider reducedMotion="always">
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
});
