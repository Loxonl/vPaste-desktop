import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import DeveloperMemoryPanel from "../../../src/debug/DeveloperMemoryPanel";
const t = (key: string) => key;

const sample = {
    timestamp: 1000, totalResidentBytes: 10485760, totalAccountedBytes: 8388608, partial: false,
    windows: [{ label: "clipboard", visible: true, rendererPids: [42], error: null }],
    processes: [{ pid: 42, kind: "renderer", windowLabels: ["clipboard", "config"], retained: false, residentBytes: 10485760, accountedBytes: 8388608, error: null }],
};
const report = { running: true, platform: "macos", accountedMetric: "physicalFootprint", samples: [sample] };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("developer memory panel", () => {
    it("follows the main window's DEV preview language", async () => {
        invoke.mockResolvedValue(report);
        const preview = (key: string) => key === "memory.title" ? "预览语言的内存面板" : key;
        render(<DeveloperMemoryPanel open onClose={vi.fn()} t={preview} />);
        expect(await screen.findByRole("dialog", { name: "预览语言的内存面板" })).toBeVisible();
    });

    it("shows shared PID once, refreshes and keeps backend sampling when dismissed", async () => {
        invoke.mockResolvedValue(report);
        const close = vi.fn();
        render(<DeveloperMemoryPanel open onClose={close} t={t} />);
        await screen.findByText("clipboard, config");
        const processes = screen.getByRole("table", { name: "memory.processes" });
        expect(within(processes).getAllByText("42")).toHaveLength(1);
        expect(within(processes).getByText("10.0 MiB")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "memory.refresh" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_dev_memory_report", { refresh: true }));
        fireEvent.click(screen.getByRole("button", { name: "memory.close" }));
        expect(close).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalledWith("set_dev_memory_monitoring", { enabled: false });
    });

    it("starts an empty monitor, explicitly stops it and displays collection errors", async () => {
        invoke.mockImplementation(async (command: string) => command === "set_dev_memory_monitoring"
            ? report : { ...report, running: false, samples: [] });
        render(<DeveloperMemoryPanel open onClose={vi.fn()} t={t} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_dev_memory_monitoring", { enabled: true }));
        await screen.findByText("clipboard, config");
        invoke.mockRejectedValueOnce(new Error("native access denied"));
        fireEvent.click(screen.getByRole("button", { name: "memory.refresh" }));
        await screen.findByText(/native access denied/);
        invoke.mockResolvedValue({ ...report, running: false });
        fireEvent.click(screen.getByRole("checkbox", { name: "memory.monitoring" }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_dev_memory_monitoring", { enabled: false }));
    });

    it("can inspect an earlier window snapshot and compare its baseline with the live sample", async () => {
        const recent = { ...sample, timestamp: 2000, totalAccountedBytes: 16777216,
            processes: [{ ...sample.processes[0], windowLabels: ["liveWindow"], residentBytes: null }] };
        invoke.mockResolvedValue({ ...report, samples: [sample, recent] });
        render(<DeveloperMemoryPanel open onClose={vi.fn()} t={t} />);
        await screen.findByText("liveWindow");
        const selector = screen.getByRole("combobox", { name: "memory.sampleTime" });
        fireEvent.mouseDown(selector);
        fireEvent.click(screen.getByRole("option", { name: new Date(1000).toLocaleTimeString() }));
        await screen.findByText("clipboard, config");
        fireEvent.click(screen.getByRole("button", { name: "memory.setBaseline" }));
        fireEvent.mouseDown(selector);
        fireEvent.click(screen.getByRole("option", { name: "memory.live" }));
        await screen.findByText("liveWindow");
        expect(screen.getByText("+8.0 MiB")).toBeVisible();
        expect(within(screen.getByRole("table", { name: "memory.processes" })).getByText("—")).toBeVisible();
    });
});
