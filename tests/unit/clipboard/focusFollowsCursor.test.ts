import { describe, expect, it, vi } from "vitest";
import { createFocusFollowsCursor } from "../../../src/clipboard/focusFollowsCursor";

function harness(options: { focused?: boolean } = {}) {
    let focused = options.focused ?? false;
    let time = 1_000;
    let resolve: () => void = () => undefined;
    const request = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const follow = createFocusFollowsCursor({
        request,
        hasFocus: () => focused,
        now: () => time,
        onError: vi.fn(),
    });
    return {
        follow,
        request,
        setFocused: (value: boolean) => { focused = value; },
        advance: (ms: number) => { time += ms; },
        settle: async () => { resolve(); await Promise.resolve(); await Promise.resolve(); },
    };
}

describe("focus follows cursor", () => {
    it("asks the backend for focus only while this window is unfocused", () => {
        const focused = harness({ focused: true });
        focused.follow();
        expect(focused.request).not.toHaveBeenCalled();

        const unfocused = harness();
        unfocused.follow();
        expect(unfocused.request).toHaveBeenCalledTimes(1);
    });

    it("sends one request at a time and throttles pointer-move bursts", async () => {
        const h = harness();
        h.follow();
        h.follow();
        expect(h.request).toHaveBeenCalledTimes(1);
        await h.settle();
        h.follow();
        expect(h.request).toHaveBeenCalledTimes(1);
        h.advance(200);
        h.follow();
        expect(h.request).toHaveBeenCalledTimes(2);
    });

    it("stops asking once the window has focus", async () => {
        const h = harness();
        h.follow();
        await h.settle();
        h.setFocused(true);
        h.advance(1_000);
        h.follow();
        expect(h.request).toHaveBeenCalledTimes(1);
    });

    it("recovers after a failed request", async () => {
        const onError = vi.fn();
        let time = 0;
        const request = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(true);
        const follow = createFocusFollowsCursor({ request, hasFocus: () => false, now: () => time, onError });
        follow();
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledTimes(1);
        time += 200;
        follow();
        expect(request).toHaveBeenCalledTimes(2);
    });
});
