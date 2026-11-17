//! Shipping FileTypePresentation and fileTypeIcons associations for native cards.
use serde_json::{json, Value};
use std::sync::LazyLock;

static MANIFEST: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../node_modules/material-icon-theme/dist/material-icons.json"
    ))
    .expect("installed material-icon-theme manifest")
});

fn svg(filename: &str) -> Option<&'static str> {
    include!(concat!(env!("OUT_DIR"), "/native-file-icons.rs"))
}

fn association(kind: &str, key: &str, dark: bool) -> Option<&'static str> {
    if !dark {
        if let Some(name) = MANIFEST["light"][kind][key].as_str() {
            return Some(name);
        }
    }
    MANIFEST[kind][key].as_str()
}

fn icon_name(path: &str, dark: bool) -> Option<&'static str> {
    let normalized = path.replace('\\', "/").to_lowercase();
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let filename = *parts.last()?;
    let parent = parts.get(parts.len().wrapping_sub(2));
    if let Some(parent) = parent {
        if let Some(name) = association("fileNames", &format!("{parent}/{filename}"), dark) {
            return Some(name);
        }
    }
    if let Some(name) = association("fileNames", filename, dark) {
        return Some(name);
    }
    for (offset, _) in filename.match_indices('.') {
        let extension = &filename[offset + 1..];
        if let Some(parent) = parent {
            if let Some(name) =
                association("fileExtensions", &format!("{parent}/{extension}"), dark)
            {
                return Some(name);
            }
        }
        if let Some(name) = association("fileExtensions", extension, dark) {
            return Some(name);
        }
    }
    None
}

fn material_svg(name: &str) -> &'static str {
    MANIFEST["iconDefinitions"][name]["iconPath"]
        .as_str()
        .and_then(|path| path.rsplit('/').next())
        .and_then(svg)
        .unwrap_or("")
}

fn compact_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let units = normalized.encode_utf16().collect::<Vec<_>>();
    if units.len() <= 28 {
        normalized
    } else {
        format!(
            "...{}",
            String::from_utf16_lossy(&units[units.len() - 25..])
        )
    }
}

pub(super) fn presentation(info: &crate::FilePreviewInfo, english: bool) -> Value {
    let multiple = info.kind == "multiple";
    let folder = info.kind == "single-folder";
    let mixed = multiple && info.contains_directories;
    let extension = if info.extension.trim().is_empty() {
        "FILE".to_string()
    } else {
        info.extension.trim().trim_start_matches('.').to_uppercase()
    };
    let label = if folder {
        String::new()
    } else if multiple {
        if english {
            format!("{} files", info.paths.len())
        } else {
            format!("{} 个文件", info.paths.len())
        }
    } else {
        extension.clone()
    };
    let resolve = |dark| {
        let mapped = (!multiple && !folder)
            .then(|| icon_name(&info.display_path, dark))
            .flatten();
        let name = if folder {
            "folder"
        } else if mixed {
            "folder-resource"
        } else {
            mapped.unwrap_or("document")
        };
        // These three shipping product glyphs are intentionally not the
        // library's folder/outlined-document artwork.
        let (name, source) = if folder {
            ("yellow-folder", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='#fbc02d' d='m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232'/></svg>".to_string())
        } else if multiple && !mixed {
            let path = "M8 16h8v2H8zm0-4h8v2H8zm6-10H6C4.9 2 4 2.9 4 4v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z";
            ("document-stack", format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 76 60'><svg x='0' y='6' width='54' height='54' viewBox='0 0 24 24' opacity='.48'><path fill='#42a5f5' d='{path}'/></svg><svg x='11' y='4' width='54' height='54' viewBox='0 0 24 24' opacity='.72'><path fill='#42a5f5' d='{path}'/></svg><svg x='22' y='2' width='54' height='54' viewBox='0 0 24 24'><path fill='#42a5f5' d='{path}'/></svg></svg>"))
        } else if name == "document" && extension == "TXT" {
            ("text-document", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='#42a5f5' d='M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2'/><path fill='#e3f2fd' d='M14 2v5h5z'/><path fill='#fff' d='M7 10h9v1.6H7zm0 3.5h9v1.6H7zM7 17h6.5v1.6H7z'/></svg>".to_string())
        } else {
            (name, material_svg(name).to_string())
        };
        json!({"name": name, "svg": source})
    };
    json!({"light": resolve(false), "dark": resolve(true), "label": label,
        "path": compact_path(&info.display_path), "fullPath": info.display_path,
        "secondary": if multiple {
            if info.secondary_text.is_empty() {
                if english { "and more files" } else { "等多个文件" }
            } else { info.secondary_text.as_str() }
        } else { "" },
        "multiple": multiple && !mixed, "exists": info.exists,
        "imageFile": info.paths.len() == 1 && ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "svg"]
            .contains(&info.extension.to_ascii_lowercase().as_str())})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info(path: &str) -> crate::FilePreviewInfo {
        crate::FilePreviewInfo {
            kind: "single-icon".into(),
            paths: vec![path.into()],
            exists: true,
            missing_paths: vec![],
            display_path: path.into(),
            secondary_text: String::new(),
            extension: path.rsplit('.').next().unwrap().into(),
            preview_path: String::new(),
            contains_directories: false,
            image_width: None,
            image_height: None,
        }
    }
    #[test]
    fn uses_shipping_filename_suffix_parent_and_theme_associations() {
        for path in [
            "C:/docs/report.pdf",
            "C:/src/main.ts",
            "C:/project/package.json",
            "C:/src/example.test.ts",
            "C:/docs/readme.md",
        ] {
            for dark in [false, true] {
                let name = icon_name(path, dark).expect(path);
                assert!(!material_svg(name).is_empty(), "{path} -> {name}");
            }
        }
        assert!(icon_name("C:/unknown.something-vpaste", false).is_none());
        assert_eq!(compact_path(r"C:\short.txt"), "C:/short.txt");
        assert_eq!(
            compact_path("C:/a-very-long-directory-name/report.pdf")
                .encode_utf16()
                .count(),
            28
        );
    }
    #[test]
    fn preserves_shipping_text_folder_unknown_and_multiple_product_glyphs() {
        let mut file = info("C:/notes.txt");
        assert_eq!(presentation(&file, true)["light"]["name"], "text-document");
        file.kind = "single-folder".into();
        assert_eq!(presentation(&file, true)["label"], "");
        assert_eq!(presentation(&file, true)["light"]["name"], "yellow-folder");
        file.kind = "multiple".into();
        file.paths.push("C:/other.pdf".into());
        assert_eq!(presentation(&file, true)["label"], "2 files");
        assert_eq!(presentation(&file, true)["secondary"], "and more files");
        assert_eq!(presentation(&file, false)["secondary"], "等多个文件");
        assert_eq!(
            presentation(&file, false)["light"]["name"],
            "document-stack"
        );
        file.contains_directories = true;
        assert_eq!(
            presentation(&file, true)["light"]["name"],
            "folder-resource"
        );
        file = info("C:/unknown.something-vpaste");
        file.exists = false;
        assert_eq!(presentation(&file, true)["light"]["name"], "document");
        assert_eq!(presentation(&file, true)["exists"], false);
    }
}
