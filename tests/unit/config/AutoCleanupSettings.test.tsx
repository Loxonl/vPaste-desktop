import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataSettings from "../../../src/config/sections/DataSettings";
import type { SettingsBridge } from "../../../src/config/SettingsBridge";
import { DEFAULT_CONFIG } from "../../../src/config/settingsTypes";
import zhCN from "../../../src/lang/locales/zh-CN";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import { MotionTestProvider } from "../../../src/ui/motion/MotionTestProvider";

afterEach(cleanup);

function setup(overrides = {}) {
    const config = { ...DEFAULT_CONFIG, ...overrides };
    const bridge = {
        invoke: vi.fn(async (command: string) => {
            if (command === "get_history_format_status") return { migration_required: false };
            if (command === "list_recent_app_source_options") return [];
            return { items: 12, bytes: 2048 };
        }),
        listen: vi.fn(async () => () => undefined),
        open: vi.fn(), save: vi.fn(), convertFileSrc: (path: string) => path,
    } as unknown as SettingsBridge;
    const onSave = vi.fn(async () => null);
    const translations = zhCN.translations as Record<string, string>;
    render(
        <MotionTestProvider><AppThemeProvider>
            <DataSettings
                bridge={bridge} config={config} storagePaths={null} onSave={onSave}
                onBlockingOperationChange={vi.fn()}
                t={(key, params) => Object.entries(params ?? {}).reduce(
                    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
                    translations[key] ?? key,
                )}
            />
        </AppThemeProvider></MotionTestProvider>,
    );
    return { bridge, onSave, config, user: userEvent.setup() };
}

describe("Automatic history cleanup", () => {
    it("defaults to disabled and editing a rule does not save or delete", async () => {
        const { user, bridge, onSave } = setup();
        expect(screen.getByRole("combobox", { name: "自动清理数据" })).toHaveTextContent("不自动清理");
        expect(screen.getByText("手动清理数据")).toBeVisible();
        await user.click(screen.getByRole("combobox", { name: "自动清理数据" }));
        await user.click(screen.getByRole("option", { name: "按时间保留" }));
        expect(screen.getByRole("combobox", { name: "保留范围" })).toHaveTextContent("30 天");
        expect(onSave).not.toHaveBeenCalled();
        expect(bridge.invoke).not.toHaveBeenCalledWith("estimate_auto_cleanup", expect.anything());
    });

    it("estimates before confirming and supports cancelling without saving", async () => {
        const { user, bridge, onSave, config } = setup();
        await user.click(screen.getByRole("combobox", { name: "自动清理数据" }));
        await user.click(screen.getByRole("option", { name: "按数量保留" }));
        await user.click(screen.getByRole("button", { name: "应用" }));
        const dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
        expect(dialog).toHaveAccessibleDescription(/删除后无法恢复/);
        expect(dialog).toHaveTextContent("12");
        expect(dialog).toHaveTextContent("收藏");
        expect(dialog).toHaveTextContent("标签");
        expect(bridge.invoke).toHaveBeenCalledWith("estimate_auto_cleanup", {
            policy: { mode: "count", value: 5000 },
        });
        expect(onSave).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole("button", { name: "取消" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        expect(onSave).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "应用" }));
        await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "应用并开启" }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith({
            ...config, auto_cleanup: { mode: "count", value: 5000 },
        }));
    });

    it("validates custom values and disables an active policy immediately", async () => {
        const { user, onSave, config } = setup({ auto_cleanup: { mode: "days", value: 30 } });
        await user.click(screen.getByRole("combobox", { name: "保留范围" }));
        await user.click(screen.getByRole("option", { name: "自定义" }));
        const input = screen.getByRole("spinbutton", { name: "保留天数" });
        await user.clear(input);
        await user.type(input, "0");
        expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
        await user.clear(input);
        await user.type(input, "45");
        expect(screen.getByRole("button", { name: "应用" })).toBeEnabled();
        expect(onSave).not.toHaveBeenCalled();
        await user.click(screen.getByRole("combobox", { name: "自动清理数据" }));
        await user.click(screen.getByRole("option", { name: "不自动清理" }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith({
            ...config, auto_cleanup: { mode: "disabled" },
        }));
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("reports estimate failures without applying the policy", async () => {
        const { user, bridge, onSave } = setup();
        vi.mocked(bridge.invoke).mockImplementation(async command => {
            if (command === "estimate_auto_cleanup") throw new Error("storage unavailable");
            return { items: 0, bytes: 0 };
        });
        await user.click(screen.getByRole("combobox", { name: "自动清理数据" }));
        await user.click(screen.getByRole("option", { name: "按时间保留" }));
        await user.click(screen.getByRole("button", { name: "应用" }));
        await waitFor(() => expect(screen.getByText(/storage unavailable/)).toBeVisible());
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("keeps a failed save visible and restores the active rule if disabling fails", async () => {
        const { user, onSave } = setup({ auto_cleanup: { mode: "count", value: 5000 } });
        onSave.mockRejectedValue(new Error("disk full"));
        await user.click(screen.getByRole("combobox", { name: "自动清理数据" }));
        await user.click(screen.getByRole("option", { name: "不自动清理" }));
        await waitFor(() => expect(screen.getByRole("combobox", { name: "自动清理数据" })).toHaveTextContent("按数量保留"));
        expect(screen.getByRole("combobox", { name: "保留范围" })).toHaveTextContent("5000 条");
        await waitFor(() => expect(screen.getByText(/disk full/)).toBeVisible());
    });
});
