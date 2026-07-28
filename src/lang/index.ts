import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { useEffect, useMemo, useState } from "react";
import enUS from "./locales/en-US";
import zhCN from "./locales/zh-CN";
import type { LanguageCode, LanguagePack } from "./types";

export const LANGUAGE_PACKS: LanguagePack[] = [zhCN, enUS];
export const FALLBACK_LANGUAGE = "English";

function detectSystemLanguage(): LanguageCode {
    const locale = typeof navigator === "undefined"
        ? ""
        : (navigator.languages?.[0] || navigator.language || "");
    return locale.toLowerCase().startsWith("zh") ? "Chinese" : FALLBACK_LANGUAGE;
}

export const DEFAULT_LANGUAGE = detectSystemLanguage();

export interface LanguageBridge {
    invoke: typeof invoke;
    listen: typeof listen;
}

const tauriLanguageBridge: LanguageBridge = { invoke, listen };

type ExternalLanguagePack = {
    code: string;
    name: string;
    native_name?: string;
    nativeName?: string;
    translations: Record<string, string>;
};

function normalizeExternalPack(pack: ExternalLanguagePack): LanguagePack {
    return {
        code: pack.code,
        name: pack.name || pack.code,
        nativeName: pack.nativeName || pack.native_name || pack.name || pack.code,
        translations: pack.translations || {},
    };
}

function packMap(packs: LanguagePack[]) {
    return new Map(packs.map(pack => [pack.code, pack]));
}

export function getLanguagePack(code?: LanguageCode | null, packs: LanguagePack[] = LANGUAGE_PACKS): LanguagePack {
    const map = packMap(packs);
    return map.get(code || "") || map.get(DEFAULT_LANGUAGE) || map.get(FALLBACK_LANGUAGE) || packs[0] || enUS;
}

export function languageOptions(packs: LanguagePack[] = LANGUAGE_PACKS) {
    return packs.map(pack => ({
        value: pack.code,
        label: pack.nativeName,
    }));
}

export function translateWithPack(
    pack: LanguagePack,
    key: string,
    params: Record<string, string | number> = {},
): string {
    const fallback = getLanguagePack(FALLBACK_LANGUAGE);
    const template = pack.translations[key] || fallback.translations[key] || key;
    return Object.entries(params).reduce(
        (text, [param, value]) => text.split(`{${param}}`).join(String(value)),
        template,
    );
}

export function useLanguage(bridge: LanguageBridge = tauriLanguageBridge) {
    const [configuredLanguageCode, setLanguageCode] = useState(DEFAULT_LANGUAGE);
    const [previewLanguageCode, setPreviewLanguageCode] = useState<LanguageCode | null>(null);
    const [packs, setPacks] = useState<LanguagePack[]>(LANGUAGE_PACKS);

    useEffect(() => {
        const unlistenLanguageChanged = bridge.listen<string>("language-changed", event => {
            setLanguageCode(event.payload || DEFAULT_LANGUAGE);
        });

        bridge.invoke<ExternalLanguagePack[]>("list_language_packs")
            .then(externalPacks => {
                const merged = new Map(LANGUAGE_PACKS.map(pack => [pack.code, pack]));
                externalPacks.map(normalizeExternalPack).forEach(pack => {
                    const builtIn = merged.get(pack.code);
                    merged.set(pack.code, {
                        ...builtIn,
                        ...pack,
                        translations: {
                            ...(builtIn?.translations || {}),
                            ...pack.translations,
                        },
                    });
                });
                setPacks(Array.from(merged.values()));
            })
            .catch(e => error(`Failed to load language packs: ${e}`));

        bridge.invoke<string>("get_config")
            .then(config => {
                const parsed = JSON.parse(config);
                setLanguageCode(parsed.multilingual || DEFAULT_LANGUAGE);
            })
            .catch(e => error(`Failed to load language config: ${e}`));

        return () => {
            unlistenLanguageChanged.then(fn => fn()).catch(e => error(`Failed to unlisten language change: ${e}`));
        };
    }, [bridge]);

    const languageCode = previewLanguageCode || configuredLanguageCode;
    const pack = useMemo(() => getLanguagePack(languageCode, packs), [languageCode, packs]);
    const t = useMemo(
        () => (key: string, params?: Record<string, string | number>) => translateWithPack(pack, key, params),
        [pack],
    );

    return {
        languageCode,
        setLanguageCode,
        setPreviewLanguageCode,
        pack,
        t,
        languages: languageOptions(packs),
    };
}

export function formatRelativeTime(timestamp: number, t: (key: string, params?: Record<string, string | number>) => string): string {
    const now = new Date();
    const gmtTimestamp = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
        now.getUTCMilliseconds(),
    );

    const diff = gmtTimestamp - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (seconds < 10) return t("time.justNow");
    if (seconds < 60) return t("time.secondsAgo", { count: seconds });
    if (minutes < 60) return t("time.minutesAgo", { count: minutes });
    if (hours < 24) return t("time.hoursAgo", { count: hours });
    if (days < 30) return t("time.daysAgo", { count: days });
    if (months < 12) return t("time.monthsAgo", { count: months });
    return t("time.yearsAgo", { count: years });
}
