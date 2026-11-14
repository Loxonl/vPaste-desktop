import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import appIcon from "../../src-tauri/icons/source/vpaste-app-icon-1024.png";
import { notifyAuxiliaryWindowReady } from "../auxiliaryWindowReady";
import { getLanguagePack, translateWithPack, useLanguage } from "../lang";
import { formatShortcutLabel } from "../shortcutDisplay";
import { loadAndApplyTheme } from "../theme";
import type { ConfigData } from "../config/settingsTypes";
import { mainShortcutFromConfig } from "./clipboardBehavior";
import { buildTutorialFilterTabs, initializeTutorialFilterTabs, markTutorialFiltersInitialized,
    updateTutorialFilterTabs, type TutorialFilterId } from "./clipboardTutorial";
import { loadCustomTabs, normalizeCustomTabs, saveCustomTabs, type CustomTab } from "./customTabs";
import TutorialOverlay from "./TutorialOverlay";
import styles from "./NativeOnboardingWindow.module.css";

// Reuse the shipping tutorial without mounting Clipboard, its cards or listeners.
export default function NativeOnboardingWindow() {
    const { t, setLanguageCode } = useLanguage();
    const [tabs, setTabs] = useState<CustomTab[] | null>(null);
    const [shortcut, setShortcut] = useState("");
    const [actionError, setActionError] = useState("");
    const [loadAttempt, setLoadAttempt] = useState(0);
    const draft = useRef<CustomTab[]>([]);
    const saved = useRef<CustomTab[]>([]);
    const writes = useRef(Promise.resolve());
    const completing = useRef(false);
    const initialization = useRef<Promise<{ tabs: CustomTab[]; config: ConfigData }> | null>(null);

    useEffect(() => {
        let disposed = false;
        let cancelReady = () => undefined as void;
        initialization.current ??= (async () => {
            const [rawConfig, value] = await Promise.all([
                invoke<string>("get_config", { skipAutostartRefresh: true }),
                invoke<unknown>("get_custom_tabs"),
                loadAndApplyTheme(),
            ]);
            const config = JSON.parse(rawConfig) as ConfigData;
            const stored = normalizeCustomTabs(value);
            const previous = stored.length ? stored : loadCustomTabs();
            const initial = initializeTutorialFilterTabs(previous, config.onboarding_completed === false,
                key => translateWithPack(getLanguagePack(config.multilingual), key));
            if (initial !== previous || (!stored.length && previous.length)) {
                saveCustomTabs(initial);
                await invoke("save_custom_tabs", { tabs: initial });
            }
            await invoke("begin_onboarding");
            return { tabs: initial, config };
        })();
        void initialization.current.then(result => {
            if (disposed) return;
            draft.current = saved.current = result.tabs;
            setTabs(result.tabs);
            setLanguageCode(result.config.multilingual);
            setShortcut(formatShortcutLabel(mainShortcutFromConfig(result.config), false));
            setActionError("");
        }).catch(reason => {
            if (!disposed) setActionError(String(reason));
            initialization.current = null;
        }).finally(() => {
            if (!disposed) cancelReady = notifyAuxiliaryWindowReady();
        });
        return () => { disposed = true; cancelReady(); };
    }, [loadAttempt]);

    const toggle = (id: TutorialFilterId, enabled: boolean) => {
        if (completing.current) return;
        const next = updateTutorialFilterTabs(draft.current, id, enabled, t);
        draft.current = next;
        setTabs(next);
        setActionError("");
        const write = writes.current.catch(() => undefined).then(async () => {
            await invoke("save_custom_tabs", { tabs: next });
            saved.current = next;
            saveCustomTabs(next);
            markTutorialFiltersInitialized();
        });
        writes.current = write;
        void write.catch(reason => {
            if (draft.current === next) {
                draft.current = saved.current;
                setTabs(saved.current);
                setActionError(String(reason));
            }
        });
    };

    const complete = async () => {
        if (completing.current) return;
        completing.current = true;
        try {
            await writes.current;
            await invoke("complete_onboarding");
        } catch (reason) {
            setActionError(String(reason));
            // The failed draft was rolled back. Allow completion to retry.
            writes.current = Promise.resolve();
        } finally {
            completing.current = false;
        }
    };

    return (
        <main className={styles.root}>
            <section className={styles.surface} aria-label={t("tutorial.welcome.title")}>
                {tabs ? <TutorialOverlay t={t} logoSrc={appIcon} shortcutText={shortcut}
                    platform="windows" permissions={[]} filters={buildTutorialFilterTabs(tabs, t)}
                    onPermissionAction={() => undefined} onToggleFilter={toggle}
                    onShortcutDemoAvailabilityChange={enabled => {
                        void invoke("set_onboarding_shortcut_demo_enabled", { enabled })
                            .catch(reason => setActionError(String(reason)));
                    }} onComplete={() => void complete()} />
                    : !actionError && <CircularProgress aria-label={t("common.loading")} />}
                {actionError && <Alert severity="error" className={styles.error} action={!tabs
                    ? <Button onClick={() => setLoadAttempt(attempt => attempt + 1)}>{t("common.retry")}</Button>
                    : undefined}>{actionError}</Alert>}
            </section>
        </main>
    );
}
