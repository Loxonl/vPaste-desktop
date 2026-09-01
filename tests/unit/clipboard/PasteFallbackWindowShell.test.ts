import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
    join(process.cwd(), "src-tauri", "src", "main.rs"),
    "utf8",
);
const routerSource = readFileSync(
    join(process.cwd(), "src", "main.tsx"),
    "utf8",
);

describe("paste fallback native window", () => {
    it("builds one cross-platform singleton with a platform-specific static route", () => {
        const start = mainSource.indexOf(
            "fn build_paste_fallback_notice_window",
        );
        const end = mainSource.indexOf("fn build_clipboard_window", start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);

        const creation = mainSource.slice(start, end);
        expect(creation).toContain('"pasteFallbackNotice"');
        expect(creation).toContain('"paste-fallback-notice"');
        expect(creation).toContain('"paste-failure-notice"');
        expect(mainSource).toContain(
            "build_paste_fallback_notice_window(&handle)",
        );
    });

    it("routes the generic presentation without the permission action", () => {
        expect(routerSource).toContain(
            'path="/paste-fallback-notice" element={<PasteFallbackNotice />}',
        );
        expect(routerSource).toContain(
            'path="/paste-failure-notice" element={<PasteFallbackNotice showSettingsAction={false} />}',
        );
    });
});
