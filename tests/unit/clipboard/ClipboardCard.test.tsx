import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClipboardCard from "../../../src/clipboard/ClipboardCard";
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
    it("keeps primary header text white when the source color is light", () => {
        const item = new Item(
            1,
            "light-header",
            ItemType.Text,
            "content",
            Date.now(),
            "rgb(250, 220, 80)",
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
        expect(header).not.toHaveStyle({ background: "rgb(250, 220, 80)" });
    });
});
