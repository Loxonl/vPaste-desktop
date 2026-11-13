//! WinUI display-only adaptation of the bounded shared native rich model.
use crate::{clipboard::color::ParsedColor, rich_card_assets::RichRenderPayload};
use serde_json::{json, Value};

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
    let mut blocks = serde_json::to_value(super::rich_text::convert(render))
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
