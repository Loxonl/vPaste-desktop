import { describe, expect, it, vi } from "vitest";
import { notifyAuxiliaryWindowReady } from "../../src/auxiliaryWindowReady";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe("first-open auxiliary window readiness", () => {
    it("does not let the backend send the opening event before every listener is registered", async () => {
        const open = deferred();
        const close = deferred();
        const notify = vi.fn(async () => undefined);
        notifyAuxiliaryWindowReady([open.promise, close.promise], notify);

        open.resolve();
        await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();

        close.resolve();
        await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    });

    it("does not publish readiness from a disposed React effect", async () => {
        const listener = deferred();
        const notify = vi.fn(async () => undefined);
        const dispose = notifyAuxiliaryWindowReady([listener.promise], notify);
        dispose();
        listener.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();
    });

    it("does not publish readiness when listener registration fails", async () => {
        const notify = vi.fn(async () => undefined);
        notifyAuxiliaryWindowReady([Promise.reject(new Error("registration failed"))], notify);
        await Promise.resolve();
        await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();
    });
});
