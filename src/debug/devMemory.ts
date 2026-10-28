export type MemoryProcess = {
    pid: number;
    kind: string;
    windowLabels: string[];
    retained: boolean;
    residentBytes: number | null;
    accountedBytes: number | null;
    error: string | null;
};

export type MemorySample = {
    timestamp: number;
    windows: { label: string; visible: boolean; rendererPids: number[]; error: string | null }[];
    processes: MemoryProcess[];
    totalResidentBytes: number;
    totalAccountedBytes: number;
    partial: boolean;
};

export type MemoryReport = {
    running: boolean;
    platform: string;
    accountedMetric: "physicalFootprint" | "privateBytes";
    samples: MemorySample[];
};

export function memorySize(bytes: number | null): string {
    return bytes === null ? "—" : `${(bytes / 1048576).toFixed(1)} MiB`;
}
