import {
    forwardRef,
    type MouseEventHandler,
    type ReactNode,
} from "react";
import MenuItem, { type MenuItemProps } from "@mui/material/MenuItem";
import MenuList from "@mui/material/MenuList";
import Paper, { type PaperProps } from "@mui/material/Paper";
import { classes } from "./classNames";
import { m, useMotionPreset } from "./motion";
import styles from "./InlineMenu.module.css";

export type InlineMenuSurfaceProps = Omit<PaperProps, "children"> & {
    children: ReactNode;
    listClassName?: string;
    scrollable?: boolean;
};

export const InlineMenuSurface = forwardRef<HTMLDivElement, InlineMenuSurfaceProps>(
    function InlineMenuSurface({ children, className, listClassName, scrollable = false, onClick, onMouseDown, style, ...props }, ref) {
        const variants = useMotionPreset("popover");
        const stopClick: MouseEventHandler<HTMLDivElement> = event => {
            event.stopPropagation();
            onClick?.(event);
        };
        const stopMouseDown: MouseEventHandler<HTMLDivElement> = event => {
            event.stopPropagation();
            onMouseDown?.(event);
        };

        return (
            <m.div
                ref={ref}
                className={classes(styles, `motionRoot ${className ?? ""}`)}
                style={style}
                variants={variants}
                data-motion-preset="popover"
                initial="initial"
                animate="animate"
                exit="exit"
                onClick={stopClick}
                onMouseDown={stopMouseDown}
            >
                <Paper
                    {...props}
                    elevation={0}
                    className={classes(styles, `surface ${scrollable ? "scrollable" : ""}`)}
                >
                    <MenuList disablePadding className={classes(styles, `list ${listClassName ?? ""}`)}>
                        {children}
                    </MenuList>
                </Paper>
            </m.div>
        );
    },
);

export type InlineMenuItemProps = MenuItemProps & {
    danger?: boolean;
    multiline?: boolean;
    endAdornment?: ReactNode;
};

export function InlineMenuItem({
    children,
    className,
    danger = false,
    multiline = false,
    endAdornment,
    selected = false,
    ...props
}: InlineMenuItemProps) {
    return (
        <MenuItem
            {...props}
            selected={selected}
            className={classes(styles, `item ${selected ? "selected" : ""} ${danger ? "danger" : ""} ${multiline ? "multiline" : ""} ${className ?? ""}`)}
        >
            {children}
            {endAdornment && <span className={styles.endAdornment}>{endAdornment}</span>}
        </MenuItem>
    );
}
