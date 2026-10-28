import { useCallback, useEffect, useId, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import { invoke } from "@tauri-apps/api/core";
import { memorySize, type MemoryReport, type MemorySample } from "./devMemory";
import styles from "./DeveloperMemoryPanel.module.css";

export default function DeveloperMemoryPanel({ open, onClose, t, fullScreen = false }: { open: boolean; onClose: () => void; t: (key: string) => string; fullScreen?: boolean }) {
    const titleId = useId();
    const [report, setReport] = useState<MemoryReport | null>(null);
    const [baseline, setBaseline] = useState<MemorySample | null>(null);
    const [selectedTimestamp, setSelectedTimestamp] = useState<number | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const initialized = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const request = useCallback(async (command: string, args: Record<string, boolean>) => {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        try {
            let next = await invoke<MemoryReport>(command, args);
            if (!initialized.current && command === "get_dev_memory_report" && !next.running && next.samples.length === 0) {
                initialized.current = true;
                next = await invoke<MemoryReport>("set_dev_memory_monitoring", { enabled: true });
            }
            initialized.current = true;
            if (mounted.current) { setReport(next); setError(""); }
        } catch (reason) {
            if (mounted.current) setError(String(reason));
        } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        void request("get_dev_memory_report", { refresh: false });
        const timer = window.setInterval(() => void request("get_dev_memory_report", { refresh: false }), 1000);
        return () => window.clearInterval(timer);
    }, [open, request]);

    const selected = report?.samples.find(sample => sample.timestamp === selectedTimestamp);
    const latest = selected ?? report?.samples[report.samples.length - 1];
    const peak = report?.samples.length ? Math.max(...report.samples.map(sample => sample.totalAccountedBytes)) : null;
    const delta = latest && baseline && !latest.partial && !baseline.partial
        ? latest.totalAccountedBytes - baseline.totalAccountedBytes : null;
    const metric = t(report?.accountedMetric === "physicalFootprint" ? "memory.footprint" : "memory.privateBytes");

    return (
        <Dialog open={open} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="md" aria-labelledby={titleId} data-keyboard-passthrough="dialog">
            <DialogTitle id={titleId}>{t("memory.title")}</DialogTitle>
            <DialogContent className={styles.content}>
                <div className={styles.controls}>
                    <FormControlLabel label={t("memory.monitoring")} control={
                        <Switch checked={report?.running ?? false} disabled={busy} onChange={(_, enabled) => void request("set_dev_memory_monitoring", { enabled })} />
                    } />
                    <span className={styles.meta}>{report?.platform} · {t("memory.interval")}</span>
                    {busy && <CircularProgress size={16} aria-label={t("memory.loading")} />}
                </div>
                <TextField select size="small" label={t("memory.sampleTime")} className={styles.sampleSelector}
                    value={selected?.timestamp ?? "live"} onChange={event => setSelectedTimestamp(event.target.value === "live" ? null : Number(event.target.value))}>
                    <MenuItem value="live">{t("memory.live")}</MenuItem>
                    {report?.samples.slice().reverse().map(sample => <MenuItem key={sample.timestamp} value={sample.timestamp}>{new Date(sample.timestamp).toLocaleTimeString()}</MenuItem>)}
                </TextField>
                {error && <Alert severity="error">{error}</Alert>}
                {latest?.partial && <Alert severity="warning">{t("memory.partial")}</Alert>}
                <p className={styles.note}>{t("memory.explanation")}</p>
                {fullScreen && <p className={styles.note}>{t("memory.ownWindow")}</p>}
                {report?.platform === "macos" && <p className={styles.note}>{t("memory.macScope")}</p>}
                <div className={styles.summary}>
                    <div><span>{t("memory.identifiedTotal")} · {metric}</span><strong>{memorySize(latest?.totalAccountedBytes ?? null)}</strong></div>
                    <div><span>{t("memory.resident")}</span><strong>{memorySize(latest?.totalResidentBytes ?? null)}</strong></div>
                    <div><span>{t("memory.peak")}</span><strong>{memorySize(peak)}</strong></div>
                    <div><span>{t("memory.baselineDelta")}</span><strong>{delta === null ? "—" : `${delta >= 0 ? "+" : "−"}${memorySize(Math.abs(delta))}`}</strong></div>
                </div>
                <h3 className={styles.sectionTitle}>{t("memory.processes")}</h3>
                <TableContainer className={styles.table}>
                    <Table size="small" aria-label={t("memory.processes")}>
                        <TableHead><TableRow>
                            <TableCell>{t("memory.owner")}</TableCell><TableCell>PID</TableCell><TableCell>{t("memory.resident")}</TableCell><TableCell>{metric}</TableCell>
                        </TableRow></TableHead>
                        <TableBody>{latest?.processes.map(process => (
                            <TableRow key={process.pid}>
                                <TableCell>
                                    <div>{process.windowLabels.length ? process.windowLabels.join(", ") : t(`memory.kind.${process.kind}`)}</div>
                                    {(process.windowLabels.length > 0 || process.retained) && <span className={styles.meta}>{[
                                        process.windowLabels.length > 0 ? t(`memory.kind.${process.kind}`) : "",
                                        process.windowLabels.length > 1 ? t("memory.shared") : "",
                                        process.retained ? t("memory.retained") : "",
                                    ].filter(Boolean).join(" · ")}</span>}
                                    {process.error && <div className={styles.error}>{process.error}</div>}
                                </TableCell>
                                <TableCell>{process.pid}</TableCell><TableCell>{memorySize(process.residentBytes)}</TableCell><TableCell>{memorySize(process.accountedBytes)}</TableCell>
                            </TableRow>
                        ))}</TableBody>
                    </Table>
                </TableContainer>
                <h3 className={styles.sectionTitle}>{t("memory.windows")}</h3>
                <TableContainer className={styles.table}>
                    <Table size="small" aria-label={t("memory.windows")}>
                        <TableHead><TableRow><TableCell>{t("memory.window")}</TableCell><TableCell>{t("memory.state")}</TableCell><TableCell>{t(report?.platform === "macos" ? "memory.mainRendererPid" : "memory.rendererPids")}</TableCell></TableRow></TableHead>
                        <TableBody>{latest?.windows.map(window => (
                            <TableRow key={window.label}><TableCell>{window.label}{window.error && <div className={styles.error}>{window.error}</div>}</TableCell><TableCell>{t(window.visible ? "memory.visible" : "memory.hidden")}</TableCell><TableCell>{window.rendererPids.join(", ") || "—"}</TableCell></TableRow>
                        ))}</TableBody>
                    </Table>
                </TableContainer>
                <p className={styles.note}>{latest ? `${new Date(latest.timestamp).toLocaleTimeString()} · ${report?.samples.length} ${t("memory.samples")}` : t("memory.waiting")}</p>
            </DialogContent>
            <DialogActions className={styles.actions}>
                <Button disabled={!latest || busy || latest.partial} onClick={() => setBaseline(latest ?? null)}>{t("memory.setBaseline")}</Button>
                <Button disabled={busy} onClick={() => void request("get_dev_memory_report", { refresh: true })}>{t("memory.refresh")}</Button>
                <Button onClick={onClose}>{t("memory.close")}</Button>
            </DialogActions>
        </Dialog>
    );
}
