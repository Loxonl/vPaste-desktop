import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";
import { OperationStatus } from "../../../src/ui/OperationStatus";

afterEach(cleanup);

function renderStatus(status: ReactNode) {
    return render(
        <MotionTestProvider>
            <AppThemeProvider>{status}</AppThemeProvider>
        </MotionTestProvider>,
    );
}

describe("OperationStatus", () => {
    it("announces working state and exposes determinate progress", () => {
        const { container } = renderStatus(
            <OperationStatus
                variant="block"
                busy
                message="Syncing history"
                progress={58}
                progressLabel="History sync progress"
            />,
        );

        expect(screen.getByRole("status")).toHaveTextContent("Syncing history");
        expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
        expect(screen.getByRole("progressbar", { name: "History sync progress" })).toHaveAttribute("aria-valuenow", "58");
        expect(container.querySelector('[data-motion-preset="fade"]')).not.toBeNull();
    });

    it("uses assertive alert semantics for errors without rendering progress", () => {
        renderStatus(<OperationStatus tone="error" message="Sync failed" />);

        expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
});
