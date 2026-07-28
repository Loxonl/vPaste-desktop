import { describe, expect, it, vi } from "vitest";
import {
    buildClipboardContextMenuOptions,
    type ClipboardContextMenuActions,
} from "../../../src/clipboard/clipboardContextMenu";
import { Item, ItemType, type ItemTag } from "../../../src/clipboard/Item";

function item(
    type: ItemType,
    {
        content = "content",
        favorite = false,
        previewContent = "",
        tags = [],
    }: {
        content?: string;
        favorite?: boolean;
        previewContent?: string;
        tags?: ItemTag[];
    } = {},
) {
    return new Item(
        1,
        `hash-${type}`,
        type,
        content,
        0,
        undefined,
        previewContent,
        "",
        favorite ? 1 : 0,
        "",
        "",
        "",
        tags,
    );
}

function actions(): ClipboardContextMenuActions {
    return {
        onAssignTag: vi.fn(),
        onCopyColor: vi.fn(),
        onCopyContainingFolder: vi.fn(),
        onCreateRecordTag: vi.fn(),
        onDelete: vi.fn(),
        onExportImage: vi.fn(),
        onOpenContainingFolder: vi.fn(),
        onPastePlainText: vi.fn(),
        onPreview: vi.fn(),
        onRemoveAllTags: vi.fn(),
        onRemoveTag: vi.fn(),
        onToggleFavorite: vi.fn(),
    };
}

const t = (key: string) => key;

describe("buildClipboardContextMenuOptions", () => {
    it("keeps base, favorite, text, and delete actions in their established order", () => {
        const callbacks = actions();
        const target = item(ItemType.Text, { favorite: true });
        const options = buildClipboardContextMenuOptions({
            actions: callbacks,
            colorOptions: [],
            currentItemTags: [],
            item: target,
            t,
        });

        expect(options.map(option => option.label)).toEqual([
            "menu.preview",
            "menu.removeFavorite",
            "menu.addRecordTag",
            "menu.pastePlainText",
            "menu.deleteRecord",
        ]);

        void options[0].action?.();
        void options[1].action?.();
        void options[2].action?.();
        void options[3].action?.();
        void options[4].action?.();
        expect(callbacks.onPreview).toHaveBeenCalledWith(target);
        expect(callbacks.onToggleFavorite).toHaveBeenCalledWith(target);
        expect(callbacks.onCreateRecordTag).toHaveBeenCalledWith(target);
        expect(callbacks.onPastePlainText).toHaveBeenCalledWith(target);
        expect(callbacks.onDelete).toHaveBeenCalledWith(target);
    });

    it("shows only assignable and currently valid assigned tags", () => {
        const callbacks = actions();
        const assigned: ItemTag = { id: 1, name: "Assigned" };
        const stale: ItemTag = { id: 99, name: "Stale" };
        const available: ItemTag = { id: 2, name: "Available" };
        const target = item(ItemType.Text, { tags: [assigned, stale] });
        const options = buildClipboardContextMenuOptions({
            actions: callbacks,
            colorOptions: [],
            currentItemTags: [assigned, available],
            item: target,
            t,
        });

        const addTags = options.find(option => option.label === "menu.addRecordTag")?.children;
        const removeTags = options.find(option => option.label === "menu.removeRecordTag")?.children;
        expect(addTags?.map(option => option.label)).toEqual(["tags.createRecord", "Available"]);
        expect(removeTags?.map(option => option.label)).toEqual(["menu.removeAllTags", "Assigned"]);
        expect(removeTags?.[0].danger).toBe(true);

        void addTags?.[1].action?.();
        void removeTags?.[1].action?.();
        expect(callbacks.onAssignTag).toHaveBeenCalledWith(target, available);
        expect(callbacks.onRemoveTag).toHaveBeenCalledWith(target, assigned);
    });

    it("adds export and folder actions for a single image file", () => {
        const callbacks = actions();
        const target = item(ItemType.File, {
            content: JSON.stringify(["C:\\Temp\\image.png"]),
        });
        const options = buildClipboardContextMenuOptions({
            actions: callbacks,
            colorOptions: [],
            currentItemTags: [],
            item: target,
            t,
        });

        expect(options.map(option => option.label)).toEqual([
            "menu.preview",
            "menu.addFavorite",
            "menu.addRecordTag",
            "menu.exportImage",
            "menu.openContainingFolder",
            "menu.copyContainingFolder",
            "menu.deleteRecord",
        ]);
    });

    it("builds color conversion children and forwards only the selected value", () => {
        const callbacks = actions();
        const target = item(ItemType.Color);
        const options = buildClipboardContextMenuOptions({
            actions: callbacks,
            colorOptions: [
                { format: "HEX", value: "#3366FF" },
                { format: "RGB", value: "rgb(51, 102, 255)" },
            ],
            currentItemTags: [],
            item: target,
            t,
        });

        const conversions = options.find(option => option.label === "menu.convertColor")?.children;
        expect(conversions?.map(option => option.label)).toEqual([
            "HEX #3366FF",
            "RGB rgb(51, 102, 255)",
        ]);

        void conversions?.[1].action?.();
        expect(callbacks.onCopyColor).toHaveBeenCalledWith("rgb(51, 102, 255)");
    });

    it("shows the existing unsupported color entry when conversions are unavailable", () => {
        const options = buildClipboardContextMenuOptions({
            actions: actions(),
            colorOptions: [],
            currentItemTags: [],
            item: item(ItemType.Color),
            t,
        });

        expect(options.find(option => option.label === "menu.convertColor")?.children)
            .toEqual([expect.objectContaining({ label: "clipboard.colorUnsupported" })]);
    });
});
