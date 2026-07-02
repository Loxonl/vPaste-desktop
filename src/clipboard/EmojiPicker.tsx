import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { error } from "@tauri-apps/plugin-log";
import { useLanguage } from "../lang";
import { loadAndApplyTheme } from "../theme";
import { NAME_PREFIX_EMOJIS } from "./nameEmoji";
import "./EmojiPicker.css";

type EmojiPickerPayload = {
    selectedEmoji?: string;
    languageCode?: string;
};

const PENDING_EMOJI_PICKER_PAYLOAD_KEY = "vpaste.pendingEmojiPickerPayload";
const PENDING_EMOJI_SELECTION_KEY = "vpaste.pendingEmojiSelection";

export default function EmojiPicker() {
    const { t, setLanguageCode } = useLanguage();
    const [selectedEmoji, setSelectedEmoji] = useState("");

    const closeWindow = () => {
        void invoke("hide_emoji_picker_window").catch(e => error(`Failed to hide emoji picker: ${e}`));
    };

    const openFromPayload = (payload: EmojiPickerPayload) => {
        void loadAndApplyTheme();
        if (payload.languageCode) {
            setLanguageCode(payload.languageCode);
        }
        setSelectedEmoji(payload.selectedEmoji || "");
        localStorage.removeItem(PENDING_EMOJI_PICKER_PAYLOAD_KEY);
    };

    const openFromPendingPayload = () => {
        const pendingPayload = localStorage.getItem(PENDING_EMOJI_PICKER_PAYLOAD_KEY);
        if (!pendingPayload) return;
        try {
            openFromPayload(JSON.parse(pendingPayload) as EmojiPickerPayload);
        } catch (e) {
            error(`Failed to parse pending emoji picker payload: ${e}`);
        }
    };

    useEffect(() => {
        openFromPendingPayload();
        const unlistenOpen = listen<string>("emoji-picker-open", event => {
            try {
                openFromPayload(JSON.parse(event.payload) as EmojiPickerPayload);
            } catch (e) {
                error(`Failed to parse emoji picker payload: ${e}`);
            }
        });
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeWindow();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            unlistenOpen.then(f => f()).catch(e => error(`Failed to unlisten emoji picker: ${e}`));
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    const chooseEmoji = (emoji: string) => {
        localStorage.setItem(PENDING_EMOJI_SELECTION_KEY, emoji);
        void emit("emoji-prefix-selected", emoji)
            .catch(e => error(`Failed to broadcast selected emoji: ${e}`));
        void emitTo("tabEditor", "emoji-prefix-selected", emoji)
            .catch(e => error(`Failed to send selected emoji: ${e}`))
            .finally(closeWindow);
    };

    return (
        <div className="emoji-picker-window" role="menu" onContextMenu={event => event.preventDefault()}>
            <button
                type="button"
                role="menuitem"
                className={`emoji-clear-option ${!selectedEmoji ? "selected" : ""}`}
                onMouseDown={event => {
                    event.preventDefault();
                    chooseEmoji("");
                }}
            >
                {t("tabs.emojiNone")}
            </button>
            <div className="emoji-grid">
                {NAME_PREFIX_EMOJIS.map(emoji => (
                    <button
                        key={emoji}
                        type="button"
                        role="menuitem"
                        className={`emoji-option ${selectedEmoji === emoji ? "selected" : ""}`}
                        title={emoji}
                        aria-label={`${t("tabs.emojiPrefix")} ${emoji}`}
                        onMouseDown={event => {
                            event.preventDefault();
                            chooseEmoji(emoji);
                        }}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
        </div>
    );
}
