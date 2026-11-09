import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageTextView from "../../../src/clipboard/ImageTextView";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";
import { clipboardKeyDownAction } from "../../../src/clipboard/clipboardKeyboard";

const { invoke, emitTo } = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo }));

const t = (key: string) => key;
const complete = { status: "complete", text: "发票 invoice 2048", error: null };
const pending = { status: "pending", text: "", error: null };

function show(hash = "image", onClose = vi.fn()) {
    return render(<AppThemeProvider><MotionTestProvider><ImageTextView hash={hash} t={t} onClose={onClose} /></MotionTestProvider></AppThemeProvider>);
}

beforeEach(() => { invoke.mockReset(); emitTo.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Image text view in the shared preview window", () => {
    it("records full copied OCR text as new clipboard history", async () => {
        invoke.mockResolvedValue(complete);
        show();
        await screen.findByRole("textbox");
        await userEvent.click(screen.getByRole("button", { name: "ocr.copy" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("record_text_history", { content: complete.text }));
        await waitFor(() => expect(emitTo).toHaveBeenCalledWith("clipboard", "listen_new_clipboard", ""));
    });

    it("copies selected Unicode OCR text through the native path before recording history", async () => {
        const text = "前缀😀 发票\ninvoice 2048";
        let finishCopy!: () => void;
        const nativeCopy = new Promise<void>(resolve => { finishCopy = resolve; });
        invoke.mockImplementation((command: string) => command === "copy"
            ? nativeCopy : Promise.resolve({ ...complete, text }));
        show();
        const field = await screen.findByRole("textbox") as HTMLTextAreaElement;
        const start = text.indexOf("😀");
        const end = text.indexOf(" 2048");
        field.focus();
        field.setSelectionRange(start, end);
        const setData = vi.fn();
        expect(fireEvent.copy(field, { clipboardData: { setData } })).toBe(false);
        expect(setData).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith("copy", { item: text.slice(start, end), itemType: "Text", hash: null });
        expect(invoke).not.toHaveBeenCalledWith("record_text_history", expect.anything());
        expect(emitTo).not.toHaveBeenCalled();
        await act(async () => { finishCopy(); });
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("record_text_history", { content: text.slice(start, end) }));
        await waitFor(() => expect(emitTo).toHaveBeenCalledWith("clipboard", "listen_new_clipboard", ""));
        expect(field).toHaveFocus();
        expect([field.selectionStart, field.selectionEnd]).toEqual([start, end]);
    });

    it("does not record a selected copy when the native clipboard write fails", async () => {
        invoke.mockImplementation((command: string) => command === "copy"
            ? Promise.reject("clipboard busy") : Promise.resolve(complete));
        show();
        const field = await screen.findByRole("textbox") as HTMLTextAreaElement;
        field.setSelectionRange(0, 2);
        fireEvent.copy(field, { clipboardData: { setData: vi.fn() } });
        expect(await screen.findByRole("alert")).toHaveTextContent("ocr.copyFailed");
        expect(invoke).not.toHaveBeenCalledWith("record_text_history", expect.anything());
        expect(emitTo).not.toHaveBeenCalled();
        expect(field).toHaveValue(complete.text);
    });

    it("shows pending work immediately, then displays read-only text without copying automatically", async () => {
        invoke.mockResolvedValueOnce(pending).mockResolvedValueOnce(complete);
        show();
        expect(screen.getByText("ocr.recognizing")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "ocr.copy" })).toBeDisabled();
        const text = await screen.findByRole("textbox", { name: "ocr.title" });
        expect(text).toHaveValue(complete.text);
        expect(text).toHaveAttribute("readonly");
        expect(invoke.mock.calls.map(call => call[0])).toEqual(["recognize_image_text", "get_image_ocr"]);
    });

    it("offers only a secondary Copy all and primary Close, and keeps focus during copying", async () => {
        invoke.mockResolvedValue(complete);
        show();
        await screen.findByRole("textbox");
        expect(screen.getByLabelText("ocr.title", { selector: "textarea" })).toHaveValue(complete.text);
        expect(screen.queryByRole("heading")).not.toBeInTheDocument();
        expect(screen.getAllByRole("button")).toHaveLength(2);
        expect(screen.queryByRole("button", { name: "ocr.retry" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "common.close" })).toHaveClass("MuiButton-containedPrimary");
        await userEvent.click(screen.getByRole("button", { name: "ocr.copy" }));
        expect(invoke).toHaveBeenCalledWith("copy", { item: complete.text, itemType: "Text", hash: null });
        await waitFor(() => expect(screen.getByRole("button", { name: "ocr.copy" })).toBeEnabled());
        expect(screen.getByRole("button", { name: "common.close" })).toHaveFocus();
    });

    it.each(["language_unavailable", "unsupported", "resource_limit", "timeout", "failed"])("explains %s inside the view without extra actions", async error => {
        invoke.mockResolvedValue({ status: "failed", text: "", error });
        show();
        expect(await screen.findByRole("alert")).toHaveTextContent(`ocr.${error}`);
        expect(screen.getAllByRole("button")).toHaveLength(2);
        expect(screen.getByRole("button", { name: "ocr.copy" })).toBeDisabled();
    });

    it("handles empty recognition separately from an error", async () => {
        invoke.mockResolvedValue({ status: "empty", text: "", error: null });
        show();
        expect(await screen.findByText("ocr.empty")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("displays clipboard copy failure without losing the recognized text", async () => {
        invoke.mockImplementation((command: string) => command === "copy" ? Promise.reject("clipboard busy") : Promise.resolve(complete));
        show();
        await screen.findByRole("textbox");
        await userEvent.click(screen.getByRole("button", { name: "ocr.copy" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("ocr.copyFailed");
        expect(screen.getByRole("textbox")).toHaveValue(complete.text);
    });

    it("stops polling when closed and ignores late responses", async () => {
        vi.useFakeTimers();
        let resolve: (value: typeof complete) => void = () => {};
        invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
        const view = show();
        view.unmount();
        await act(async () => { resolve(complete); await vi.advanceTimersByTimeAsync(2000); });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("keeps Space, Enter, Tab and Escape inside the dialog", async () => {
        invoke.mockResolvedValue(complete);
        const onClose = vi.fn();
        show("image", onClose);
        await screen.findByRole("textbox");
        const close = screen.getByRole("button", { name: "common.close" });
        for (const key of [" ", "Enter", "Tab", "Escape"]) {
            const event = new KeyboardEvent("keydown", { key, bubbles: true });
            Object.defineProperty(event, "target", { value: close });
            expect(clipboardKeyDownAction(event, {
                contextMenuOpen: false, isMac: false, quickInputEnabled: true,
                searchHasText: false, searchComposing: false, searchInput: null,
                searchOpen: false, tabQuickSelectEnabled: true,
            })).toBeNull();
        }
        await userEvent.click(close);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not start reading OCR while the preview layer is inactive", () => {
        render(<MotionTestProvider><ImageTextView hash="image" t={t} onClose={vi.fn()} active={false} /></MotionTestProvider>);
        expect(invoke).not.toHaveBeenCalled();
    });
});
