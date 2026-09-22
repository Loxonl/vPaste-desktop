import { describe, expect, it, vi } from "vitest";
import { createClipboardShowGate } from "../../../src/clipboard/clipboardShowGate";

describe("clipboard show synchronization", () => {
    it("defers one Enter until capture and refresh finish", async () => {
        let finish!: () => void;
        const work = new Promise<void>(resolve => { finish = resolve; });
        const gate = createClipboardShowGate(vi.fn());
        const paste = vi.fn();
        gate.start(async () => work);
        expect(gate.defer(paste)).toBe(true);
        gate.defer(paste);
        expect(paste).not.toHaveBeenCalled();
        finish();
        await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
    });

    it("never falls back to old selection when synchronization fails", async () => {
        const failure = vi.fn();
        const gate = createClipboardShowGate(failure);
        const paste = vi.fn();
        gate.start(async () => { throw new Error("capture timeout"); });
        gate.defer(paste);
        await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
        expect(gate.defer(paste)).toBe(true);
        expect(paste).not.toHaveBeenCalled();
        gate.cancel();
        expect(gate.defer(paste)).toBe(false);
    });

    it("cancels deferred Enter and stale work after hiding or explicit selection", async () => {
        let finish!: () => void;
        const work = new Promise<void>(resolve => { finish = resolve; });
        const gate = createClipboardShowGate(vi.fn());
        let current!: () => boolean;
        gate.start(async isCurrent => { current = isCurrent; await work; });
        const paste = vi.fn();
        gate.defer(paste);
        gate.cancel();
        expect(current()).toBe(false);
        finish();
        await work;
        await Promise.resolve();
        expect(paste).not.toHaveBeenCalled();
    });

    it("does not replay an earlier window opening's Enter", async () => {
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const first = new Promise<void>(resolve => { finishFirst = resolve; });
        const second = new Promise<void>(resolve => { finishSecond = resolve; });
        const gate = createClipboardShowGate(vi.fn());
        const oldPaste = vi.fn();
        const newPaste = vi.fn();
        gate.start(async () => first);
        gate.defer(oldPaste);
        gate.start(async () => second);
        gate.defer(newPaste);
        finishFirst();
        await first;
        await Promise.resolve();
        expect(oldPaste).not.toHaveBeenCalled();
        expect(newPaste).not.toHaveBeenCalled();
        finishSecond();
        await vi.waitFor(() => expect(newPaste).toHaveBeenCalledOnce());
    });
});
