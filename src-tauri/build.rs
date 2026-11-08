use std::{env, fs, path::PathBuf, process::Command};

const TRAY_ICON_SIZE: u32 = 128;
const TRAY_ICON_SCALE: f32 = 1.1;

fn generate_tray_icon_mask() {
    let source_path = "icons/source/vpaste-tray.svg";
    println!("cargo:rerun-if-changed={source_path}");

    let svg = fs::read_to_string(source_path).expect("read tray SVG");
    let tree = resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options::default())
        .expect("parse tray SVG");
    let mut pixmap = resvg::tiny_skia::Pixmap::new(TRAY_ICON_SIZE, TRAY_ICON_SIZE)
        .expect("allocate tray pixmap");
    let tree_size = tree.size();
    let scale_x = TRAY_ICON_SIZE as f32 / tree_size.width() * TRAY_ICON_SCALE;
    let scale_y = TRAY_ICON_SIZE as f32 / tree_size.height() * TRAY_ICON_SCALE;
    let translate_x = (TRAY_ICON_SIZE as f32 - tree_size.width() * scale_x) / 2.0;
    let translate_y = (TRAY_ICON_SIZE as f32 - tree_size.height() * scale_y) / 2.0;
    let transform =
        resvg::tiny_skia::Transform::from_row(scale_x, 0.0, 0.0, scale_y, translate_x, translate_y);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    let output_path =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("vpaste-tray.rgba");
    fs::write(output_path, pixmap.data()).expect("write tray RGBA mask");
}

const NATIVE_DEMO_HEADER: &str = "native-demo/NativeDemoBridge.h";

/// Compiles the DEV native window (native-demo/) for macOS (Swift) or
/// Windows (C++ Win32) and links it into the binary. Only Debug builds use it,
/// so release, App Store and installer builds never invoke these toolchains.
fn build_native_demo() {
    if env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_none() {
        return;
    }
    println!("cargo:rerun-if-changed={NATIVE_DEMO_HEADER}");
    match env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => build_swift_native_demo(),
        Ok("windows") => build_win32_native_demo(),
        _ => {}
    }
}

fn build_swift_native_demo() {
    const SOURCE: &str = "native-demo/macos/NativeDemoWindow.swift";
    const PANEL_SOURCES: &[&str] = &[
        "native-panel/NativePanelModels.swift",
        "native-panel/NativePanelStyle.swift",
        "native-panel/NativePanelAppKitToolbar.swift",
        "native-panel/NativePanelToolbar.swift",
        "native-panel/NativePanelBackdrop.swift",
        "native-panel/NativePanelMedia.swift",
        "native-panel/NativePanelCards.swift",
        "native-panel/NativePanelPreview.swift",
        "native-panel/NativePanelController.swift",
    ];
    println!("cargo:rerun-if-changed=native-panel/NativePanelBridge.h");
    for source in PANEL_SOURCES {
        println!("cargo:rerun-if-changed={source}");
    }

    println!("cargo:rerun-if-changed={SOURCE}");

    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("unsupported macOS architecture for the native demo: {other:?}"),
    };
    let target = format!("{arch}-apple-macos11.0");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let library = out_dir.join("libVPasteNativeDemo.a");

    println!("cargo:rerun-if-env-changed=SDKROOT");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let liquid_glass_sdk = Command::new("xcrun")
        .arg("--show-sdk-path")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
                .join("System/Library/Frameworks/AppKit.framework/Headers/NSGlassEffectView.h")
                .is_file()
        });
    let mut swift = Command::new("xcrun");
    if liquid_glass_sdk {
        swift.args(["swiftc", "-D", "VPASTE_LIQUID_GLASS_SDK"]);
    } else {
        swift.arg("swiftc");
    }
    let status = swift
        .args(["-emit-library", "-static", "-parse-as-library"])
        .args(["-swift-version", "5", "-module-name", "VPasteNativeDemo"])
        .args([
            "-target",
            &target,
            "-import-objc-header",
            NATIVE_DEMO_HEADER,
        ])
        .arg("-module-cache-path")
        .arg(out_dir.join("swift-module-cache"))
        .arg("-o")
        .arg(&library)
        .arg(SOURCE)
        .args(PANEL_SOURCES)
        .status()
        .expect("run `xcrun swiftc` (install Xcode or the Command Line Tools)");
    assert!(status.success(), "Swift native demo failed to compile");

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=VPasteNativeDemo");
    // The Swift objects autolink their runtime libraries; point the linker at them.
    let info = Command::new("xcrun")
        .args(["swiftc", "-print-target-info", "-target", &target])
        .output()
        .expect("query Swift target info");
    for path in swift_runtime_library_paths(&String::from_utf8_lossy(&info.stdout)) {
        println!("cargo:rustc-link-search=native={path}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}

fn build_win32_native_demo() {
    const SOURCE: &str = "native-demo/windows/NativeDemoWindow.cpp";
    println!("cargo:rerun-if-changed={SOURCE}");
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .include("native-demo")
        .file(SOURCE)
        .define("UNICODE", None)
        .define("_UNICODE", None);
    if build.get_compiler().is_like_msvc() {
        // The source contains Chinese wide-string literals.
        build.flag("/utf-8");
    }
    build.compile("VPasteNativeDemo");
    for library in ["user32", "gdi32", "comctl32"] {
        println!("cargo:rustc-link-lib=dylib={library}");
    }
}

/// Extracts `paths.runtimeLibraryPaths` from `swiftc -print-target-info`.
fn swift_runtime_library_paths(json: &str) -> Vec<String> {
    let Some(start) = json.find("\"runtimeLibraryPaths\"") else {
        return Vec::new();
    };
    let rest = &json[start..];
    let (Some(open), Some(close)) = (rest.find('['), rest.find(']')) else {
        return Vec::new();
    };
    rest[open + 1..close]
        .split(',')
        .map(|entry| entry.trim().trim_matches('"').to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn main() {
    println!("cargo:rerun-if-env-changed=VPASTE_PUBLIC_UPDATE_FEED");
    println!("cargo:rerun-if-env-changed=VPASTE_UPDATE_CHANNEL");
    println!("cargo:rerun-if-env-changed=VPASTE_APP_STORE_ID");
    if env::var_os("CARGO_FEATURE_MAC_APP_STORE").is_some() {
        let item_id = env::var("VPASTE_APP_STORE_ID")
            .expect("VPASTE_APP_STORE_ID is required for Mac App Store builds");
        assert!(
            !item_id.starts_with('0')
                && !item_id.is_empty()
                && item_id.bytes().all(|byte| byte.is_ascii_digit()),
            "VPASTE_APP_STORE_ID must be a numeric App Store item ID"
        );
    }
    generate_tray_icon_mask();
    build_native_demo();
    tauri_build::build()
}
