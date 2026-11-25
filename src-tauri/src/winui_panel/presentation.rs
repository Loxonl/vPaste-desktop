//! WinUI display-only adaptation of the bounded shared native rich model.
use crate::{clipboard::color::ParsedColor, rich_card_assets::RichRenderPayload};
use serde_json::{json, Value};

pub(super) fn visual_type<'a>(item_type: &'a str, content: &str) -> &'a str {
    if item_type == "File" {
        let paths = crate::parse_file_clipboard_content(content).unwrap_or_default();
        if let [path] = paths.as_slice() {
            let extension = std::path::Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if crate::is_image_preview_extension(extension) {
                return "Image";
            }
        }
    }
    item_type
}

pub(super) fn is_rich_format(payload: &crate::history_views::HistoryCardPayload) -> bool {
    // Light cards deliberately omit drag HTML. Rendering failure must not
    // erase the stored format badge either.
    payload
        .rich_render
        .as_ref()
        .is_some_and(|render| !render.html.trim().is_empty())
        || crate::clipboard::rich_clipboard_meta(&payload.item.hash)
            .is_some_and(|meta| !meta.html_path.trim().is_empty())
}

pub(super) fn is_gif_format(item_type: &str, content: &str, preview: &str) -> bool {
    // Match itemPresentation.ts, including URI query/fragment suffixes.
    let gif = |path: &str| {
        let path = path.trim().to_ascii_lowercase();
        path.ends_with(".gif") || path.contains(".gif?") || path.contains(".gif#")
    };
    match item_type {
        "Image" => gif(content) || gif(preview),
        "File" => {
            let paths = crate::parse_file_clipboard_content(content).unwrap_or_default();
            paths.len() == 1 && gif(&paths[0])
        }
        _ => false,
    }
}

pub(super) fn media_details(
    metadata: &crate::image_preview::HistoryImageMetadata,
    source: &str,
) -> Value {
    let extension = std::path::Path::new(source)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    let format = if metadata.is_gif {
        "GIF"
    } else if [
        "PNG", "JPG", "JPEG", "WEBP", "BMP", "SVG", "TIFF", "TIF", "ICO", "AVIF", "HEIC", "HEIF",
        "JFIF",
    ]
    .contains(&extension.as_str())
    {
        extension.as_str()
    } else {
        ""
    };
    let mut value = serde_json::to_value(metadata).expect("image metadata is serializable");
    value["format"] = json!(format);
    value
}

pub(super) async fn resolve_image_card(
    preview: String,
    original: String,
    refresh: bool,
    width: u32,
) -> Result<(crate::media_resources::MediaResource, String), String> {
    use crate::media_resources::{resolve_for_card_width, MediaIntent};
    let path = if preview.is_empty() {
        original.clone()
    } else {
        preview
    };
    match resolve_for_card_width(path.clone(), MediaIntent::Card, refresh, width).await {
        Err(_) if !original.is_empty() && original != path => {
            resolve_for_card_width(original.clone(), MediaIntent::Card, refresh, width)
                .await
                .map(|media| (media, original))
        }
        result => result.map(|media| (media, path)),
    }
}

fn luminance(color: &ParsedColor) -> f64 {
    let linear = |value: u8| {
        let value = f64::from(value) / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

pub(super) fn rich_content(render: Option<&RichRenderPayload>) -> Value {
    let Some(render) = render else {
        return Value::Null;
    };
    // The converter serializes only strings, booleans and finite bounded sizes.
    let mut blocks = serde_json::to_value(super::rich_text::convert_for_windows(render))
        .expect("native rich projection is serializable");
    let mut dark = 0;
    let mut light = 0;
    for block in blocks.as_array_mut().expect("native blocks are an array") {
        let mut decorate = |run: &mut Value| {
            let foreground =
                crate::clipboard::color::parse_color(run["color"].as_str().unwrap_or(""));
            let background =
                crate::clipboard::color::parse_color(run["background"].as_str().unwrap_or(""));
            let weight = run["text"].as_str().unwrap_or("").trim().chars().count();
            // Copied opaque color pairs supply their own canvas. Otherwise use
            // the same contrast preference as the existing WebView reader.
            if !(foreground.is_some() && background.as_ref().is_some_and(|color| color.a >= 1.0)) {
                let prefers_dark = background
                    .as_ref()
                    .filter(|color| color.a >= 1.0)
                    .map(|color| luminance(color) < 0.179)
                    .unwrap_or_else(|| {
                        foreground
                            .as_ref()
                            .is_some_and(|color| luminance(color) > 0.179)
                    });
                if prefers_dark {
                    dark += weight
                } else {
                    light += weight
                }
            }
            run["foreground"] =
                super::native_color(run["color"].as_str().unwrap_or("")).unwrap_or(Value::Null);
            run["backgroundColor"] = super::native_color(run["background"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null);
        };
        if let Some(runs) = block["runs"].as_array_mut() {
            for run in runs {
                decorate(run);
            }
        }
        if let Some(rows) = block["rows"].as_array_mut() {
            for row in rows {
                for cell in row.as_array_mut().expect("native table row") {
                    for run in cell.as_array_mut().expect("native table cell") {
                        decorate(run);
                    }
                }
            }
        }
    }
    json!({"blocks": blocks, "darkCanvas": dark > light})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensionless_gif_card_uses_a_static_first_frame_even_with_a_missing_preview() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(directory.path().to_string_lossy().into_owned());
        let original = directory.path().join("0123456789abcdef");
        let file = std::fs::File::create(&original).unwrap();
        let mut encoder = image::codecs::gif::GifEncoder::new(file);
        for rgb in [[255, 0, 0, 255], [0, 0, 255, 255]] {
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                    4,
                    4,
                    image::Rgba(rgb),
                )))
                .unwrap();
        }
        drop(encoder);
        let bytes = std::fs::read(&original).unwrap();
        let path = original.to_str().unwrap();
        let missing = directory.path().join("missing.png");
        let previews = [path, "", missing.to_str().unwrap()];
        for preview in previews {
            let (media, loaded_path) = tauri::async_runtime::block_on(resolve_image_card(
                preview.to_string(),
                path.to_string(),
                false,
                240,
            ))
            .unwrap();
            assert_eq!(loaded_path, path);
            assert!(media.metadata.is_gif);
            let thumbnail = std::fs::read(&media.asset_path).unwrap();
            assert_eq!(
                image::guess_format(&thumbnail).unwrap(),
                image::ImageFormat::Png
            );
            assert_eq!(
                image::open(&media.asset_path)
                    .unwrap()
                    .to_rgba8()
                    .get_pixel(0, 0)
                    .0,
                [255, 0, 0, 255]
            );
        }
        assert_eq!(std::fs::read(&original).unwrap(), bytes);
        let animated = crate::media_resources::build(
            path,
            crate::media_resources::MediaIntent::Preview,
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read(animated.asset_path).unwrap(), bytes);
    }

    #[test]
    fn rich_badge_uses_the_actual_light_history_payload_without_generating_drag_html() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let _cleanup = crate::auto_cleanup::pause();
        let directory = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(directory.path().to_string_lossy().into_owned());
        crate::config::save(crate::config::Config::default());
        crate::clipboard::db::init();
        let rich = crate::clipboard::insert_rich_text_from_app(
            "Formatted native card".into(),
            Some(b"<p><b>Formatted native card</b></p>".to_vec()),
            None,
            None,
            "Native parity fixture",
            "",
        )
        .unwrap();
        let payload = crate::clipboard::history_card_payload(&rich, false).unwrap();
        assert!(
            payload.item.rich_html.is_empty(),
            "lightweight cards must not expand drag HTML"
        );
        assert!(payload.rich_render.is_some());
        assert!(
            is_rich_format(&payload),
            "real rich history needs its header badge"
        );
        let mut fallback = payload;
        fallback.rich_render = None;
        assert!(
            is_rich_format(&fallback),
            "plain render fallback retains the stored rich format"
        );
        let plain = crate::clipboard::insert_text_from_app(
            "Plain native card".into(),
            "Native parity fixture",
            "",
        )
        .unwrap();
        assert!(!is_rich_format(
            &crate::clipboard::history_card_payload(&plain, false).unwrap()
        ));
    }

    #[test]
    fn gif_header_follows_the_source_even_when_the_card_uses_a_static_thumbnail() {
        assert!(is_gif_format(
            "Image",
            r"C:\cache\animated.GIF",
            "thumb.png"
        ));
        assert!(is_gif_format("Image", "", "animated.gif"));
        assert!(is_gif_format("Image", "animated.gif?cached=1", ""));
        assert!(is_gif_format("Image", "animated.GIF#frame", ""));
        assert!(is_gif_format("File", r#"["C:\\animated.gif"]"#, ""));
        assert!(!is_gif_format("File", r#"["C:\\a.gif","C:\\b.png"]"#, ""));
        assert!(!is_gif_format("Image", "still.png", "thumb.png"));
        assert!(!is_gif_format("Text", "animated.gif", ""));
    }

    #[test]
    fn a_single_image_file_has_the_reference_image_header_without_changing_identity() {
        for extension in [
            "png", "JPG", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "svg",
        ] {
            assert_eq!(
                visual_type("File", &format!(r#"["C:\\photo.{extension}"]"#)),
                "Image"
            );
        }
        for content in [
            r#"["a.png","b.png"]"#,
            r#"["movie.mp4"]"#,
            r#"["a.png.txt"]"#,
            "invalid",
            "[]",
        ] {
            assert_eq!(visual_type("File", content), "File");
        }
        assert_eq!(visual_type("Text", "photo.png"), "Text");
    }

    #[test]
    fn media_details_preserve_dimensions_budget_flags_and_original_byte_size() {
        let metadata = crate::image_preview::HistoryImageMetadata {
            width: 24,
            height: 16,
            is_gif: true,
            source_bytes: 4096,
            preview_limited: true,
            animation_limited: true,
        };
        let details = media_details(&metadata, "image.bin");
        assert_eq!(details["width"], 24);
        assert_eq!(details["height"], 16);
        assert_eq!(details["sourceBytes"], 4096);
        assert_eq!(details["previewLimited"], true);
        assert_eq!(details["animationLimited"], true);
        assert_eq!(details["format"], "GIF");
        let ordinary = crate::image_preview::HistoryImageMetadata {
            is_gif: false,
            preview_limited: false,
            animation_limited: false,
            ..metadata
        };
        assert_eq!(media_details(&ordinary, "photo.WeBp")["format"], "WEBP");
        assert_eq!(media_details(&ordinary, "unknown.strange")["format"], "");
        assert_eq!(metadata.source_bytes, 4096);
    }
    use crate::rich_card_assets::RichImageResource;

    fn project(html: &str) -> Value {
        rich_content(Some(&RichRenderPayload {
            html: html.into(),
            resources: Vec::new(),
        }))
    }

    #[test]
    fn fixed_rich_samples_preserve_office_web_code_and_merged_table_information() {
        let office = project(include_str!("../../tests/fixtures/winui-rich/office.html"));
        let runs = office["blocks"][0]["runs"].as_array().unwrap();
        let title = runs
            .iter()
            .find(|r| r["text"] == "季度计划 Office😀")
            .unwrap();
        assert_eq!(title["foreground"], json!({"r":23,"g":54,"b":93,"a":255}));
        assert_eq!(title["bold"], true);
        assert_eq!(title["size"], 16.0);
        let text: String = runs.iter().filter_map(|r| r["text"].as_str()).collect();
        for marker in ["1. ", "2. ", "3. ", "  • "] {
            assert!(text.contains(marker), "{text}");
        }
        assert!(text.contains("2. 评审\n  • 确认结论\n"), "{text}");
        for html in [
            "<style>.x{color:red}.x{position:absolute}</style><span class='x'>Color</span>",
            "<style>.x{color:red}.x{color:}</style><span class='x'>Color</span>",
        ] {
            let repeated = project(html);
            assert_eq!(
                repeated["blocks"][0]["runs"][0]["foreground"],
                json!({"r":255,"g":0,"b":0,"a":255})
            );
        }

        let render = RichRenderPayload {
            html: include_str!("../../tests/fixtures/winui-rich/webpage.html").into(),
            resources: vec![RichImageResource {
                token: "trusted-small".into(),
                asset_path: r"C:\cache\small.png".into(),
                revision: "fixture".into(),
            }],
        };
        let original = render.html.clone();
        let web = rich_content(Some(&render));
        let runs = web["blocks"][0]["runs"].as_array().unwrap();
        let inline = runs.iter().find(|r| r["text"] == "Inline wins").unwrap();
        assert_eq!(inline["foreground"], json!({"r":17,"g":34,"b":51,"a":255}));
        assert_eq!(inline["bold"], true);
        assert!(runs
            .iter()
            .any(|r| r["text"] == "Revised" && r["strike"] == true && r["underline"] == true));
        let image = runs
            .iter()
            .find(|r| r["image"] == r"C:\cache\small.png")
            .unwrap();
        assert_eq!(image["imageWidth"], 16.0);
        assert_eq!(image["imageHeight"], 16.0);
        assert!(!web.to_string().contains("untrusted.png"));
        assert_eq!(render.html, original);
        let code = project(include_str!("../../tests/fixtures/winui-rich/code.html"));
        assert!(code["blocks"][0]["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["mono"] == true
                && r["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("\n    let label"))));
        let table = project(include_str!("../../tests/fixtures/winui-rich/table.html"));
        let merged = table["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["rows"].as_array().is_some_and(|rows| !rows.is_empty()))
            .unwrap();
        assert_eq!(merged["spans"][0][0]["columnSpan"], 2);
        assert_eq!(merged["spans"][1][0]["rowSpan"], 2);
        assert_eq!(merged["spans"][2][0]["column"], 1);
        assert!(table.to_string().contains("表前") && table.to_string().contains("表后"));
    }

    #[test]
    fn preserves_emphasis_tables_and_normalized_copied_colors() {
        let value = project("<b>粗体😀</b><i>斜体</i><u>下划线</u><code>code</code><span style='color:hsl(0,100%,50%);background-color:#ff0'>mark</span><table><tr><th>列</th><td>值</td></tr></table>");
        let runs = value["blocks"][0]["runs"].as_array().unwrap();
        assert!(runs[0]["bold"].as_bool().unwrap());
        assert_eq!(runs[0]["text"], "粗体😀");
        assert_eq!(runs[1]["italic"], true);
        assert_eq!(runs[2]["underline"], true);
        assert_eq!(runs[3]["mono"], true);
        assert_eq!(runs[4]["foreground"], json!({"r":255,"g":0,"b":0,"a":255}));
        assert_eq!(
            runs[4]["backgroundColor"],
            json!({"r":255,"g":255,"b":0,"a":255})
        );
        assert_eq!(value["blocks"][1]["rows"][0][0][0]["text"], "列");
        assert_eq!(value["blocks"][1]["rows"][0][1][0]["text"], "值");
    }

    #[test]
    fn source_canvas_is_not_forced_to_follow_the_application_theme() {
        assert_eq!(
            project("<span style='color:white'>light text</span>")["darkCanvas"],
            true
        );
        assert_eq!(
            project("<span style='color:black'>dark text</span>")["darkCanvas"],
            false
        );
        assert_eq!(
            project("<span style='color:white;background-color:black'>paired</span>")["darkCanvas"],
            false
        );
        assert_eq!(
            project("<span style='background-color:#222'>inherited text</span>")["darkCanvas"],
            true
        );
        assert_eq!(
            project("<span style='color:white'>x</span>mostly default text")["darkCanvas"],
            false
        );
        assert!(rich_content(None).is_null());
    }

    #[test]
    fn only_trusted_cached_images_are_projected_and_input_is_untouched() {
        let render = RichRenderPayload {
            html: "<script>no()</script><img src='https://remote/x'><img src='cached-token'>"
                .into(),
            resources: vec![RichImageResource {
                token: "cached-token".into(),
                asset_path: r"C:\cache\image #1.png".into(),
                revision: "test".into(),
            }],
        };
        let value = rich_content(Some(&render));
        assert_eq!(value["blocks"][0]["runs"].as_array().unwrap().len(), 1);
        assert_eq!(
            value["blocks"][0]["runs"][0]["image"],
            r"C:\cache\image #1.png"
        );
        assert!(render.html.contains("https://remote/x"));
        assert!(!value.to_string().contains("no()"));
    }
}
