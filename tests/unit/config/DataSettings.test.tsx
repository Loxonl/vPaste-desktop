import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataSettings from "../../../src/config/sections/DataSettings";
import enUS from "../../../src/lang/locales/en-US";
import zhCN from "../../../src/lang/locales/zh-CN";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

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
    it("explains protected records and the estimated count in both cleanup translations", () => {
        const english = enUS.translations["settings.cleanup.confirm"];
        const chinese = zhCN.translations["settings.cleanup.confirm"];
        expect(english).toContain("{items}");
        expect(english).toMatch(/favorite/i);
        expect(english).toMatch(/tag/i);
        expect(chinese).toContain("{items}");
        expect(chinese).toContain("收藏");
        expect(chinese).toContain("标签");
        expect(enUS.translations["settings.cleanupSummary"]).toMatch(/cleanup/i);
        expect(zhCN.translations["settings.cleanupSummary"]).toContain("可清理");
    });

    it("keeps managed privacy apps, import, and export wired to their existing handlers", async () => {
        const bridge = createBridge();
        const onSave = vi.fn(async () => null);
        const config = { ...DEFAULT_CONFIG, ignored_app_sources: ["Code.exe"] };
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={config}
                        storagePaths={null}
                        onSave={onSave}
                        onBlockingOperationChange={vi.fn()}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "settings.privacyApps.manage" }));
        await user.click(await screen.findByRole("checkbox", { name: "Code" }));
        expect(onSave).toHaveBeenCalledWith({ ...config, ignored_app_sources: [] });

        await user.click(screen.getAllByRole("button", { name: "common.close" })[0]);
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        await user.click(screen.getByRole("button", { name: /settings\.importHistory/ }));
        await user.click(screen.getByRole("button", { name: /settings\.exportHistory/ }));

        await waitFor(() => expect(bridge.open).toHaveBeenCalledOnce());
        expect(bridge.save).toHaveBeenCalledOnce();
    });

    it("restores the protected app switch when saving fails", async () => {
        const bridge = createBridge();
        const onSave = vi.fn(async () => {
            throw new Error("save failed");
        });
        const config = { ...DEFAULT_CONFIG, ignored_app_sources: ["Code.exe"] };
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={config}
                        storagePaths={null}
                        onSave={onSave}
                        onBlockingOperationChange={vi.fn()}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "settings.privacyApps.manage" }));
        const protectedAppSwitch = await screen.findByRole("checkbox", { name: "Code" });
        expect(protectedAppSwitch).toBeChecked();

        await user.click(protectedAppSwitch);

        await waitFor(() => expect(screen.getByRole("checkbox", { name: "Code" })).toBeChecked());
        expect(onSave).toHaveBeenCalledWith({ ...config, ignored_app_sources: [] });
    });

    it("keeps real application icons square and contained", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.invoke).mockImplementation(async (command: string) => {
            if (command === "list_recent_app_source_options") {
                return [{ source: "Code.exe", icon_path: "C:\\icons\\code.png" }];
            }
            if (command === "estimate_storage_cleanup") return { bytes: 0, items: 0 };
            if (command === "get_history_format_status") return { migration_required: false };
            return null;
        });
        const config = { ...DEFAULT_CONFIG, ignored_app_sources: ["Code.exe"] };
        const { container } = render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={config}
                        storagePaths={null}
                        onSave={vi.fn(async () => null)}
                        onBlockingOperationChange={vi.fn()}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        await waitFor(() => expect(bridge.convertFileSrc).toHaveBeenCalledWith("C:\\icons\\code.png"));
        const appIcon = container.querySelector(".MuiAvatar-square img");
        expect(appIcon).not.toBeNull();
        expect(appIcon?.parentElement?.className).toContain("app-icon");
    });

    it("uses standard storage and migration actions and confirms cleanup", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.invoke).mockImplementation(async (command: string) => {
            if (command === "list_recent_app_source_options") return [];
            if (command === "estimate_storage_cleanup") return { bytes: 2048, items: 4 };
            if (command === "get_history_format_status") return { migration_required: false };
            if (command === "cleanup_storage_history") return { bytes: 2048, items: 4 };
            return null;
        });
        vi.mocked(bridge.open).mockResolvedValueOnce(null);

        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={DEFAULT_CONFIG}
                        storagePaths={{
                            app_data_dir: "C:\\Users\\demo\\AppData",
                            history_storage_dir: "C:\\Users\\demo\\Documents\\vPaste",
                        }}
                        onSave={vi.fn(async () => null)}
                        onBlockingOperationChange={vi.fn()}
                        t={(key, params) => key === "settings.cleanup.confirm" ? `Delete ${params?.items} from ${params?.range}; protected records stay` : key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );
        const user = userEvent.setup();

        expect(screen.getByText("C:\\Users\\demo\\Documents\\vPaste")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "settings.storageDir.change" }));
        expect(bridge.open).toHaveBeenCalledOnce();

        const importButton = screen.getByRole("button", { name: "settings.importHistory" });
        const exportButton = screen.getByRole("button", { name: "settings.exportHistory" });
        expect(importButton).toHaveClass("MuiButton-outlined");
        expect(exportButton).toHaveClass("MuiButton-outlined");

        await user.click(screen.getByRole("button", { name: "settings.cleanupSelect" }));
        await user.click(screen.getByRole("menuitem", { name: "settings.cleanup.30" }));
        const cleanupButton = screen.getByRole("button", { name: /common\.cleanup/ });
        await waitFor(() => expect(cleanupButton).toBeEnabled());

        await user.click(cleanupButton);
        expect(screen.getByRole("alertdialog", { name: "settings.cleanup.confirmTitle" })).toHaveTextContent("Delete 4 from settings.cleanup.30; protected records stay");
        await user.click(screen.getByRole("button", { name: "common.cancel", exact: true }));
        expect(bridge.invoke).not.toHaveBeenCalledWith("cleanup_storage_history", expect.anything());

        await user.click(cleanupButton);
        await user.click(screen.getByRole("button", { name: "common.cleanup", exact: true }));
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("cleanup_storage_history", { days: 30 }));
    });

    it("uses the shared destructive dialog before clearing legacy history", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.invoke).mockImplementation(async (command: string) => {
            if (command === "list_recent_app_source_options") return [];
            if (command === "estimate_storage_cleanup") return { bytes: 0, items: 0 };
            if (command === "get_history_format_status") return { migration_required: true };
            return null;
        });
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={DEFAULT_CONFIG}
                        storagePaths={null}
                        onSave={vi.fn(async () => null)}
                        onBlockingOperationChange={vi.fn()}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "settings.legacyHistory.clear" }));
        expect(screen.getByRole("alertdialog", { name: "settings.legacyHistory.confirmTitle" })).toBeVisible();
        await user.click(screen.getByRole("button", { name: "settings.legacyHistory.clear" }));

        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("clear_legacy_history", {
            confirmation: "CLEAR_LEGACY_HISTORY",
        }));
    });

    it("shows progress and prevents duplicate confirmation while legacy history is clearing", async () => {
        const bridge = createBridge();
        let finishClear: (() => void) | undefined;
        vi.mocked(bridge.invoke).mockImplementation(async (command: string) => {
            if (command === "list_recent_app_source_options") return [];
            if (command === "estimate_storage_cleanup") return { bytes: 0, items: 0 };
            if (command === "get_history_format_status") return { migration_required: true };
            if (command === "clear_legacy_history") {
                await new Promise<void>(resolve => {
                    finishClear = resolve;
                });
            }
            return null;
        });
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={DEFAULT_CONFIG}
                        storagePaths={null}
                        onSave={vi.fn(async () => null)}
                        onBlockingOperationChange={vi.fn()}
                        t={key => key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "settings.legacyHistory.clear" }));
        const confirmButton = screen.getByRole("button", { name: "settings.legacyHistory.clear" });
        await user.click(confirmButton);

        expect(screen.getByRole("alertdialog", { name: "settings.legacyHistory.confirmTitle" })).toBeVisible();
        expect(confirmButton).toBeDisabled();
        expect(screen.getByRole("button", { name: "common.cancel" })).toBeDisabled();
        expect(screen.getByRole("alertdialog")).toHaveTextContent("settings.legacyHistory.clearing");

        finishClear?.();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("keeps the confirmation available and shows the backend error when legacy clearing fails", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.invoke).mockImplementation(async (command: string) => {
            if (command === "list_recent_app_source_options") return [];
            if (command === "estimate_storage_cleanup") return { bytes: 0, items: 0 };
            if (command === "get_history_format_status") return { migration_required: true };
            if (command === "clear_legacy_history") throw new Error("database is locked");
            return null;
        });
        render(
            <MotionTestProvider>
                <AppThemeProvider>
                    <DataSettings
                        bridge={bridge}
                        config={DEFAULT_CONFIG}
                        storagePaths={null}
                        onSave={vi.fn(async () => null)}
                        onBlockingOperationChange={vi.fn()}
                        t={(key, values) => values?.error ? `${key}: ${values.error}` : key}
                    />
                </AppThemeProvider>
            </MotionTestProvider>,
        );

        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "settings.legacyHistory.clear" }));
        await user.click(screen.getByRole("button", { name: "settings.legacyHistory.clear" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("settings.legacyHistory.clearFailed: Error: database is locked");
        expect(screen.getByRole("alertdialog", { name: "settings.legacyHistory.confirmTitle" })).toBeVisible();
        expect(screen.getByRole("button", { name: "settings.legacyHistory.clear" })).toBeEnabled();
    });

});
