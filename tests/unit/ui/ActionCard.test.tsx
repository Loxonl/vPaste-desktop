import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActionCard from "../../../src/ui/ActionCard";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";

afterEach(cleanup);

function renderCard({ disabled = false, onClick = vi.fn() } = {}) {
    render(
        <AppThemeProvider>
            <ActionCard
                title="Import history"
                description="Restore a vPaste archive"
                icon={<span aria-hidden="true">+</span>}
                disabled={disabled}
                onClick={onClick}
            />
        </AppThemeProvider>,
    );
    return onClick;
}

describe("ActionCard", () => {
    it("exposes its copy and supports keyboard activation", async () => {
        const user = userEvent.setup();
        const onClick = renderCard();
        const card = screen.getByRole("button", { name: "Import history" });

        card.focus();
        await user.keyboard("{Enter}");
        await user.keyboard(" ");

        expect(onClick).toHaveBeenCalledTimes(2);
        expect(screen.getByText("Restore a vPaste archive")).toBeVisible();
    });

    it("does not invoke disabled actions", async () => {
        const onClick = renderCard({ disabled: true });

        expect(screen.getByRole("button", { name: "Import history" })).toBeDisabled();

        expect(onClick).not.toHaveBeenCalled();
    });
});
