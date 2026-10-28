import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const directory = join(process.cwd(), "src-tauri", "capabilities");
const capabilities = readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        windows: string[];
        permissions: string[];
    });

describe("lazy auxiliary window IPC", () => {
    it.each(["config", "textEditor", "pasteFallbackNotice", "onboardingPermission", "trayMenu", "emojiPicker", "tabEditor"])(
        "%s can subscribe to opening events and report initialization failures", label => {
            const permissions = capabilities.filter(capability => capability.windows.includes(label))
                .flatMap(capability => capability.permissions);
            expect(permissions).toContain("core:event:default");
            expect(permissions).toContain("log:default");
        },
    );
});
