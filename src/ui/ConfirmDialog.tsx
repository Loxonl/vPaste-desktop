import { useId, type ReactNode } from "react";
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
    description: string | readonly string[];
    warning?: string;
    cancelLabel: string;
    confirmLabel: string;
    backdropClassName?: string;
    cancelDisabled?: boolean;
    confirmDisabled?: boolean;
    status?: ReactNode;
    destructive?: boolean;
    /** Lets the dialog handle every key itself inside windows with global shortcuts. */
    keyboardPassthrough?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
};

export function ConfirmDialog({
    open,
    title,
    description,
    warning,
    cancelLabel,
    confirmLabel,
    backdropClassName,
    cancelDisabled = false,
    confirmDisabled = false,
    status,
    destructive = true,
    keyboardPassthrough = false,
    onCancel,
    onConfirm,
}: ConfirmDialogProps) {
    const titleId = useId();
    const descriptionId = useId();
    const warningId = useId();

    return (
        <Dialog
            open={open}
            onClose={onCancel}
            aria-labelledby={titleId}
            aria-describedby={warning ? `${descriptionId} ${warningId}` : descriptionId}
            maxWidth={false}
            data-keyboard-passthrough={keyboardPassthrough ? "dialog" : undefined}
            BackdropProps={{
                className: [styles.backdrop, backdropClassName].filter(Boolean).join(" "),
            }}
            PaperProps={{ className: styles.paper, role: destructive ? "alertdialog" : "dialog" }}
        >
            <DialogTitle id={titleId} className={styles.title}>
                {title}
            </DialogTitle>
            <DialogContent className={styles.content}>
                <DialogContentText id={descriptionId} className={styles.description} component={typeof description === "string" ? "p" : "div"}>
                    {typeof description === "string" ? description : (
                        <ul className={styles.details}>
                            {description.map(line => <li key={line}>{line}</li>)}
                        </ul>
                    )}
                </DialogContentText>
                {warning && <DialogContentText id={warningId} className={styles.warning}>{warning}</DialogContentText>}
                {status}
            </DialogContent>
            <DialogActions className={styles.actions}>
                <Button disabled={cancelDisabled} onClick={onCancel}>{cancelLabel}</Button>
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
