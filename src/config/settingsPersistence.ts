import type { SettingsBridge } from "./SettingsBridge";

interface PersistSettingsOptions<TConfig, TPaths> {
    bridge: SettingsBridge;
    previousConfig: TConfig;
    nextConfig: TConfig;
    applyConfig: (config: TConfig) => void;
    applyStoragePaths: (paths: TPaths) => void;
    serialize: (config: TConfig) => string;
}

export async function persistSettings<TConfig, TSaveResult, TPaths>({
    bridge,
    previousConfig,
    nextConfig,
    applyConfig,
    applyStoragePaths,
    serialize,
}: PersistSettingsOptions<TConfig, TPaths>): Promise<TSaveResult> {
    applyConfig(nextConfig);

    try {
        const saveResult = await bridge.invoke<TSaveResult>("save_config", {
            config: serialize(nextConfig),
        });
        const storagePaths = await bridge.invoke<TPaths>("get_storage_paths", {});
        applyStoragePaths(storagePaths);
        return saveResult;
    } catch (cause) {
        applyConfig(previousConfig);
        throw cause;
    }
}
