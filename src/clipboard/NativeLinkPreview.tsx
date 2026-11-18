import { useEffect, useRef, useState } from "react";
import Button from "@mui/material/Button";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import styles from "./Preview.module.css";

const ERROR_MESSAGES = new Map([
    ["link_preview_proxy_unavailable", "preview.linkProxyUnavailable"],
    ["link_preview_fake_ip", "preview.linkFakeIp"],
    ["link_preview_timeout", "preview.linkTimeout"],
    ["link_preview_blocked", "preview.linkBlocked"],
    ["link_preview_network", "preview.linkNetworkError"],
    ["link_preview_not_html", "preview.linkNotHtml"],
    ["link_preview_redirect_limit", "preview.linkRedirectLimit"],
    ["link_preview_http_status", "preview.linkHttpError"],
]);

export function NativeLinkPreview({ url, requestId, active, t }: {
    url: string; requestId: number; active: boolean;
    t: (key: string, params?: Record<string, string | number>) => string;
}) {
    const host = useRef<HTMLDivElement>(null);
    const [failure, setFailure] = useState("");
    const [attached, setAttached] = useState(false);
    const [location, setLocation] = useState(url);
    useEffect(() => {
        if (!active || !url) return;
        let cancelled = false;
        let inFlight = false;
        let pending = false;
        setFailure("");
        setAttached(false);
        setLocation(url);
        const unlisten = listen<{ requestId: number; url: string }>("preview-browser-location", event => {
            if (!cancelled && event.payload.requestId === requestId) setLocation(event.payload.url);
        });
        const sync = () => {
            if (cancelled || !host.current) return;
            if (inFlight) { pending = true; return; }
            // Offset geometry excludes the content layer's Motion transform.
            let x = 0, y = 0;
            let element: HTMLElement | null = host.current;
            while (element) {
                x += element.offsetLeft;
                y += element.offsetTop;
                element = element.offsetParent as HTMLElement | null;
            }
            const bounds = { x, y, width: host.current.offsetWidth, height: host.current.offsetHeight,
                viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
            if (bounds.width <= 0 || bounds.height <= 0) return;
            inFlight = true;
            pending = false;
            void invoke<boolean>("sync_preview_browser", { url, requestId, bounds })
                .then(accepted => { if (!cancelled && accepted) setAttached(true); })
                .catch(cause => {
                    if (cancelled) return;
                    const message = ERROR_MESSAGES.get(typeof cause === "string" ? cause : "") || "preview.linkNetworkError";
                    setFailure(message);
                    error(`Native webpage preview failed: ${message}`);
                })
                .finally(() => {
                    inFlight = false;
                    if (pending && !cancelled) sync();
                });
        };
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
        if (host.current) observer?.observe(host.current);
        window.addEventListener("resize", sync);
        sync();
        return () => {
            cancelled = true;
            observer?.disconnect();
            window.removeEventListener("resize", sync);
            void unlisten.then(fn => fn()).catch(() => error("Failed to unlisten webpage location"));
            void invoke("hide_preview_browser", { requestId })
                .catch(() => error("Failed to park the webpage preview"));
        };
    }, [active, requestId, url]);
    return <>
        <div className={styles["preview-link-bar"]} title={location}><span>{location}</span></div>
        <div ref={host} className={styles["preview-link-frame"]} role="region" aria-label={location} aria-hidden={!active || (attached && !failure)}>
        {(!attached || failure) &&
        <div className={styles["preview-link-loading"]}>
            <span role={failure ? "alert" : "status"}>{t(failure || "preview.generating")}</span>
            {failure && <Button size="small" onClick={() => {
                void invoke("open_url_in_browser", { url }).catch(() => error("Failed to open original preview link"));
            }}>{t("preview.openOriginalLink")}</Button>}
        </div>}
        </div>
    </>;
}
