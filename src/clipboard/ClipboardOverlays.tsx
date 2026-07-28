import styles from "./Clipboard.module.css";
import { classes } from "../ui/classNames";
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
        <div
            className={classes(styles, "tag-create-choice-popover")}
            style={{ left: state.x, top: state.y }}
            onClick={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
        >
            <button
                type="button"
                onClick={() => onSelect("filter", state.originX, state.originY)}
            >
                <strong>{t("tabs.filterTag")}</strong>
                <span>{t("tabs.filterTagDesc")}</span>
            </button>
            <button
                type="button"
                onClick={() => onSelect("record", state.originX, state.originY)}
            >
                <strong>{t("tabs.recordTag")}</strong>
                <span>{t("tabs.recordTagDesc")}</span>
            </button>
        </div>
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
            <div
                className={classes(styles, "context-menu")}
                style={{ left: state.x, top: state.y }}
                role="menu"
                onClick={event => event.stopPropagation()}
                onMouseDown={event => event.stopPropagation()}
            >
                {options.map((option, index) => (
                    <button
                        key={option.label}
                        type="button"
                        role="menuitem"
                        className={classes(styles, `${index === selectedIndex ? 'selected' : ''} ${option.children ? 'has-submenu' : ''} ${option.danger ? 'danger' : ''}`)}
                        onMouseEnter={() => onSelectedIndexChange(index)}
                        onClick={() => {
                            if (option.action) void option.action();
                        }}
                    >
                        {option.label}
                        {option.children && <span className={classes(styles, "context-menu-chevron")}>›</span>}
                    </button>
                ))}
            </div>
            {submenuOptions.length > 0 && (
                <div
                    className={classes(styles, "context-submenu")}
                    style={{ left: submenuLeft, top: submenuTop }}
                    role="menu"
                    onClick={event => event.stopPropagation()}
                    onMouseDown={event => event.stopPropagation()}
                >
                    {submenuOptions.map(option => (
                        <button
                            key={option.label}
                            type="button"
                            role="menuitem"
                            title={option.label}
                            className={classes(styles, option.danger ? 'danger' : '')}
                            onClick={() => {
                                if (option.action) void option.action();
                            }}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
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
        <div
            className={classes(styles, "tab-context-menu")}
            style={{ left: state.x, top: state.y }}
            role="menu"
            onClick={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onContextMenu={event => event.preventDefault()}
        >
            <button
                type="button"
                role="menuitem"
                onClick={event => {
                    event.stopPropagation();
                    onEdit(state);
                }}
            >
                {t("tabs.edit")}
            </button>
            <button
                type="button"
                role="menuitem"
                className={classes(styles, "danger")}
                onClick={event => {
                    event.stopPropagation();
                    onDelete(state);
                }}
            >
                {t("tabs.delete")}
            </button>
        </div>
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
        <div
            className={classes(styles, "tab-confirm-backdrop")}
            onClick={onCancel}
        >
            <div
                className={classes(styles, "tab-confirm-dialog")}
                onClick={event => event.stopPropagation()}
            >
                <strong>{title}</strong>
                <p>{description}</p>
                <div className={classes(styles, "tab-confirm-actions")}>
                    <button type="button" onClick={onCancel}>
                        {cancelLabel}
                    </button>
                    <button type="button" className={classes(styles, "danger")} onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
