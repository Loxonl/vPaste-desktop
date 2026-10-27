import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

function renderLocalizedSettings(bridge: SettingsBridge, pack = zhCN) {
    const t = (key: string, params: Record<string, string | number> = {}) => Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), pack.translations[key] ?? key,
    );
    render(<MotionTestProvider><AppThemeProvider><DataSettings bridge={bridge} config={DEFAULT_CONFIG}
        storagePaths={null} onSave={vi.fn(async () => null)} onBlockingOperationChange={vi.fn()} t={t} />
    </AppThemeProvider></MotionTestProvider>);
    return { user: userEvent.setup(), t };
}

describe("Data settings actions", () => {
    it("offers current history actions without requesting retired migration commands", async () => {
        const bridge = createBridge();
        render(<MotionTestProvider><AppThemeProvider>
            <DataSettings bridge={bridge} config={DEFAULT_CONFIG} storagePaths={null}
                onSave={vi.fn(async () => null)} onBlockingOperationChange={vi.fn()} t={key => key} />
        </AppThemeProvider></MotionTestProvider>);
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("estimate_storage_cleanup", { days: 0 }));
        expect(bridge.invoke).not.toHaveBeenCalledWith("get_history_format_status");
        expect(bridge.listen).not.toHaveBeenCalledWith("history-format-status-changed", expect.anything());
        expect(screen.queryByRole("button", { name: "settings.legacyHistory.clear" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "settings.importHistory" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "settings.exportHistory" })).toBeEnabled();
    });

    it.each([{ name: "Chinese", pack: zhCN }, { name: "English", pack: enUS }])("shows cleanup scope, count, protection, and warning before deleting ($name)", async ({ pack }) => {
        const bridge = createBridge();
        const invoke = vi.mocked(bridge.invoke).getMockImplementation()!;
        vi.mocked(bridge.invoke).mockImplementation(async (command, args) => command === "estimate_storage_cleanup"
            ? { bytes: 2048, items: 12 } : invoke(command, args));
        const { user, t } = renderLocalizedSettings(bridge, pack);
        await user.click(screen.getByRole("button", { name: t("settings.cleanupSelect") }));
        await user.click(screen.getByRole("menuitem", { name: t("settings.cleanup.all"), exact: true }));
        await user.click(screen.getByRole("button", { name: new RegExp(`^${t("common.cleanup")}`) }));
        const dialog = await screen.findByRole("alertdialog", { name: t("settings.cleanup.confirmTitle") });
        expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
        expect(dialog).toHaveTextContent(t("settings.cleanup.keepProtected"));
        expect(dialog).toHaveAccessibleDescription(new RegExp(t("settings.cleanup.irreversible").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        expect(bridge.invoke).not.toHaveBeenCalledWith("cleanup_storage_history", expect.anything());
    });

    it("shows only the empty-state instruction when no privacy apps are available", async () => {
        const { user, t } = renderLocalizedSettings(createBridge());
        await user.click(screen.getByRole("button", { name: t("settings.privacyApps.manage") }));
        const dialog = screen.getByRole("dialog", { name: t("settings.privacyApps.manage") });
        await waitFor(() => expect(within(dialog).getByText(t("settings.privacyApps.noOptions"))).toBeVisible());
        expect(within(dialog).queryByText(t("settings.privacyApps.help"))).not.toBeInTheDocument();
    });

    it.each([{ name: "Chinese", pack: zhCN }, { name: "English", pack: enUS }])("keeps all import statistics on separate lines and localizes the archive picker ($name)", async ({ pack }) => {
        const bridge = createBridge();
        vi.mocked(bridge.open).mockResolvedValue("archive.vphistory");
        const invoke = vi.mocked(bridge.invoke).getMockImplementation()!;
        vi.mocked(bridge.invoke).mockImplementation(async (command, args) => command === "import_history_archive"
            ? { merged_items: 12, skipped_items: 3, copied_files: 4 } : invoke(command, args));
        const { user, t } = renderLocalizedSettings(bridge, pack);
        await user.click(screen.getByRole("button", { name: t("settings.importHistory") }));
        const detail = await screen.findByText(t("settings.importSuccessFiles", { files: 4 }), { exact: true });
        const status = detail.closest('[role="status"]')!;
        expect(status).toHaveTextContent(t("settings.importSuccess", { merged: 12, skipped: 3 }));
        expect(bridge.open).toHaveBeenCalledWith({ multiple: false,
            filters: [{ name: t("settings.historyArchiveFileType"), extensions: ["vphistory"] }] });
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

    it("uses standard storage and transfer actions and confirms cleanup", async () => {
        const bridge = createBridge();
        vi.mocked(bridge.invoke).mockImplementation(async (command: string) => {
            if (command === "list_recent_app_source_options") return [];
            if (command === "estimate_storage_cleanup") return { bytes: 2048, items: 4 };
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
                        t={(key, params) => key === "settings.cleanup.confirm" ? `Range ${params?.range}`
                            : key === "settings.cleanup.confirmCount" ? `Delete ${params?.items}` : key}
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
        const cleanupDialog = screen.getByRole("alertdialog", { name: "settings.cleanup.confirmTitle" });
        expect(within(cleanupDialog).getAllByRole("listitem")).toHaveLength(3);
        expect(cleanupDialog).toHaveTextContent("Range settings.cleanup.30");
        expect(cleanupDialog).toHaveTextContent("Delete 4");
        await user.click(screen.getByRole("button", { name: "common.cancel", exact: true }));
        expect(bridge.invoke).not.toHaveBeenCalledWith("cleanup_storage_history", expect.anything());

        await user.click(cleanupButton);
        await user.click(screen.getByRole("button", { name: "common.cleanup", exact: true }));
        await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("cleanup_storage_history", { days: 30 }));
    });


});
