import type { SettingsBridge } from "./SettingsBridge";

interface PersistSettingsOptions<TConfig, TPaths> {
    bridge: SettingsBridge;
    previousConfig: TConfig;
    nextConfig: TConfig;
    applyConfig: (config: TConfig) => void;
    applyStoragePaths: (paths: TPaths) => void;
    serialize: (config: TConfig) => string;
}

export async function persistSettings<TConfig, TMigration, TPaths>({
    bridge,
    previousConfig,
    nextConfig,
    applyConfig,
    applyStoragePaths,
    serialize,
}: PersistSettingsOptions<TConfig, TPaths>): Promise<TMigration> {
    applyConfig(nextConfig);

    try {
        const migration = await bridge.invoke<TMigration>("save_config", {
            config: serialize(nextConfig),
        });
        const storagePaths = await bridge.invoke<TPaths>("get_storage_paths", {});
        applyStoragePaths(storagePaths);
        return migration;
    } catch (cause) {
        applyConfig(previousConfig);
        throw cause;
    }
}
