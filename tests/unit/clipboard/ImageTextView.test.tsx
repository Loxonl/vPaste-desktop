import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageTextView from "../../../src/clipboard/ImageTextView";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";
import { clipboardKeyDownAction } from "../../../src/clipboard/clipboardKeyboard";

const { invoke, emitTo } = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo }));

const t = (key: string) => key;
const complete = { status: "complete", text: "发票 invoice 2048", error: null };
const pending = { status: "pending", text: "", error: null };

function show(hash = "image", onClose = vi.fn(), imagePath = "") {
    return render(<AppThemeProvider><MotionTestProvider><ImageTextView hash={hash} imagePath={imagePath} t={t} onClose={onClose} /></MotionTestProvider></AppThemeProvider>);
}

beforeEach(() => { invoke.mockReset(); emitTo.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Image text view in the shared preview window", () => {
    it("loads the comparison image through the existing bounded preview pipeline", async () => {
        invoke.mockImplementation((command: string) => Promise.resolve(command === "resolve_history_media"
            ? { assetPath: "bounded.png" } : complete));
        show("image", vi.fn(), "original.png");
        const image = await screen.findByRole("img", { name: "type.image" });
        await waitFor(() => expect(image).toHaveAttribute("src", "asset://bounded.png"));
        expect(invoke).toHaveBeenCalledWith("resolve_history_media", { path: "original.png", intent: "preview" });
        expect(screen.getByRole("textbox")).toHaveValue(complete.text);
        expect(invoke.mock.calls.every(([command]) => ["recognize_image_text", "resolve_history_media"].includes(command))).toBe(true);
    });

    it("copies the latest edited draft without saving OCR data and keeps an empty draft editable", async () => {
        invoke.mockResolvedValue(complete);
        show();
        const field = await screen.findByRole("textbox");
        expect(field).not.toHaveAttribute("readonly");
        fireEvent.change(field, { target: { value: "" } });
        expect(field).toHaveValue("");
        expect(screen.getByRole("button", { name: "ocr.copy" })).toBeDisabled();
        fireEvent.change(field, { target: { value: "校正后的文字 😀\nnew line" } });
        await userEvent.click(screen.getByRole("button", { name: "ocr.copy" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("record_text_history", { content: "校正后的文字 😀\nnew line" }));
        expect(invoke).toHaveBeenCalledWith("copy", { item: "校正后的文字 😀\nnew line", itemType: "Text", hash: null });
        expect(invoke.mock.calls.every(([command]) => ["recognize_image_text", "copy", "record_text_history"].includes(command))).toBe(true);
    });

    it("does not let recognition completion replace a draft already edited by the user", async () => {
        invoke.mockResolvedValueOnce({ ...pending, text: "cached words" }).mockResolvedValueOnce(complete);
        show();
        const field = await screen.findByRole("textbox");
        fireEvent.change(field, { target: { value: "my correction" } });
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_image_ocr", { hash: "image" }));
        await waitFor(() => expect(screen.queryByText("ocr.recognizing")).not.toBeInTheDocument());
        expect(field).toHaveValue("my correction");
    });

    it("discards unsaved edits when a new reading session opens", async () => {
        invoke.mockResolvedValue(complete);
        const view = show();
        const field = await screen.findByRole("textbox");
        fireEvent.change(field, { target: { value: "local draft" } });
        invoke.mockResolvedValue({ ...complete, text: "second image text" });
        view.rerender(<AppThemeProvider><MotionTestProvider><ImageTextView hash="second" imagePath="" t={t} onClose={vi.fn()} /></MotionTestProvider></AppThemeProvider>);
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("second image text"));
    });

    it("records the click-time snapshot even when the user edits again before copying completes", async () => {
        let finishCopy!: () => void;
        const copy = new Promise<void>(resolve => { finishCopy = resolve; });
        invoke.mockImplementation((command: string) => command === "copy" ? copy : Promise.resolve(complete));
        show();
        const field = await screen.findByRole("textbox");
        fireEvent.change(field, { target: { value: "copy this version" } });
        await userEvent.click(screen.getByRole("button", { name: "ocr.copy" }));
        fireEvent.change(field, { target: { value: "later edit" } });
        await act(async () => { finishCopy(); });
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("record_text_history", { content: "copy this version" }));
        expect(field).toHaveValue("later edit");
    });

    it("keeps text editable and copyable when the comparison image is unavailable", async () => {
        invoke.mockImplementation((command: string) => command === "resolve_history_media"
            ? Promise.reject("missing image") : Promise.resolve(complete));
        show("image", vi.fn(), "deleted.png");
        await screen.findByText("ocr.imageMissing");
        const field = await screen.findByRole("textbox");
        fireEvent.change(field, { target: { value: "corrected text" } });
        await userEvent.click(screen.getByRole("button", { name: "ocr.copy" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("record_text_history", { content: "corrected text" }));
    });

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

    it("shows pending work immediately, then displays editable text without copying automatically", async () => {
        invoke.mockResolvedValueOnce(pending).mockResolvedValueOnce(complete);
        show();
        expect(screen.getByText("ocr.recognizing")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "ocr.copy" })).toBeDisabled();
        const text = await screen.findByRole("textbox", { name: "ocr.title" });
        await waitFor(() => expect(text).toHaveValue(complete.text));
        expect(text).not.toHaveAttribute("readonly");
        expect(invoke.mock.calls.map(call => call[0])).toEqual(["recognize_image_text", "get_image_ocr"]);
    });

    it("offers only two neutral icon/text actions and keeps focus during copying", async () => {
        invoke.mockResolvedValue(complete);
        show();
        await screen.findByRole("textbox");
        expect(screen.getByLabelText("ocr.title", { selector: "textarea" })).toHaveValue(complete.text);
        expect(screen.queryByRole("heading")).not.toBeInTheDocument();
        expect(screen.getAllByRole("button")).toHaveLength(2);
        expect(screen.queryByRole("button", { name: "ocr.retry" })).not.toBeInTheDocument();
        for (const button of screen.getAllByRole("button")) {
            expect(button).toHaveClass("MuiButton-textInherit");
            expect(button.querySelector("svg")).not.toBeNull();
        }
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
        render(<MotionTestProvider><ImageTextView hash="image" imagePath="" t={t} onClose={vi.fn()} active={false} /></MotionTestProvider>);
        expect(invoke).not.toHaveBeenCalled();
    });
});
