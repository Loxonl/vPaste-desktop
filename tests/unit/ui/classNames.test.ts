import { describe, expect, it } from "vitest";
import { classes } from "../../../src/ui/classNames";

describe("classes", () => {
    it("maps static and state class names through a CSS Module", () => {
        const styles = {
            card: "card_hash",
            selected: "selected_hash",
        };

        expect(classes(styles, "card selected", false, "")).toBe(
            "card_hash selected_hash",
        );
    });
});
