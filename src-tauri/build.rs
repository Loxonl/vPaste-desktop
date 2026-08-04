use std::{env, fs, path::PathBuf};

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

fn main() {
    println!("cargo:rerun-if-env-changed=VPASTE_PUBLIC_UPDATE_FEED");
    println!("cargo:rerun-if-env-changed=VPASTE_UPDATE_CHANNEL");
    generate_tray_icon_mask();
    tauri_build::build()
}
