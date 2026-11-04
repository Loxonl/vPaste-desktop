import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TextEditor from "../../../src/clipboard/TextEditor";
import type { TextDocument } from "../../../src/clipboard/textEditorContent";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../../../src/lang", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("../../../src/theme", () => ({ loadAndApplyTheme: vi.fn(async () => undefined) }));

afterEach(cleanup);
beforeEach(() => invoke.mockReset());

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
