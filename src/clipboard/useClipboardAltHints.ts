import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";

export function useClipboardAltHints(
    quickInputEnabledRef: RefObject<boolean>,
) {
    const [visible, setVisible] = useState(false);
    const timerRef = useRef<number | null>(null);

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const hide = useCallback(() => {
        clearTimer();
        setVisible(false);
    }, [clearTimer]);

    const pollAltKeyState = useCallback(() => {
        clearTimer();

        const poll = () => {
            timerRef.current = window.setTimeout(() => {
                void invoke<boolean>("is_alt_key_pressed")
                    .then(pressed => {
                        timerRef.current = null;
                        if (pressed && quickInputEnabledRef.current) {
                            setVisible(true);
                            poll();
                        } else {
                            setVisible(false);
                        }
                    })
                    .catch(invokeError => {
                        timerRef.current = null;
                        error(`Failed to read Alt key state: ${invokeError}`);
                    });
            }, 40);
        };

        poll();
    }, [clearTimer, quickInputEnabledRef]);

    const showWhilePressed = useCallback(() => {
        if (!quickInputEnabledRef.current) {
            hide();
            return;
        }
        setVisible(true);
        pollAltKeyState();
    }, [hide, pollAltKeyState, quickInputEnabledRef]);

    const syncFromNative = useCallback(() => {
        void invoke<boolean>("is_alt_key_pressed")
            .then(pressed => {
                if (pressed && quickInputEnabledRef.current) {
                    showWhilePressed();
                } else {
                    hide();
                }
            })
            .catch(invokeError => {
                error(`Failed to sync Alt key state: ${invokeError}`);
            });
    }, [hide, quickInputEnabledRef, showWhilePressed]);

    useEffect(() => clearTimer, [clearTimer]);

    return {
        clearTimer,
        hide,
        showWhilePressed,
        syncFromNative,
        visible,
    };
}
