import { Item, ItemType } from "./Item";

type HoverPreviewOptions = {
    allowed: () => boolean;
    requestSequence: { current: number };
    open: (item: Item, sequence: number, request: number, isCurrent: () => boolean) => Promise<void>;
    dismiss: (request: number) => Promise<unknown>;
    onError: (error: unknown) => void;
};

export function createClipboardHoverPreview(options: HoverPreviewOptions) {
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let hash = "";
    let insidePreview = false;
    let sequence = -1;
    let request = Date.now() * 1000;
    const nextRequest = () => request = Math.max(request + 1, Date.now() * 1000);

    const clearTimers = () => {
        clearTimeout(showTimer);
        clearTimeout(closeTimer);
        showTimer = closeTimer = undefined;
    };
    const cancel = () => {
        if (sequence === -1 && !showTimer && !closeTimer && !hash) return;
        clearTimers();
        hash = "";
        insidePreview = false;
        sequence = -1;
        void options.dismiss(nextRequest()).catch(options.onError);
    };
    const enter = (item: Item) => {
        if (!options.allowed() || ![ItemType.Text, ItemType.TextFile, ItemType.Image, ItemType.Link].includes(item.getType())) {
            if (hash) cancel();
            return;
        }
        clearTimeout(closeTimer);
        if (hash === item.getHash()) return;
        clearTimeout(showTimer);
        hash = item.getHash();
        insidePreview = false;
        sequence = options.requestSequence.current;
        const currentSequence = sequence;
        const currentRequest = nextRequest();
        showTimer = setTimeout(() => {
            showTimer = undefined;
            if (currentSequence !== options.requestSequence.current || !options.allowed()) return;
            void options.open(item, currentSequence, currentRequest,
                () => request === currentRequest && sequence === currentSequence && options.allowed()).catch(options.onError);
        }, 500);
    };
    const leave = () => {
        if (sequence === -1 && !showTimer && !closeTimer && !hash) return;
        if (showTimer !== undefined) {
            clearTimeout(showTimer);
            showTimer = undefined;
        }
        hash = "";
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => { if (!insidePreview) cancel(); }, 250);
    };
    const previewHover = (inside: boolean) => {
        if (sequence === -1) return;
        insidePreview = inside;
        if (inside) clearTimeout(closeTimer);
        else leave();
    };
    return { enter, leave, cancel, previewHover };
}
