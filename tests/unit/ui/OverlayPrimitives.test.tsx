import { useState, type ReactElement } from "react";
import { cleanup, render as renderUi, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../../src/ui/ConfirmDialog";
import { InlineMenuItem, InlineMenuSurface } from "../../../src/ui/InlineMenu";
import { StatusToast } from "../../../src/ui/StatusToast";
import { ToolbarIconButton } from "../../../src/ui/ToolbarIconButton";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

const render = (ui: ReactElement) => renderUi(<MotionTestProvider>{ui}</MotionTestProvider>);

afterEach(cleanup);

describe("overlay primitives", () => {
    it("closes a confirmation dialog with Escape and restores focus", async () => {
        const user = userEvent.setup();

        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
                    <ConfirmDialog
                        open={open}
                        title="Delete tag"
                        description="This cannot be undone"
                        cancelLabel="Cancel"
                        confirmLabel="Delete"
                        onCancel={() => setOpen(false)}
                        onConfirm={() => undefined}
                    />
                </>
            );
        }

        render(<Harness />);
        const trigger = screen.getByRole("button", { name: "Open dialog" });
        await user.click(trigger);
        expect(screen.getByRole("alertdialog")).toBeVisible();

        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        expect(trigger).toHaveFocus();
    });

    it("keeps confirmation actions explicit and disables a busy confirm action", async () => {
        const user = userEvent.setup();
        const onCancel = vi.fn();
        const onConfirm = vi.fn();
        const { rerender } = render(
            <ConfirmDialog
                open
                title="Clear queue"
                description="Clear every item?"
                cancelLabel="Keep"
                confirmLabel="Clear"
                confirmDisabled
                onCancel={onCancel}
                onConfirm={onConfirm}
            />,
        );

        expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
        expect(onConfirm).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Keep" }));
        expect(onCancel).toHaveBeenCalledOnce();

        rerender(
            <ConfirmDialog
                open
                title="Clear queue"
                description="Clear every item?"
                cancelLabel="Keep"
                confirmLabel="Clear"
                onCancel={onCancel}
                onConfirm={onConfirm}
            />,
        );
        await user.click(screen.getByRole("button", { name: "Clear" }));
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it("provides menu navigation and selection semantics without a portal", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(
            <InlineMenuSurface>
                <InlineMenuItem onClick={() => onSelect("first")}>First</InlineMenuItem>
                <InlineMenuItem selected onClick={() => onSelect("second")}>Second</InlineMenuItem>
            </InlineMenuSurface>,
        );

        const items = screen.getAllByRole("menuitem");
        items[0].focus();
        await user.keyboard("{ArrowDown}");
        expect(items[1]).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(onSelect).toHaveBeenCalledWith("second");
    });

    it("announces toast status and forwards its action", async () => {
        const user = userEvent.setup();
        const onAction = vi.fn();
        render(
            <StatusToast
                message="Item restored"
                actionLabel="Undo"
                onAction={onAction}
            />,
        );

        expect(screen.getByRole("status")).toHaveTextContent("Item restored");
        await user.click(screen.getByRole("button", { name: "Undo" }));
        expect(onAction).toHaveBeenCalledOnce();
    });

    it("gives toolbar icon buttons an accessible name and disabled state", async () => {
        const user = userEvent.setup();
        const onClick = vi.fn();
        const { rerender } = render(
            <ToolbarIconButton label="Settings" onClick={onClick}>
                <span aria-hidden="true">S</span>
            </ToolbarIconButton>,
        );

        await user.click(screen.getByRole("button", { name: "Settings" }));
        expect(onClick).toHaveBeenCalledOnce();

        rerender(
            <ToolbarIconButton label="Settings" onClick={onClick} disabled>
                <span aria-hidden="true">S</span>
            </ToolbarIconButton>,
        );
        expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
        expect(onClick).toHaveBeenCalledOnce();
    });
});
