import type { ReactElement } from "react";
import { render as renderUi, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    ClipboardContextMenus,
    DeleteConfirmDialog,
    TabContextMenu,
    TagCreateChoicePopover,
} from "../../../src/clipboard/ClipboardOverlays";
import { Item, ItemType } from "../../../src/clipboard/Item";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const render = (ui: ReactElement) => renderUi(<MotionTestProvider>{ui}</MotionTestProvider>);

const t = (key: string) => key;

describe("clipboard overlays", () => {
    it("reports the selected tag kind with the original click coordinates", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(
            <TagCreateChoicePopover
                state={{ x: 10, y: 20, originX: 30, originY: 40 }}
                t={t}
                onSelect={onSelect}
            />,
        );

        await user.click(screen.getByRole("menuitem", { name: /tabs\.filterTag/ }));
        await user.click(screen.getByRole("menuitem", { name: /tabs\.recordTag/ }));

        expect(onSelect).toHaveBeenNthCalledWith(1, "filter", 30, 40);
        expect(onSelect).toHaveBeenNthCalledWith(2, "record", 30, 40);
    });

    it("keeps menu selection and actions controlled by the parent", async () => {
        const user = userEvent.setup();
        const onSelectedIndexChange = vi.fn();
        const action = vi.fn();
        const childAction = vi.fn();
        const item = new Item(1, "hash", ItemType.Text, "text", 0);

        render(
            <ClipboardContextMenus
                state={{
                    item,
                    x: 10,
                    y: 20,
                    originX: 30,
                    originY: 40,
                    submenuSide: "right",
                    itemTags: [],
                    colorOptions: [],
                }}
                options={[
                    { label: "Copy", action },
                    { label: "Tags", children: [{ label: "Work", action: childAction }] },
                ]}
                selectedIndex={1}
                submenuOptions={[{ label: "Work", action: childAction }]}
                submenuLeft={200}
                submenuTop={100}
                onSelectedIndexChange={onSelectedIndexChange}
            />,
        );

        await user.hover(screen.getByRole("menuitem", { name: "Copy" }));
        await user.click(screen.getByRole("menuitem", { name: "Copy" }));
        await user.click(screen.getByRole("menuitem", { name: "Work" }));

        expect(onSelectedIndexChange).toHaveBeenCalledWith(0);
        expect(action).toHaveBeenCalledOnce();
        expect(childAction).toHaveBeenCalledOnce();
    });

    it("forwards tab edit and delete choices without changing tab state", async () => {
        const user = userEvent.setup();
        const onEdit = vi.fn();
        const onDelete = vi.fn();
        const state = {
            kind: "record" as const,
            tag: { id: 7, name: "Work" },
            x: 10,
            y: 20,
            originX: 30,
            originY: 40,
        };

        render(
            <TabContextMenu
                state={state}
                t={t}
                onEdit={onEdit}
                onDelete={onDelete}
            />,
        );

        await user.click(screen.getByRole("menuitem", { name: "tabs.edit" }));
        await user.click(screen.getByRole("menuitem", { name: "tabs.delete" }));

        expect(onEdit).toHaveBeenCalledWith(state);
        expect(onDelete).toHaveBeenCalledWith(state);
    });

    it("keeps delete confirmation callbacks explicit", async () => {
        const user = userEvent.setup();
        const onCancel = vi.fn();
        const onConfirm = vi.fn();
        render(
            <DeleteConfirmDialog
                title="Delete tag"
                description="This cannot be undone"
                cancelLabel="Cancel"
                confirmLabel="Delete"
                onCancel={onCancel}
                onConfirm={onConfirm}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(onCancel).toHaveBeenCalledOnce();
        expect(onConfirm).toHaveBeenCalledOnce();
    });
});
