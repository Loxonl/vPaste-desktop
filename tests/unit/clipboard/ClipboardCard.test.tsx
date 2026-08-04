import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClipboardCard from "../../../src/clipboard/ClipboardCard";
import { ensureWhiteTextContrast } from "../../../src/clipboard/clipboardHeaderColor";
import { Item, ItemType } from "../../../src/clipboard/Item";

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

vi.mock("../../../src/clipboard/ClipboardCardPreview", () => ({
    default: () => <div data-testid="card-preview" />,
}));

afterEach(cleanup);

describe("clipboard card header", () => {
    it("keeps the accepted source color for the background and format tag", () => {
        const item = new Item(
            1,
            "light-header",
            ItemType.Text,
            "content",
            Date.now(),
            "rgb(255, 207, 73)",
            "",
            "",
            0,
            "explorer",
            "",
            "<p>rich content</p>",
        );

        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const header = screen.getByText("type.text").closest("[style]");
        expect(header).toHaveStyle({ color: "#fff" });
        expect(header).toHaveStyle({ background: "rgb(255, 207, 73)" });
        expect(screen.getByText("clipboard.richFormat")).toHaveStyle({
            color: "rgb(255, 207, 73)",
        });
    });

    it("uses the adjusted background color for the format tag too", () => {
        const sourceColor = "rgb(255, 255, 255)";
        const adjustedColor = ensureWhiteTextContrast(sourceColor);
        const item = new Item(
            2,
            "very-light-header",
            ItemType.Text,
            "content",
            Date.now(),
            sourceColor,
            "",
            "",
            0,
            "light-app",
            "",
            "<p>rich content</p>",
        );

        render(
            <ClipboardCard
                item={item}
                selected={false}
                simulatedHover={false}
                refreshKey={0}
                searchQuery=""
                mediaPlaybackReady={false}
                t={key => key}
                onContextMenu={vi.fn()}
            />,
        );

        const header = screen.getByText("type.text").closest("[style]");
        expect(header).toHaveStyle({ background: adjustedColor });
        expect(screen.getByText("clipboard.richFormat")).toHaveStyle({ color: adjustedColor });
    });
});
