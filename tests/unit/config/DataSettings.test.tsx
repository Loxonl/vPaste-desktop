import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataSettings from "../../../src/config/sections/DataSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";

afterEach(cleanup);

function createBridge(): SettingsBridge {
    return {
        invoke: vi.fn(async (command: string) => {
            if (command === "list_recent_app_source_options") return [];
            if (command === "estimate_storage_cleanup") return { bytes: 0, items: 0 };
            if (command === "get_history_format_status") return { migration_required: false };
            return null;
        }) as SettingsBridge["invoke"],
        listen: vi.fn(async () => () => undefined) as unknown as SettingsBridge["listen"],
        open: vi.fn(async () => null),
        save: vi.fn(async () => null),
        convertFileSrc: vi.fn(path => path),
        startWindowDragging: vi.fn(async () => undefined),
        hideWindow: vi.fn(async () => undefined),
    };
}

describe("Data settings actions", () => {
    it("keeps remove, import, and export wired to their existing handlers", async () => {
        const bridge = createBridge();
        const onSave = vi.fn(async () => null);
        const config = { ...DEFAULT_CONFIG, ignored_app_sources: ["Code.exe"] };
        render(
            <AppThemeProvider>
                <DataSettings
                    bridge={bridge}
                    config={config}
                    storagePaths={null}
                    onSave={onSave}
                    onBlockingOperationChange={vi.fn()}
                    t={key => key}
                />
            </AppThemeProvider>,
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "common.remove" }));
        expect(onSave).toHaveBeenCalledWith({ ...config, ignored_app_sources: [] });

        await user.click(screen.getByRole("button", { name: /settings\.importHistory/ }));
        await user.click(screen.getByRole("button", { name: /settings\.exportHistory/ }));

        await waitFor(() => expect(bridge.open).toHaveBeenCalledOnce());
        expect(bridge.save).toHaveBeenCalledOnce();
    });
});
