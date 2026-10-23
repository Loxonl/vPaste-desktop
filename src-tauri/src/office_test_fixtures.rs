//! Synthetic fixtures shared by Debug Test Room and automated regressions.
//! The module is compiled only under debug_assertions or cfg(test).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Catalog {
    pub cases: Vec<OfficeCase>,
    pub images: Vec<FixtureImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCase {
    pub id: String,
    pub group: String,
    pub fixture: String,
    pub plain_text: String,
    pub html: String,
    pub expected_images: usize,
}

#[derive(Deserialize)]
pub struct FixtureImage {
    pub key: String,
    pub width: u32,
    pub height: u32,
}

pub struct Payload {
    pub text: String,
    pub html: String,
    pub image_keys: Vec<String>,
}

pub fn catalog() -> Result<Catalog, String> {
    serde_json::from_str(include_str!("../../tests/fixtures/office/catalog.json"))
        .map_err(|err| err.to_string())
}

pub fn image(key: &str) -> &'static [u8] {
    match key {
        "pictureA" => include_bytes!("../../tests/fixtures/office/picture-a.png"),
        "pictureB" => include_bytes!("../../tests/fixtures/office/picture-b.png"),
        "icon" => include_bytes!("../../tests/fixtures/office/inline-icon.png"),
        "largePicture" => include_bytes!("../../tests/fixtures/office/large-picture.png"),
        _ => unreachable!("bundled Office fixture key"),
    }
}

pub fn documents() -> [(&'static str, &'static [u8]); 2] {
    [
        (
            "vPaste-Office.docx",
            include_bytes!("../../tests/fixtures/office/vPaste-Office.docx"),
        ),
        (
            "vPaste-Office.xlsx",
            include_bytes!("../../tests/fixtures/office/vPaste-Office.xlsx"),
        ),
    ]
}

pub fn payloads(case: &OfficeCase) -> Result<Vec<Payload>, String> {
    if case.fixture == "manual" {
        return Ok(Vec::new());
    }
    let templates = if case.fixture == "consecutive" {
        vec![
            case.html.clone(),
            case.html
                .replace("{{pictureA}}", "{{pictureB}}")
                .replace("width=160 height=96", "width=120 height=80"),
        ]
    } else {
        vec![case.html.clone()]
    };
    templates
        .into_iter()
        .map(|mut html| {
            let mut image_keys = Vec::new();
            // Match document order, rather than catalog asset order.
            let placeholders = regex::Regex::new(r"\{\{(\w+)\}\}").unwrap();
            for found in placeholders.captures_iter(&html) {
                let key = found[1].to_string();
                if !catalog()?.images.iter().any(|asset| asset.key == key) {
                    return Err(format!("Unknown Office fixture image: {key}"));
                }
                image_keys.push(key);
            }
            for key in &image_keys {
                html = html.replace(
                    &format!("{{{{{key}}}}}"),
                    &format!("data:image/png;base64,{}", STANDARD.encode(image(key)),),
                );
            }
            if image_keys.len() != case.expected_images {
                return Err(format!("{}: fixture image count mismatch", case.id));
            }
            Ok(Payload {
                text: case.plain_text.clone(),
                html,
                image_keys,
            })
        })
        .collect()
}

pub fn validate_preview(payload: &Payload, html: &str) -> Result<(), String> {
    let images = regex::Regex::new(r#"src\s*=\s*["']data:image/png;base64,([^"']+)["']"#).unwrap();
    let actual = images.captures_iter(html).collect::<Vec<_>>();
    if actual.len() != payload.image_keys.len() {
        return Err("Office preview image count mismatch".into());
    }
    for (encoded, key) in actual.iter().zip(&payload.image_keys) {
        let bytes = STANDARD
            .decode(&encoded[1])
            .map_err(|err| err.to_string())?;
        let actual = image::load_from_memory(&bytes)
            .map_err(|err| err.to_string())?
            .to_rgb8();
        let expected = image::load_from_memory(image(key))
            .map_err(|err| err.to_string())?
            .to_rgb8();
        let metadata = catalog()?
            .images
            .into_iter()
            .find(|asset| asset.key == *key)
            .unwrap();
        if actual.dimensions() != (metadata.width, metadata.height) {
            return Err(format!("Office picture dimensions differ: {key}"));
        }
        if actual != expected {
            return Err(format!("Office picture pixels differ: {key}"));
        }
    }
    if !payload.text.is_empty() && !html.contains("<table") && !html.contains("<p") {
        return Err("Office rich preview is missing".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    #[test]
    fn office_fixtures_are_decodable_and_documents_have_only_synthetic_metadata() {
        for asset in catalog().unwrap().images {
            let decoded = image::load_from_memory(image(&asset.key)).unwrap();
            assert_eq!(
                (decoded.width(), decoded.height()),
                (asset.width, asset.height)
            );
        }
        assert!(image("largePicture").len() > 256 * 1024);
        for (_, bytes) in documents() {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut xml = String::new();
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).unwrap();
                let name = entry.name().to_string();
                assert!(!name.contains("vbaProject") && !name.contains("externalLinks"));
                assert!(!name.contains("comments") && !name.contains("customXml"));
                if name.ends_with(".xml") || name.ends_with(".rels") {
                    let mut text = String::new();
                    entry.read_to_string(&mut text).unwrap();
                    assert!(!text.contains("TargetMode=\"External\""));
                    assert!(!text.contains("file://") && !text.contains("C:\\Users\\"));
                    assert!(!text.contains("<w:ins ") && !text.contains("<w:del "));
                    assert!(
                        !text.contains("state=\"hidden\"")
                            && !text.contains("state=\"veryHidden\"")
                    );
                    if name == "docProps/core.xml" {
                        assert!(text.contains("vPaste synthetic fixtures"));
                        assert!(!text.contains("lastModifiedBy>openpyxl"));
                    }
                    xml.push_str(&text);
                }
            }
            assert!(xml.contains("VPASTE_SYNTHETIC_OFFICE_V1"));
        }
    }
}
