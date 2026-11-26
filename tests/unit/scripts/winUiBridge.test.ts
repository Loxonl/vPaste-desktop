import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const nativeRoot = "src-tauri/native-demo/windows/winui/";

describe("private WinUI transport and shared motion source", () => {
    it("keeps the internal Portable RC off the updater and installer paths", () => {
        const standard = JSON.parse(read("src-tauri/tauri.conf.json"));
        const trial = JSON.parse(read("src-tauri/tauri.winui-rc.conf.json"));
        const script = read("scripts/build-windows-release.ps1");
        const portable = script.slice(script.indexOf("# The internal RC has its own portable output"), script.indexOf("function Find-InnoCompiler"));

        expect(standard.plugins.updater.endpoints).toEqual(["https://vpaste.app/download/stable/latest.json"]);
        expect(standard.plugins.updater.pubkey).toBeTruthy();
        expect(trial.plugins.updater).toBeNull();
        expect(trial.bundle.createUpdaterArtifacts).toBe(false);
        expect(trial.identifier).toBeUndefined();
        expect(portable).toContain("internal-rc.flag");
        expect(portable).toContain("--no-bundle");
        expect(portable).toContain("Compress-Archive");
        expect(portable).toMatch(/\breturn\s*\}/);
        expect(portable).not.toMatch(/tauri signer|Get-AuthenticodeCertificate|generate-updater-manifest|latest\.windows\.json|ISCC\.exe/i);
    });

    it("initializes WinUI after single-instance routing with safe fallback and explicit error reporting", () => {
        const main = read("src-tauri/src/main.rs").split("\nfn main() {")[1];
        const beforeApp = main.indexOf("if image_ocr::worker::run_if_requested()");
        const singleInstance = main.indexOf("tauri_plugin_single_instance::init");
        const setup = main.indexOf(".setup(move |app|");
        const coordinator = main.indexOf("main_panel_mode::initialize_winui_or_fallback(", setup);
        const probe = "winui_panel::check_runtime";

        expect(singleInstance).toBeGreaterThan(beforeApp);
        expect(setup).toBeGreaterThan(singleInstance);
        expect(coordinator).toBeGreaterThan(setup);
        expect(main.slice(0, beforeApp)).toContain(probe);
        expect(main.slice(beforeApp, setup)).not.toContain(probe);
        expect(main.slice(beforeApp, setup)).not.toContain("winui_panel::initialize(");
        expect(main.slice(setup)).toContain("WinUiStartupOutcome::FallbackToWebview");
        expect(main.slice(setup)).toContain("report_explicit_winui_startup_error(&message)");
    });

    it("wires official Windows Release packaging, SDK auto-selection, and CI WinUI gates", () => {
        const releaseScript = read("scripts/build-windows-release.ps1");
        const binaryCheck = read("scripts/check-windows-release-binary.ps1");
        const buildRs = read("src-tauri/build.rs");
        const vcxproj = read(nativeRoot + "WinUiPanel.vcxproj");
        const prChecks = read(".github/workflows/pr-checks.yml");
        const tagRelease = read(".github/workflows/tag-release.yml");
        const iss = read("installer/windows/vpaste.iss");

        expect(releaseScript).toContain("--features\", \"winui");
        expect(releaseScript).toContain("VPasteWinUiPanel.dll");
        expect(releaseScript).toContain("Microsoft.WindowsAppRuntime.Bootstrap.dll");
        expect(releaseScript).toContain("winui-payload.sha256");
        expect(releaseScript).toContain("/DWinUiBinaryDir=");
        expect(releaseScript).toContain("/DWinUiLicenseDir=");
        expect(releaseScript).toContain("/DWinUiReceipt=");
        expect(releaseScript).toContain("[switch]$WebViewOnly");
        expect(binaryCheck).toContain("$expectedDefault = if ($expectsWinUi) { 'winui' } else { 'webview' }");

        expect(buildRs).toContain("select_windows_sdk_version()");
        expect(buildRs).toContain("MIN_WINDOWS_SDK_VERSION: (u32, u32, u32, u32) = (10, 0, 22000, 0)");
        expect(buildRs).toContain("/p:WindowsTargetPlatformVersion={sdk_version}");
        expect(vcxproj).toContain("Condition=\"'$(WindowsTargetPlatformVersion)' == ''\"");

        expect(prChecks).toContain("if: matrix.platform == 'Windows'");
        expect(prChecks).toContain("cargo check --release --locked --features winui --bin vPaste --manifest-path src-tauri/Cargo.toml");
        expect(prChecks).toContain("cargo test --release --locked --features winui --bin vPaste --manifest-path src-tauri/Cargo.toml -- winui_startup winui_default_startup_tests main_panel_mode::tests startup_panel::tests app_updater::tests");

        expect(tagRelease).toContain("npx tauri build --no-bundle --features winui --config src-tauri/tauri.local.conf.json");
        expect(tagRelease).toContain("VPasteWinUiPanel.dll");
        expect(iss).toContain("MinVersion=10.0.16299");
        expect(iss).toContain("ValidateInstallDirectory(PayloadRoot);");
        expect(iss).toContain("ManagedPathExists(PayloadRoot + '.installer', True)");
        expect(iss).toContain('Source: "{code:InstallerLogoAfterPayloadCheck}"');
    });

    it("declares the native NuGet target before importing MSBuild targets", () => {
        const project = read(nativeRoot + "WinUiPanel.vcxproj");
        const beforeImports = project.slice(0, project.indexOf("<Import "));
        expect(beforeImports).toContain("<NuGetTargetMoniker>native,Version=v0.0</NuGetTargetMoniker>");
    });

    it("blocks the internal RC from portable autostart even when startup is enabled in its profile", () => {
        const main = read("src-tauri/src/main.rs").replace(/\s+/g, " ");
        const internalRc = "main_panel_mode::WINDOWS_INTERNAL_RC";
        const earlyReturn = `if ${internalRc} { return Ok(false); }`;
        const portableOnly = '#[cfg(target_os = "windows")] if runtime_mode::is_portable()';
        const portableCalls = [...main.matchAll(/\bportable_autostart::(\w+)\(/g)].map((call) => call[1]);

        expect(portableCalls.sort()).toEqual(["is_enabled", "reconcile", "reconcile_before_single_instance", "set_enabled"]);
        expect(main).toContain(`${earlyReturn} ${portableOnly} { return portable_autostart::is_enabled(); }`);
        expect(main).toContain(`${earlyReturn} ${portableOnly} { return portable_autostart::set_enabled(startup); }`);
        expect(main).toContain(`if !${internalRc} && !memory_profile_active() && !local_acceptance_no_capture() { if let Err(err) = portable_autostart::reconcile_before_single_instance()`);
        expect(main).toContain(`if !${internalRc} && runtime_mode::is_portable() && !local_acceptance_no_capture() { if let Err(err) = portable_autostart::reconcile(config.startup)`);
        expect(main).toContain(`if ${internalRc} { builder } else { builder.plugin(tauri_plugin_autostart::init(`);
    });

    it("keeps the isolated WinUI memory run out of the WebView creation path", () => {
        const profile = read("src-tauri/src/memory_profile.rs");
        const setup = profile.slice(profile.indexOf("pub fn setup("));
        const beforeWebview = setup.slice(0, setup.indexOf("crate::build_clipboard_window"));
        expect(beforeWebview).toContain("main_panel_mode::winui()");
        expect(beforeWebview).toContain("winui_panel::initialize");
    });

    it("keeps the synthetic first-page run independent of live capture and preview warmup", () => {
        const main = read("src-tauri/src/main.rs");
        const capture = main.slice(main.indexOf("async fn wait_for_clipboard_capture()"));
        const beforeLiveCapture = capture.slice(0, capture.indexOf("spawn_blocking"));
        expect(beforeLiveCapture).toMatch(/if memory_profile_active\(\)\s*\{\s*return Ok\(None\);/);
        const preview = main.slice(main.indexOf("fn prewarm_preview_window("));
        const beforePreviewCreation = preview.slice(0, preview.indexOf("tauri::async_runtime::spawn"));
        expect(beforePreviewCreation).toMatch(/if memory_profile_active\(\)\s*\{\s*return;/);
    });

    it("keeps both sides of the bounded ABI compatible", () => {
        const rust = read("src-tauri/src/winui_panel/bridge.rs");
        const cpp = read(nativeRoot + "WinUiBridge.h");
        for (const [rustName, cppName] of [
            ["PROTOCOL_VERSION", "BridgeVersion"],
            ["MAX_REQUEST_BYTES", "MaxRequestBytes"],
            ["MAX_RESPONSE_BYTES", "MaxResponseBytes"],
        ]) {
            const rustValue = rust.match(new RegExp(`${rustName}: \\w+ = ([\\d *]+);`))?.[1];
            const cppValue = cpp.match(new RegExp(`${cppName} = ([\\d *]+);`))?.[1];
            expect(rustValue).toBeDefined();
            expect(cppValue?.replaceAll(" ", "")).toEqual(rustValue?.replaceAll(" ", ""));
        }
    });

    it("does not reuse a released ABI version for the native document and guide protocol", () => {
        const rust = read("src-tauri/src/winui_panel/bridge.rs");
        expect(Number(rust.match(/PROTOCOL_VERSION: u32 = (\d+);/)?.[1])).toBeGreaterThan(7);
    });

    it("embeds the same motion data rather than another native timing scale", () => {
        expect(read(nativeRoot + "WinUiMotion.rc")).toContain("src/ui/motion/tokens.json");
        expect(read("src/ui/motion/tokens.ts")).toContain('from "./tokens.json"');
        expect(read("src-tauri/src/winui_panel/reader.rs")).toContain("src/ui/motion/tokens.json");
        expect(read(nativeRoot + "WinUiPanel.vcxproj")).toContain('ResourceCompile Include="WinUiMotion.rc"');
    });
});
