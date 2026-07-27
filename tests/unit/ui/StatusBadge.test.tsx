import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StatusBadge from "../../../src/ui/StatusBadge";

describe("StatusBadge", () => {
    it("renders a text status instead of relying on color alone", () => {
        render(<StatusBadge tone="success">Enabled</StatusBadge>);

        expect(screen.getByText("Enabled")).toBeVisible();
    });
});
