import { createRef } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ClipboardHeaderActions,
    ClipboardTabBar,
    ClipboardUpdateBanner,
} from "../../../src/clipboard/ClipboardHeader";
import { type DynamicTabEntry } from "../../../src/clipboard/customTabs";

const t = (key: string) => key;

afterEach(cleanup);

const dynamicTabs: DynamicTabEntry[] = [
    {
        kind: "filter",
        id: "filter-1",
        tab: {
            id: "filter-1",
            name: "Images",
            filter: {
                itemType: "Image",
                appSource: "",
                appSources: [],
                favorite: "any",
                relativeAmount: "",
                relativeUnit: "day",
            },
        },
    },
    {
        kind: "record",
        id: "record:7",
        tag: { id: 7, name: "Work" },
    },
];

describe("clipboard header", () => {
    it("forwards tab selection, editing, context menu, drag, drop, and add events", async () => {
        const user = userEvent.setup();
        const onSelectTab = vi.fn();
        const onEditTab = vi.fn();
        const onOpenContextMenu = vi.fn();
        const onDragStart = vi.fn();
        const onDragEnd = vi.fn();
        const onDrop = vi.fn();
        const onAdd = vi.fn();

        render(
            <ClipboardTabBar
                activeTab="filter-1"
                dynamicTabs={dynamicTabs}
                draggingTabId=""
                tutorialActive={false}
                altHintsVisible
                addButtonRef={createRef<HTMLButtonElement>()}
                t={t}
                onSelectTab={onSelectTab}
                onBlockedNavigation={vi.fn()}
                onEditTab={onEditTab}
                onOpenContextMenu={onOpenContextMenu}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDrop={onDrop}
                onAdd={onAdd}
            />,
        );

        await user.click(screen.getByRole("button", { name: /tabs\.all/ }));
        await user.dblClick(screen.getByRole("button", { name: "Images" }));
        fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }), {
            clientX: 120,
            clientY: 240,
        });
        fireEvent.dragStart(screen.getByRole("button", { name: "Images" }));
        fireEvent.dragEnd(screen.getByRole("button", { name: "Images" }));
        fireEvent.drop(screen.getByRole("button", { name: "Work" }));
        fireEvent.click(screen.getByRole("button", { name: "tabs.add" }), {
            clientX: 300,
            clientY: 80,
        });

        expect(onSelectTab).toHaveBeenCalledWith("all");
        expect(onEditTab).toHaveBeenCalledWith(dynamicTabs[0], expect.any(HTMLButtonElement));
        expect(onOpenContextMenu).toHaveBeenCalledWith(dynamicTabs[1], 120, 240);
        expect(onDragStart).toHaveBeenCalledWith("filter-1");
        expect(onDragEnd).toHaveBeenCalledOnce();
        expect(onDrop).toHaveBeenCalledWith("record:7");
        expect(onAdd).toHaveBeenCalledWith(300, 80);
        expect(screen.getByText("A")).toHaveAttribute("data-motion-preset", "shortcutHint");
        expect(screen.getByText("F")).toHaveAttribute("data-motion-preset", "shortcutHint");
    });

    it("blocks tab navigation and hides mutable actions during the tutorial", async () => {
        const user = userEvent.setup();
        const onBlockedNavigation = vi.fn();
        const onSelectTab = vi.fn();
        const onOpenContextMenu = vi.fn();

        render(
            <ClipboardTabBar
                activeTab="all"
                dynamicTabs={dynamicTabs}
                draggingTabId=""
                tutorialActive
                altHintsVisible={false}
                addButtonRef={createRef<HTMLButtonElement>()}
                t={t}
                onSelectTab={onSelectTab}
                onBlockedNavigation={onBlockedNavigation}
                onEditTab={vi.fn()}
                onOpenContextMenu={onOpenContextMenu}
                onDragStart={vi.fn()}
                onDragEnd={vi.fn()}
                onDrop={vi.fn()}
                onAdd={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Images" }));
        fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }));

        expect(onBlockedNavigation).toHaveBeenCalledTimes(2);
        expect(onSelectTab).not.toHaveBeenCalled();
        expect(onOpenContextMenu).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "tabs.add" })).not.toBeInTheDocument();
    });

    it("keeps permission, debug, UI-lab, and settings actions explicit", async () => {
        const user = userEvent.setup();
        const callbacks = {
            onOpenPasteQueue: vi.fn(),
            onOpenPermissionCenter: vi.fn(),
            onOpenTutorial: vi.fn(),
            onToggleLanguage: vi.fn(),
            onToggleTheme: vi.fn(),
            onOpenUiLab: vi.fn(),
            onOpenTestRoom: vi.fn(),
            onOpenSettings: vi.fn(),
        };

        render(
            <ClipboardHeaderActions
                isMac
                tutorialActive={false}
                tutorialPlatform="windows"
                permissionIncomplete
                showDeveloperToolbar
                languageCode="Chinese"
                developerTheme="dark"
                t={t}
                pasteQueueActive
                {...callbacks}
            />,
        );

        const developerToolbar = screen.getByRole("group", { name: "tutorial.debug.tools" });
        expect(within(developerToolbar).getByRole("button", { name: "tutorial.debug.uiLab" })).toBeVisible();
        expect(within(developerToolbar).getByRole("button", { name: "tutorial.debug.testRoom" })).toBeVisible();
        await user.click(screen.getByRole("button", { name: "clipboard.permissionsIncomplete" }));
        await user.click(screen.getByRole("button", { name: "tutorial.debug.windows" }));
        await user.click(screen.getByRole("button", { name: "tutorial.debug.language" }));
        await user.click(screen.getByRole("button", { name: "tutorial.debug.theme.dark" }));
        await user.click(screen.getByRole("button", { name: "tutorial.debug.uiLab" }));
        await user.click(screen.getByRole("button", { name: "tutorial.debug.testRoom" }));
        await user.click(screen.getByRole("button", { name: "common.settings" }));
        const pasteQueueButton = screen.getByRole("button", { name: "pasteQueue.close" });
        expect(pasteQueueButton).toHaveAttribute("aria-pressed", "true");
        await user.click(pasteQueueButton);

        expect(callbacks.onOpenPermissionCenter).toHaveBeenCalledOnce();
        expect(callbacks.onOpenTutorial).toHaveBeenCalledWith("windows");
        expect(callbacks.onToggleLanguage).toHaveBeenCalledOnce();
        expect(callbacks.onToggleTheme).toHaveBeenCalledOnce();
        expect(callbacks.onOpenUiLab).toHaveBeenCalledOnce();
        expect(callbacks.onOpenTestRoom).toHaveBeenCalledOnce();
        expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();
        expect(callbacks.onOpenPasteQueue).toHaveBeenCalledOnce();
    });

    it("hides and restores the grouped developer toolbar without hiding settings", async () => {
        const user = userEvent.setup();
        render(
            <ClipboardHeaderActions
                isMac={false}
                tutorialActive={false}
                tutorialPlatform="windows"
                permissionIncomplete={false}
                showDeveloperToolbar
                languageCode="Chinese"
                developerTheme="light"
                t={t}
                pasteQueueActive={false}
                onOpenPasteQueue={vi.fn()}
                onOpenPermissionCenter={vi.fn()}
                onOpenTutorial={vi.fn()}
                onToggleLanguage={vi.fn()}
                onToggleTheme={vi.fn()}
                onOpenUiLab={vi.fn()}
                onOpenTestRoom={vi.fn()}
                onOpenSettings={vi.fn()}
            />,
        );

        const hideButton = screen.getByRole("button", { name: "tutorial.debug.hideTools" });
        expect(hideButton).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("group", { name: "tutorial.debug.tools" })).toBeVisible();

        await user.click(hideButton);

        expect(screen.queryByRole("group", { name: "tutorial.debug.tools" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "common.settings" })).toBeVisible();
        const showButton = screen.getByRole("button", { name: "tutorial.debug.showTools" });
        expect(showButton).toHaveAttribute("aria-pressed", "false");

        await user.click(showButton);

        expect(screen.getByRole("group", { name: "tutorial.debug.tools" })).toBeVisible();
    });

    it("renders the update text and forwards its action", async () => {
        const user = userEvent.setup();
        const onRestart = vi.fn();
        render(
            <ClipboardUpdateBanner
                version="2.0.0"
                t={t}
                onRestart={onRestart}
            />,
        );

        expect(screen.getByText("clipboard.updateDownloaded")).toBeInTheDocument();
        expect(screen.getByText("clipboard.updateRestart")).toBeInTheDocument();
        await user.click(screen.getByRole("button"));
        expect(onRestart).toHaveBeenCalledOnce();
    });
});
