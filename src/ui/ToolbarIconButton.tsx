import { forwardRef } from "react";
import IconButton, { type IconButtonProps } from "@mui/material/IconButton";

export type ToolbarIconButtonProps = Omit<IconButtonProps, "aria-label"> & {
    label: string;
};

export const ToolbarIconButton = forwardRef<HTMLButtonElement, ToolbarIconButtonProps>(
    function ToolbarIconButton({ label, title = label, size = "medium", ...props }, ref) {
        return (
            <IconButton
                {...props}
                ref={ref}
                size={size}
                title={title}
                aria-label={label}
            />
        );
    },
);
