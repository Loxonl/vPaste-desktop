import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineMenuItem, InlineMenuSurface } from "../ui/InlineMenu";
import { Item, ItemTag } from "./Item";
import { type CustomTab } from "./customTabs";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

export type ColorCopyOption = {
    format: string;
    value: string;
};

export type ContextMenuState = {
    item: Item;
    x: number;
    y: number;
    originX: number;
    originY: number;
    submenuSide: "left" | "right";
    itemTags: ItemTag[];
    colorOptions: ColorCopyOption[];
} | null;

export type ContextMenuOption = {
    label: string;
    action?: () => void | Promise<void>;
    children?: ContextMenuOption[];
    danger?: boolean;
};

export type TabContextMenuState = {
    kind: "filter";
    tab: CustomTab;
    x: number;
    y: number;
    originX: number;
    originY: number;
} | {
    kind: "record";
    tag: ItemTag;
    x: number;
    y: number;
    originX: number;
    originY: number;
} | null;

export type TagCreateChoiceState = {
    x: number;
    y: number;
    originX: number;
    originY: number;
} | null;

type TagCreateChoicePopoverProps = {
    state: NonNullable<TagCreateChoiceState>;
    t: TFunction;
    onSelect: (kind: "filter" | "record", originX: number, originY: number) => void;
};

export function TagCreateChoicePopover({
    state,
    t,
    onSelect,
}: TagCreateChoicePopoverProps) {
    return (
        <InlineMenuSurface
            className={classes(styles, "tag-create-choice-popover")}
            style={{ left: state.x, top: state.y }}
        >
            <InlineMenuItem
                multiline
                onClick={() => onSelect("filter", state.originX, state.originY)}
            >
                <strong>{t("tabs.filterTag")}</strong>
                <span>{t("tabs.filterTagDesc")}</span>
            </InlineMenuItem>
            <InlineMenuItem
                multiline
                onClick={() => onSelect("record", state.originX, state.originY)}
            >
                <strong>{t("tabs.recordTag")}</strong>
                <span>{t("tabs.recordTagDesc")}</span>
            </InlineMenuItem>
        </InlineMenuSurface>
    );
}

type ClipboardContextMenusProps = {
    state: NonNullable<ContextMenuState>;
    options: ContextMenuOption[];
    selectedIndex: number;
    submenuOptions: ContextMenuOption[];
    submenuLeft: number;
    submenuTop: number;
    onSelectedIndexChange: (index: number) => void;
};

export function ClipboardContextMenus({
    state,
    options,
    selectedIndex,
    submenuOptions,
    submenuLeft,
    submenuTop,
    onSelectedIndexChange,
}: ClipboardContextMenusProps) {
    return (
        <>
            <InlineMenuSurface
                className={classes(styles, "context-menu")}
                style={{ left: state.x, top: state.y }}
            >
                {options.map((option, index) => (
                    <InlineMenuItem
                        key={option.label}
                        selected={index === selectedIndex}
                        danger={option.danger}
                        endAdornment={option.children ? "›" : undefined}
                        onMouseEnter={() => onSelectedIndexChange(index)}
                        onClick={() => {
                            if (option.action) void option.action();
                        }}
                    >
                        {option.label}
                    </InlineMenuItem>
                ))}
            </InlineMenuSurface>
            {submenuOptions.length > 0 && (
                <InlineMenuSurface
                    className={classes(styles, "context-submenu")}
                    style={{ left: submenuLeft, top: submenuTop }}
                    scrollable
                >
                    {submenuOptions.map(option => (
                        <InlineMenuItem
                            key={option.label}
                            title={option.label}
                            danger={option.danger}
                            onClick={() => {
                                if (option.action) void option.action();
                            }}
                        >
                            {option.label}
                        </InlineMenuItem>
                    ))}
                </InlineMenuSurface>
            )}
        </>
    );
}

type TabContextMenuProps = {
    state: NonNullable<TabContextMenuState>;
    t: TFunction;
    onEdit: (state: NonNullable<TabContextMenuState>) => void;
    onDelete: (state: NonNullable<TabContextMenuState>) => void;
};

export function TabContextMenu({
    state,
    t,
    onEdit,
    onDelete,
}: TabContextMenuProps) {
    return (
        <InlineMenuSurface
            className={classes(styles, "tab-context-menu")}
            style={{ left: state.x, top: state.y }}
            onContextMenu={event => event.preventDefault()}
        >
            <InlineMenuItem
                onClick={event => {
                    event.stopPropagation();
                    onEdit(state);
                }}
            >
                {t("tabs.edit")}
            </InlineMenuItem>
            <InlineMenuItem
                danger
                onClick={event => {
                    event.stopPropagation();
                    onDelete(state);
                }}
            >
                {t("tabs.delete")}
            </InlineMenuItem>
        </InlineMenuSurface>
    );
}

type DeleteConfirmDialogProps = {
    title: string;
    description: string;
    cancelLabel: string;
    confirmLabel: string;
    onCancel: () => void;
    onConfirm: () => void;
};

export function DeleteConfirmDialog({
    title,
    description,
    cancelLabel,
    confirmLabel,
    onCancel,
    onConfirm,
}: DeleteConfirmDialogProps) {
    return (
        <ConfirmDialog
            open
            title={title}
            description={description}
            cancelLabel={cancelLabel}
            confirmLabel={confirmLabel}
            onCancel={onCancel}
            onConfirm={onConfirm}
        />
    );
}
