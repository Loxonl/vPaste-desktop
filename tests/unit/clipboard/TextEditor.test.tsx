import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TextEditor from "../../../src/clipboard/TextEditor";
import type { TextDocument } from "../../../src/clipboard/textEditorContent";

const { invoke, events } = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, () => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: () => void) => {
    events.set(name, callback);
    return () => events.delete(name);
}) }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("../../../src/theme", () => ({ loadAndApplyTheme: vi.fn(async () => undefined) }));

afterEach(cleanup);
beforeEach(() => { invoke.mockReset(); events.clear(); });

function open(document: Pick<TextDocument, "text" | "html">) {
    invoke.mockImplementation(async (command: string) => command === "get_text_editor_document"
        ? { id: 1, hash: "original", revision: "revision-1", ...document } : undefined);
    render(<TextEditor />);
}

describe("loading rich clipboard text", () => {
    it("edits complete HTML when text/plain contains the equivalent Markdown", async () => {
        open({
            text: "# Example\r\n\r\n- **Website**: [site](https://example.com/)\r\n- Second item",
            html: '<h1>Example</h1><ul><li><p><strong>Website</strong>: <a href="https://example.com/">site</a></p></li><li><p>Second item</p></li></ul>',
        });
        await waitFor(() => {
            const field = screen.getByRole("textbox", { name: "editor.content" });
            expect(field).toHaveAttribute("contenteditable", "true");
            expect(field.querySelector("strong")).toHaveTextContent("Website");
            expect(field.querySelector("a")).toHaveAttribute("href", "https://example.com/");
        });
        const field = screen.getByRole("textbox", { name: "editor.content" });
        fireEvent.input(field, { target: { innerHTML: field.innerHTML.replace("Example", "Updated") } });
        fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_clipboard_text", {
            update: expect.objectContaining({
                id: 1, revision: "revision-1", text: "Updated\nWebsite: site\nSecond item",
                html: expect.stringContaining("<strong>Website</strong>"),
                rtf: expect.stringContaining("HYPERLINK"),
            }),
        }));
    });

    it("still opens matching plain text and HTML with explicit line breaks", async () => {
        open({ text: "Title\r\n\r\nFirst item\r\nSecond item", html: "<b>Title</b><br><br>First item<br>Second item" });
        await waitFor(() => {
            const field = screen.getByRole("textbox", { name: "editor.content" });
            expect(field).toHaveAttribute("contenteditable", "true");
            expect(field.querySelector("b")).toHaveTextContent("Title");
        });
    });

    it("refuses real HTML body-text loss without saving", async () => {
        open({ text: "Kept Missing", html: "<p>Kept</p><svg><text>Missing</text></svg>" });
        expect(await screen.findByText("editor.richUnavailable")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "editor.save" })).toBeDisabled();
        expect(invoke).not.toHaveBeenCalledWith("save_clipboard_text", expect.anything());
    });
});

describe("text editor target lifecycle", () => {
    it("ignores an older load that finishes after the current target", async () => {
        open({ text: "Original text", html: "" });
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original text"));
        let finishOld!: (document: TextDocument) => void;
        invoke.mockReturnValueOnce(new Promise<TextDocument>(resolve => { finishOld = resolve; }));
        act(() => events.get("text-editor-open")?.());
        const current = { id: 2, hash: "current", revision: "revision-2", text: "Current target", html: "" };
        invoke.mockResolvedValueOnce(current);
        act(() => events.get("text-editor-open")?.());
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Current target"));
        await act(async () => finishOld({ ...current, id: 1, text: "Stale target" }));
        expect(screen.getByRole("textbox")).toHaveValue("Current target");
    });

    it("clears the old document when the next target is missing", async () => {
        open({ text: "Original text", html: "" });
        const field = await screen.findByRole("textbox", { name: "editor.content" });
        await waitFor(() => expect(field).toHaveValue("Original text"));
        invoke.mockResolvedValue(null);
        act(() => events.get("text-editor-open")?.());
        expect(await screen.findByText("editor.missing")).toBeInTheDocument();
        expect(field).toHaveValue("");
        expect(field).toBeDisabled();
        expect(screen.getByRole("button", { name: "editor.save" })).toBeDisabled();
    });

    it("does not allow editing the old document after a reload failure", async () => {
        open({ text: "Original text", html: "" });
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original text"));
        invoke.mockRejectedValue(new Error("editor.missing"));
        act(() => events.get("text-editor-open")?.());
        expect(await screen.findByText("editor.missing")).toBeInTheDocument();
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(screen.getByRole("textbox")).toHaveValue("");
    });

    it("retains the draft and allows a retry after a save failure", async () => {
        open({ text: "Original text", html: "" });
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original text"));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited text" } });
        invoke.mockImplementation(async (command: string) => {
            if (command === "save_clipboard_text") throw new Error("editor.changed");
        });
        fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
        expect(await screen.findByText("editor.changed")).toBeInTheDocument();
        expect(screen.getByRole("textbox")).toHaveValue("Edited text");
        expect(screen.getByRole("button", { name: "editor.save" })).toBeEnabled();
        expect(invoke).not.toHaveBeenCalledWith("hide_text_editor_window");
    });

    it("ignores reopen events and duplicate save clicks while saving", async () => {
        open({ text: "Original text", html: "" });
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original text"));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited text" } });
        let finishSave!: () => void;
        invoke.mockImplementation((command: string) => command === "save_clipboard_text"
            ? new Promise<void>(resolve => { finishSave = resolve; }) : Promise.resolve());
        fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
        fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
        act(() => events.get("text-editor-open")?.());
        expect(screen.getByRole("textbox")).toHaveValue("Edited text");
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(invoke.mock.calls.filter(([command]) => command === "save_clipboard_text")).toHaveLength(1);
        await act(async () => finishSave());
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("hide_text_editor_window"));
    });

    it("keeps changes when discard is canceled and closes only after confirmation", async () => {
        open({ text: "Original text", html: "" });
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original text"));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited text" } });
        act(() => events.get("text-editor-close-requested")?.());
        expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "editor.keepEditing" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        expect(screen.getByRole("textbox")).toHaveValue("Edited text");
        expect(invoke).not.toHaveBeenCalledWith("hide_text_editor_window");
        fireEvent.keyDown(window, { key: "Escape" });
        fireEvent.click(await screen.findByRole("button", { name: "editor.discard" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("hide_text_editor_window"));
    });
});
