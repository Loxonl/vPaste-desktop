import { Item, ItemType, type ItemTag } from "./Item";
import { imageExportSourcePath, isTextLikeItem } from "./itemPresentation";
import type { ColorCopyOption, ContextMenuOption } from "./ClipboardOverlays";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type MenuAction = void | Promise<void>;

export type ClipboardContextMenuActions = {
    onAssignTag: (item: Item, tag: ItemTag) => MenuAction;
    onCopyColor: (value: string) => MenuAction;
    onCopyContainingFolder: (item: Item) => MenuAction;
    onCreateRecordTag: (item: Item) => MenuAction;
    onDelete: (item: Item) => MenuAction;
    onExportImage: (item: Item) => MenuAction;
    onOpenContainingFolder: (item: Item) => MenuAction;
    onPastePlainText: (item: Item) => MenuAction;
    onPreview: (item: Item) => MenuAction;
    onRemoveAllTags: (item: Item) => MenuAction;
    onRemoveTag: (item: Item, tag: ItemTag) => MenuAction;
    onToggleFavorite: (item: Item) => MenuAction;
};

type ClipboardContextMenuOptions = {
    actions: ClipboardContextMenuActions;
    colorOptions: ColorCopyOption[];
    currentItemTags: ItemTag[];
    item: Item;
    t: Translate;
};

export function buildClipboardContextMenuOptions({
    actions,
    colorOptions,
    currentItemTags,
    item,
    t,
}: ClipboardContextMenuOptions): ContextMenuOption[] {
    const assignedTagIds = new Set(item.getTags().map(tag => tag.id));
    const currentTagIds = new Set(currentItemTags.map(tag => tag.id));
    const assignableTags = currentItemTags.filter(tag => !assignedTagIds.has(tag.id));
    const assignedTags = item.getTags().filter(tag => currentTagIds.has(tag.id));
    const options: ContextMenuOption[] = [
        { label: t("menu.preview"), action: () => actions.onPreview(item) },
        {
            label: item.isFavorite() ? t("menu.removeFavorite") : t("menu.addFavorite"),
            action: () => actions.onToggleFavorite(item),
        },
    ];

    options.push(currentItemTags.length === 0
        ? {
            label: t("menu.addRecordTag"),
            action: () => actions.onCreateRecordTag(item),
        }
        : {
            label: t("menu.addRecordTag"),
            children: [
                {
                    label: t("tags.createRecord"),
                    action: () => actions.onCreateRecordTag(item),
                },
                ...(assignableTags.length > 0
                    ? assignableTags.map(tag => ({
                        label: tag.name,
                        action: () => actions.onAssignTag(item, tag),
                    }))
                    : [{ label: t("tags.noAssignable"), action: () => undefined }]),
            ],
        });

    if (assignedTags.length > 0) {
        options.push({
            label: t("menu.removeRecordTag"),
            children: [
                {
                    label: t("menu.removeAllTags"),
                    action: () => actions.onRemoveAllTags(item),
                    danger: true,
                },
                ...assignedTags.map(tag => ({
                    label: tag.name,
                    action: () => actions.onRemoveTag(item, tag),
                })),
            ],
        });
    }

    if (imageExportSourcePath(item)) {
        options.push({
            label: t("menu.exportImage"),
            action: () => actions.onExportImage(item),
        });
    }

    if (item.getType() === ItemType.File) {
        options.push(
            {
                label: t("menu.openContainingFolder"),
                action: () => actions.onOpenContainingFolder(item),
            },
            {
                label: t("menu.copyContainingFolder"),
                action: () => actions.onCopyContainingFolder(item),
            },
        );
    }

    if (item.getType() === ItemType.Color) {
        options.push({
            label: t("menu.convertColor"),
            children: colorOptions.length > 0
                ? colorOptions.map(option => ({
                    label: `${option.format} ${option.value}`,
                    action: () => actions.onCopyColor(option.value),
                }))
                : [{ label: t("clipboard.colorUnsupported"), action: () => undefined }],
        });
    }

    if (isTextLikeItem(item)) {
        options.push({
            label: t("menu.pastePlainText"),
            action: () => actions.onPastePlainText(item),
        });
    }

    options.push({
        label: t("menu.deleteRecord"),
        action: () => actions.onDelete(item),
    });
    return options;
}
