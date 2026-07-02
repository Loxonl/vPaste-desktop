import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HistoryIcon from "@mui/icons-material/History";
import TextFieldsIcon from "@mui/icons-material/TextFields";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import PaletteOutlinedIcon from "@mui/icons-material/PaletteOutlined";
import LinkOutlinedIcon from "@mui/icons-material/LinkOutlined";
import { useLanguage } from "../lang";
import { formatShortcutLabel } from "../shortcutDisplay";
import "./Onboarding.css";

type StepId = "text" | "image" | "file" | "color" | "link";

type GuideStep = {
    id: StepId;
    icon: React.ReactNode;
    titleKey: string;
    sampleKey: string;
};

const steps: GuideStep[] = [
    {
        id: "text",
        icon: <TextFieldsIcon />,
        titleKey: "onboarding.step.text",
        sampleKey: "onboarding.sample.text",
    },
    {
        id: "image",
        icon: <ImageOutlinedIcon />,
        titleKey: "onboarding.step.image",
        sampleKey: "onboarding.sample.image",
    },
    {
        id: "file",
        icon: <DescriptionOutlinedIcon />,
        titleKey: "onboarding.step.file",
        sampleKey: "onboarding.sample.file",
    },
    {
        id: "color",
        icon: <PaletteOutlinedIcon />,
        titleKey: "onboarding.step.color",
        sampleKey: "onboarding.sample.color",
    },
    {
        id: "link",
        icon: <LinkOutlinedIcon />,
        titleKey: "onboarding.step.link",
        sampleKey: "onboarding.sample.link",
    },
];

const DEFAULT_MAIN_SHORTCUT = "Alt+V";

export default function Onboarding() {
    const { t } = useLanguage();
    const [copied, setCopied] = React.useState<Record<string, boolean>>({});
    const [mainShortcut, setMainShortcut] = React.useState(DEFAULT_MAIN_SHORTCUT);

    const reloadShortcut = React.useCallback(() => {
        invoke<string>("get_config")
            .then(config => {
                const parsed = JSON.parse(config);
                setMainShortcut(parsed.shortcut_keys?.main_window || DEFAULT_MAIN_SHORTCUT);
            })
            .catch(e => error(`Failed to load onboarding shortcut: ${e}`));
    }, []);

    const resetGuide = React.useCallback(() => {
        setCopied({});
        reloadShortcut();
    }, [reloadShortcut]);

    React.useEffect(() => {
        reloadShortcut();
    }, [reloadShortcut]);

    React.useEffect(() => {
        const unlisten = listen("onboarding-opened", resetGuide);
        return () => {
            unlisten.then(fn => fn()).catch(e => error(`Failed to unlisten onboarding-opened: ${e}`));
        };
    }, [resetGuide]);

    React.useEffect(() => {
        const handleFocus = () => resetGuide();
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                resetGuide();
            }
        };
        window.addEventListener("focus", handleFocus);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.removeEventListener("focus", handleFocus);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [resetGuide]);

    const shortcutText = formatShortcutLabel(mainShortcut);

    const copySample = async (step: GuideStep) => {
        try {
            await invoke("copy_onboarding_sample", { sampleType: step.id, sample: t(step.sampleKey) });
            setCopied(previous => ({ ...previous, [step.id]: true }));
        } catch (e) {
            error(`Failed to copy onboarding sample: ${e}`);
        }
    };

    const closeGuide = async () => {
        try {
            setCopied({});
            await invoke("complete_onboarding");
        } catch (e) {
            error(`Failed to close onboarding: ${e}`);
        }
    };

    return (
        <main className="onboarding-shell">
            <section className="onboarding-hero">
                <div>
                    <div className="onboarding-kicker">{t("onboarding.kicker")}</div>
                    <h1>{t("onboarding.title")}</h1>
                </div>
                <div className="shortcut-callout">
                    <HistoryIcon />
                    <span>{t("onboarding.shortcutLead")}</span>
                    <strong>{shortcutText}</strong>
                </div>
            </section>

            <section className="onboarding-steps">
                {steps.map((step, index) => (
                    <article className={`onboarding-step ${copied[step.id] ? "done" : ""}`} key={step.id}>
                        <div className="step-index">{index + 1}</div>
                        <div className="step-icon">{step.icon}</div>
                        <div className="step-body">
                            <h2>{t(step.titleKey)}</h2>
                            <code>{t(step.sampleKey)}</code>
                        </div>
                        <button type="button" className="copy-sample-button" onClick={() => void copySample(step)}>
                            {copied[step.id] ? <CheckCircleIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
                            {copied[step.id] ? t("onboarding.copied") : t("onboarding.copy")}
                        </button>
                    </article>
                ))}
            </section>

            <section className="onboarding-finish">
                <div>
                    <h2>{t("onboarding.finishTitle", { shortcut: shortcutText })}</h2>
                </div>
                <button type="button" className="finish-button" onClick={() => void closeGuide()}>
                    {t("onboarding.close")}
                </button>
            </section>
        </main>
    );
}
