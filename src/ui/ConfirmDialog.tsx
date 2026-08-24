import { useId } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import styles from "./ConfirmDialog.module.css";

export type ConfirmDialogProps = {
    open: boolean;
    title: string;
    description: string;
    cancelLabel: string;
    confirmLabel: string;
    confirmDisabled?: boolean;
    destructive?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
};

export function ConfirmDialog({
    open,
    title,
    description,
    cancelLabel,
    confirmLabel,
    confirmDisabled = false,
    destructive = true,
    onCancel,
    onConfirm,
}: ConfirmDialogProps) {
    const titleId = useId();
    const descriptionId = useId();

    return (
        <Dialog
            open={open}
            onClose={onCancel}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            maxWidth={false}
            BackdropProps={{ className: styles.backdrop }}
            PaperProps={{ className: styles.paper, role: destructive ? "alertdialog" : "dialog" }}
        >
            <DialogTitle id={titleId} className={styles.title}>
                {title}
            </DialogTitle>
            <DialogContent className={styles.content}>
                <DialogContentText id={descriptionId} className={styles.description}>
                    {description}
                </DialogContentText>
            </DialogContent>
            <DialogActions className={styles.actions}>
                <Button onClick={onCancel}>{cancelLabel}</Button>
                <Button
                    variant="contained"
                    color={destructive ? "error" : "primary"}
                    disabled={confirmDisabled}
                    onClick={onConfirm}
                >
                    {confirmLabel}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
