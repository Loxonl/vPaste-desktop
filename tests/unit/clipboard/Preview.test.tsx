import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { error as logError } from "@tauri-apps/plugin-log";
import { ItemType } from "../../../src/clipboard/Item";
import { PreviewBody } from "../../../src/clipboard/Preview";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
    emitTo: vi.fn(),
    listen: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn() }));

const t = (key: string) => key;

describe("PreviewBody transparency", () => {
    it("labels truncated text without modifying the preview prefix", () => {
        const { container } = render(<PreviewBody payload={{ item_type: ItemType.TextFile, content: "history-path", text_content: "bounded prefix", text_truncated: true }} t={t} />);
        expect(container.querySelector("pre")?.textContent).toBe("bounded prefix");
        expect(container.textContent).toContain("preview.textTruncated");
    });

    it("uses budget-checked media for GIF previews and can display the static first frame", async () => {
        tauri.invoke.mockImplementation(async (command: string) => command === "resolve_history_media"
            ? { assetPath: "first-frame.png", metadata: { isGif: true, animationLimited: true } }
            : command === "history_image_metadata" ? { isGif: true, animationLimited: true } : "original.gif");
        const { container } = render(<PreviewBody payload={{ item_type: ItemType.Image, content: "original.gif" }} t={t} />);
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("asset://first-frame.png"));
        expect(tauri.invoke).toHaveBeenCalledWith("resolve_history_media", expect.objectContaining({ path: "original.gif", intent: "preview" }));
    });

    it("does not bypass a rejected media resource with the original image path", async () => {
        tauri.invoke.mockRejectedValue(new Error("resource exceeds budget"));
        const ready = vi.fn();
        const { container } = render(<PreviewBody payload={{ item_type: ItemType.Image, content: "large.png" }} t={t} onReady={ready} />);
        await waitFor(() => expect(container).toHaveTextContent("preview.unsupported"));
        expect(container.querySelector("img")).toBeNull();
        expect(tauri.invoke.mock.calls).toEqual([["resolve_history_media", { path: "large.png", intent: "preview" }]]);
        expect(ready).toHaveBeenCalledOnce();
    });

    it("labels a bounded external text file preview", async () => {
        tauri.invoke.mockImplementation(async (command: string) => command === "file_preview_info"
            ? { kind: "text-preview", display_path: "large.txt", paths: ["large.txt"] }
            : { text: "file prefix", truncated: true });
        const { container } = render(<PreviewBody payload={{ item_type: ItemType.File, content: '["large.txt"]' }} t={t} />);
        await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe("file prefix"));
        expect(container).toHaveTextContent("preview.textTruncated");
    });
    it("shows the existing link loading state while the webpage request is still pending", async () => {
        let complete!: (document: { url: string; html: string }) => void;
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "fetch_link_preview_document") return new Promise(resolve => { complete = resolve; });
            return undefined;
        });
        const { container } = render(<PreviewBody payload={{ item_type: ItemType.Link, content: "https://example.com/slow" }} t={t} />);
        expect(container.textContent).toContain("https://example.com/slow");
        expect(container.textContent).toContain("preview.generating");
        expect(container.querySelector("iframe")).toBeNull();
        complete({ url: "https://example.com/slow", html: "<html><body>Loaded article</body></html>" });
        await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Loaded article"));
    });

    it("sanitizes clipboard rich HTML in the separate preview window", () => {
        const { container } = render(
            <PreviewBody
                payload={{
                    item_type: ItemType.Text,
                    content: "fallback",
                    rich_html: '<svg><animate attributeName="href" values="javascript:alert(1)" /></svg><img src="data:text/html,attack"><p>Safe text</p>',
                }}
                t={t}
            />,
        );

        expect(container.querySelector("svg, animate, img")).toBeNull();
        expect(container).toHaveTextContent("Safe text");
    });

    it("keeps the full preview's wider rich-text layout", () => {
        const { container } = render(
            <PreviewBody
                payload={{ item_type: ItemType.Text, content: "fallback", rich_html: '<p style="width: 500px">Wide text</p>' }}
                t={t}
            />,
        );

        expect(container.querySelector("p")?.style.width).toBe("500px");
    });

    it("prevents link preview HTML from requesting local or remote subresources", async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "fetch_link_preview_document") {
                return {
                    url: "https://example.com/page",
                    html: '<html><head><style>body { background: url(http://127.0.0.1/run) }</style></head><body><img src="http://127.0.0.1/run"><p>Article</p></body></html>',
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const { container } = render(
            <PreviewBody payload={{ item_type: ItemType.Link, content: "https://example.com/page" }} t={t} />,
        );

        await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("default-src 'none'"));
        const frame = container.querySelector("iframe")!;
        expect(frame.getAttribute("srcdoc")).toContain("img-src data:");
        expect(frame.getAttribute("sandbox")).toBe("");
    });

    it.each([
        ["link_preview_proxy_unavailable", "preview.linkProxyUnavailable"],
        ["link_preview_fake_ip", "preview.linkFakeIp"],
        ["link_preview_timeout", "preview.linkTimeout"],
        ["link_preview_blocked", "preview.linkBlocked"],
        ["link_preview_network", "preview.linkNetworkError"],
        ["link_preview_not_html", "preview.linkNotHtml"],
        ["link_preview_redirect_limit", "preview.linkRedirectLimit"],
        ["link_preview_http_status", "preview.linkHttpError"],
        ["error sending request for url (https://example.com/?token=private-test-value)", "preview.linkNetworkError"],
    ])("localizes link preview failure %s without exposing the raw error", async (failure, message) => {
        tauri.invoke.mockRejectedValueOnce(failure);
        const { container, getByRole } = render(
            <PreviewBody payload={{ item_type: ItemType.Link, content: "https://example.com/page" }} t={t} />,
        );

        await waitFor(() => expect(container).toHaveTextContent(message));
        expect(container).not.toHaveTextContent("private-test-value");
        expect(container).not.toHaveTextContent("error sending request");
        expect(vi.mocked(logError).mock.calls.flat().join(" ")).not.toContain("private-test-value");
        expect(getByRole("button", { name: "preview.openOriginalLink" })).toBeEnabled();
    });

    it("opens the original link from the failed preview", async () => {
        tauri.invoke.mockRejectedValueOnce("link_preview_proxy_unavailable");
        const { getByRole } = render(
            <PreviewBody payload={{ item_type: ItemType.Link, content: "https://example.com/page" }} t={t} />,
        );
        await waitFor(() => expect(getByRole("button", { name: "preview.openOriginalLink" })).toBeEnabled());
        tauri.invoke.mockResolvedValueOnce(undefined);
        fireEvent.click(getByRole("button", { name: "preview.openOriginalLink" }));
        expect(tauri.invoke).toHaveBeenLastCalledWith("open_url_in_browser", { url: "https://example.com/page" });
    });

    it("renders the complete long text delivered directly by Rust to the preview window", () => {
        const body = "line of saved text\n".repeat(1200) + "FINAL LINE";
        const path = "C:\\history\\data\\long-text";
        const { container } = render(<PreviewBody payload={{ item_type: ItemType.TextFile, content: path, text_content: body }} t={t} />);
        expect(container.querySelector("pre")?.textContent).toBe(body);
        expect(container).not.toHaveTextContent(path);
        expect(tauri.invoke).not.toHaveBeenCalledWith("plain_text_content", expect.anything());
    });

    beforeEach(() => {
        cleanup();
        vi.mocked(logError).mockClear();
        tauri.invoke.mockReset();
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "history_image_metadata") {
                return { width: 320, height: 180, isGif: false };
            }
            if (command === "resolve_history_media") {
                return { assetPath: "C:\\cache\\transparent.png", metadata: { width: 320, height: 180, isGif: false } };
            }
            if (command === "file_preview_info") {
                return {
                    kind: "single-preview",
                    paths: ["C:\\images\\transparent.png"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\images\\transparent.png",
                    secondary_text: "",
                    extension: "PNG",
                    preview_path: "C:\\images\\transparent.png",
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
    });

    it("shows the checkerboard behind an image preview", () => {
        const { container } = render(
            <PreviewBody
                payload={{ item_type: ItemType.Image, content: "C:\\history\\transparent.bin" }}
                t={t}
            />,
        );

        expect(container.querySelector("img")?.className).toContain("transparency-grid");
    });

    it("shows the checkerboard behind a single-image file preview", async () => {
        const { container } = render(
            <PreviewBody
                payload={{
                    item_type: ItemType.File,
                    content: JSON.stringify(["C:\\images\\transparent.png"]),
                }}
                t={t}
            />,
        );

        await waitFor(() => {
            expect(container.querySelector("img")?.className).toContain("transparency-grid");
        });
    });

    it("uses the same mapped file icon and extension label as the clipboard card", async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "file_preview_info") {
                return {
                    kind: "single-icon",
                    paths: ["C:\\Documents\\contract.doc"],
                    exists: true,
                    missing_paths: [],
                    display_path: "C:\\Documents\\contract.doc",
                    secondary_text: "",
                    extension: "DOC",
                    preview_path: "",
                    contains_directories: false,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        const { container } = render(
            <PreviewBody
                payload={{
                    item_type: ItemType.File,
                    content: JSON.stringify(["C:\\Documents\\contract.doc"]),
                }}
                t={t}
            />,
        );

        // File-only icons now include their cold module transform in this test.
        await waitFor(() => {
            expect(container.querySelector("[data-file-presentation='known']")).toHaveTextContent("DOC");
        }, { timeout: 5_000 });
        expect(container.querySelectorAll("[data-file-presentation='known'] img")).toHaveLength(1);
        expect(container.querySelector("[class*='preview-file-symbol']")).toBeNull();
    });
});
