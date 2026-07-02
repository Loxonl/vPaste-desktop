use std::f64::consts::PI;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f64,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct ColorVariant {
    pub format: String,
    pub value: String,
}

pub fn is_color(input: &str) -> bool {
    parse_color(input).is_some()
}

pub fn color_variants(input: &str) -> Vec<ColorVariant> {
    let Some(color) = parse_color(input) else {
        return Vec::new();
    };

    vec![
        ColorVariant {
            format: "HEX".to_string(),
            value: format_hex(&color),
        },
        ColorVariant {
            format: "RGB".to_string(),
            value: format_rgb(&color),
        },
        ColorVariant {
            format: "HSL".to_string(),
            value: format_hsl(&color),
        },
    ]
}

pub fn parse_color(input: &str) -> Option<ParsedColor> {
    let value = input.trim();
    if value.is_empty() || value.chars().any(char::is_whitespace) && !value.contains('(') {
        return None;
    }

    parse_hex(value)
        .or_else(|| parse_function_color(value))
        .or_else(|| parse_named_color(value))
}

fn parse_hex(value: &str) -> Option<ParsedColor> {
    let hex = value.strip_prefix('#')?;
    if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.chars().all(|char| char.is_ascii_hexdigit()) {
        return None;
    }

    let expanded = match hex.len() {
        3 | 4 => hex
            .chars()
            .flat_map(|char| [char, char])
            .collect::<String>(),
        _ => hex.to_string(),
    };

    let r = u8::from_str_radix(&expanded[0..2], 16).ok()?;
    let g = u8::from_str_radix(&expanded[2..4], 16).ok()?;
    let b = u8::from_str_radix(&expanded[4..6], 16).ok()?;
    let a = if expanded.len() == 8 {
        u8::from_str_radix(&expanded[6..8], 16).ok()? as f64 / 255.0
    } else {
        1.0
    };

    Some(ParsedColor { r, g, b, a })
}

fn parse_function_color(value: &str) -> Option<ParsedColor> {
    let open = value.find('(')?;
    let close = value.rfind(')')?;
    if close != value.len() - 1 || open == 0 {
        return None;
    }

    let name = value[..open].trim().to_ascii_lowercase();
    let inner = value[open + 1..close].trim();
    match name.as_str() {
        "rgb" | "rgba" => parse_rgb_function(inner),
        "hsl" | "hsla" => parse_hsl_function(inner),
        _ => None,
    }
}

fn parse_rgb_function(inner: &str) -> Option<ParsedColor> {
    let (components, alpha) = split_function_components(inner)?;
    if components.len() != 3 {
        return None;
    }

    Some(ParsedColor {
        r: parse_rgb_component(components[0])?,
        g: parse_rgb_component(components[1])?,
        b: parse_rgb_component(components[2])?,
        a: parse_optional_alpha(alpha)?,
    })
}

fn parse_hsl_function(inner: &str) -> Option<ParsedColor> {
    let (components, alpha) = split_function_components(inner)?;
    if components.len() != 3 {
        return None;
    }

    let h = parse_hue(components[0])?;
    let s = parse_percentage(components[1])?;
    let l = parse_percentage(components[2])?;
    let (r, g, b) = hsl_to_rgb(h, s / 100.0, l / 100.0);

    Some(ParsedColor {
        r,
        g,
        b,
        a: parse_optional_alpha(alpha)?,
    })
}

fn split_function_components(inner: &str) -> Option<(Vec<&str>, Option<&str>)> {
    if inner.contains(',') {
        let parts = inner.split(',').map(str::trim).collect::<Vec<_>>();
        if parts
            .iter()
            .any(|part| part.is_empty() || part.contains('/'))
        {
            return None;
        }
        return match parts.len() {
            3 => Some((parts, None)),
            4 => Some((parts[..3].to_vec(), Some(parts[3]))),
            _ => None,
        };
    }

    let slash_parts = inner.split('/').map(str::trim).collect::<Vec<_>>();
    if slash_parts.len() > 2 || slash_parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let components = slash_parts[0].split_whitespace().collect::<Vec<_>>();
    let alpha = slash_parts.get(1).copied();
    Some((components, alpha))
}

fn parse_rgb_component(value: &str) -> Option<u8> {
    if let Some(percent) = value.strip_suffix('%') {
        let percent = parse_f64(percent)?;
        if !(0.0..=100.0).contains(&percent) {
            return None;
        }
        return Some((percent * 255.0 / 100.0).round() as u8);
    }

    let number = parse_f64(value)?;
    if !(0.0..=255.0).contains(&number) {
        return None;
    }
    Some(number.round() as u8)
}

fn parse_alpha(value: &str) -> Option<f64> {
    if let Some(percent) = value.strip_suffix('%') {
        let percent = parse_f64(percent)?;
        if !(0.0..=100.0).contains(&percent) {
            return None;
        }
        return Some(percent / 100.0);
    }

    let alpha = parse_f64(value)?;
    if !(0.0..=1.0).contains(&alpha) {
        return None;
    }
    Some(alpha)
}

fn parse_optional_alpha(value: Option<&str>) -> Option<f64> {
    value.map(parse_alpha).unwrap_or(Some(1.0))
}

fn parse_hue(value: &str) -> Option<f64> {
    let (number, factor) = if let Some(value) = value.strip_suffix("deg") {
        (value, 1.0)
    } else if let Some(value) = value.strip_suffix("turn") {
        (value, 360.0)
    } else if let Some(value) = value.strip_suffix("rad") {
        (value, 180.0 / PI)
    } else if let Some(value) = value.strip_suffix("grad") {
        (value, 0.9)
    } else {
        (value, 1.0)
    };
    let hue = parse_f64(number)? * factor;
    Some(hue.rem_euclid(360.0))
}

fn parse_percentage(value: &str) -> Option<f64> {
    let percent = value.strip_suffix('%')?;
    let percent = parse_f64(percent)?;
    if !(0.0..=100.0).contains(&percent) {
        return None;
    }
    Some(percent)
}

fn parse_f64(value: &str) -> Option<f64> {
    let number = value.trim().parse::<f64>().ok()?;
    number.is_finite().then_some(number)
}

fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let hue_prime = hue / 60.0;
    let x = chroma * (1.0 - (hue_prime.rem_euclid(2.0) - 1.0).abs());
    let (r1, g1, b1) = match hue_prime as u8 {
        0 => (chroma, x, 0.0),
        1 => (x, chroma, 0.0),
        2 => (0.0, chroma, x),
        3 => (0.0, x, chroma),
        4 => (x, 0.0, chroma),
        _ => (chroma, 0.0, x),
    };
    let m = lightness - chroma / 2.0;
    (
        ((r1 + m) * 255.0).round() as u8,
        ((g1 + m) * 255.0).round() as u8,
        ((b1 + m) * 255.0).round() as u8,
    )
}

fn rgb_to_hsl(color: &ParsedColor) -> (f64, f64, f64) {
    let r = color.r as f64 / 255.0;
    let g = color.g as f64 / 255.0;
    let b = color.b as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let lightness = (max + min) / 2.0;

    if delta == 0.0 {
        return (0.0, 0.0, lightness * 100.0);
    }

    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs());
    let hue = if max == r {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };

    (hue, saturation * 100.0, lightness * 100.0)
}

fn format_hex(color: &ParsedColor) -> String {
    if is_opaque(color.a) {
        format!("#{:02X}{:02X}{:02X}", color.r, color.g, color.b)
    } else {
        format!(
            "#{:02X}{:02X}{:02X}{:02X}",
            color.r,
            color.g,
            color.b,
            (color.a * 255.0).round() as u8
        )
    }
}

fn format_rgb(color: &ParsedColor) -> String {
    if is_opaque(color.a) {
        format!("rgb({}, {}, {})", color.r, color.g, color.b)
    } else {
        format!(
            "rgba({}, {}, {}, {})",
            color.r,
            color.g,
            color.b,
            format_alpha(color.a)
        )
    }
}

fn format_hsl(color: &ParsedColor) -> String {
    let (h, s, l) = rgb_to_hsl(color);
    if is_opaque(color.a) {
        format!(
            "hsl({}, {}%, {}%)",
            format_number(h),
            format_number(s),
            format_number(l)
        )
    } else {
        format!(
            "hsla({}, {}%, {}%, {})",
            format_number(h),
            format_number(s),
            format_number(l),
            format_alpha(color.a)
        )
    }
}

fn format_alpha(alpha: f64) -> String {
    let rounded = (alpha * 1000.0).round() / 1000.0;
    if (rounded - rounded.round()).abs() < 0.0001 {
        return format!("{}", rounded.round() as i64);
    }
    format!("{rounded:.3}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn format_number(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if (rounded - rounded.round()).abs() < 0.0001 {
        format!("{}", rounded.round() as i64)
    } else {
        format!("{rounded:.1}")
    }
}

fn is_opaque(alpha: f64) -> bool {
    (alpha - 1.0).abs() < 0.0001
}

fn parse_named_color(value: &str) -> Option<ParsedColor> {
    let hex = match value.trim().to_ascii_lowercase().as_str() {
        "transparent" => {
            return Some(ParsedColor {
                r: 0,
                g: 0,
                b: 0,
                a: 0.0,
            })
        }
        "aliceblue" => "#F0F8FF",
        "antiquewhite" => "#FAEBD7",
        "aqua" => "#00FFFF",
        "aquamarine" => "#7FFFD4",
        "azure" => "#F0FFFF",
        "beige" => "#F5F5DC",
        "bisque" => "#FFE4C4",
        "black" => "#000000",
        "blanchedalmond" => "#FFEBCD",
        "blue" => "#0000FF",
        "blueviolet" => "#8A2BE2",
        "brown" => "#A52A2A",
        "burlywood" => "#DEB887",
        "cadetblue" => "#5F9EA0",
        "chartreuse" => "#7FFF00",
        "chocolate" => "#D2691E",
        "coral" => "#FF7F50",
        "cornflowerblue" => "#6495ED",
        "cornsilk" => "#FFF8DC",
        "crimson" => "#DC143C",
        "cyan" => "#00FFFF",
        "darkblue" => "#00008B",
        "darkcyan" => "#008B8B",
        "darkgoldenrod" => "#B8860B",
        "darkgray" => "#A9A9A9",
        "darkgreen" => "#006400",
        "darkgrey" => "#A9A9A9",
        "darkkhaki" => "#BDB76B",
        "darkmagenta" => "#8B008B",
        "darkolivegreen" => "#556B2F",
        "darkorange" => "#FF8C00",
        "darkorchid" => "#9932CC",
        "darkred" => "#8B0000",
        "darksalmon" => "#E9967A",
        "darkseagreen" => "#8FBC8F",
        "darkslateblue" => "#483D8B",
        "darkslategray" => "#2F4F4F",
        "darkslategrey" => "#2F4F4F",
        "darkturquoise" => "#00CED1",
        "darkviolet" => "#9400D3",
        "deeppink" => "#FF1493",
        "deepskyblue" => "#00BFFF",
        "dimgray" => "#696969",
        "dimgrey" => "#696969",
        "dodgerblue" => "#1E90FF",
        "firebrick" => "#B22222",
        "floralwhite" => "#FFFAF0",
        "forestgreen" => "#228B22",
        "fuchsia" => "#FF00FF",
        "gainsboro" => "#DCDCDC",
        "ghostwhite" => "#F8F8FF",
        "gold" => "#FFD700",
        "goldenrod" => "#DAA520",
        "gray" => "#808080",
        "green" => "#008000",
        "greenyellow" => "#ADFF2F",
        "grey" => "#808080",
        "honeydew" => "#F0FFF0",
        "hotpink" => "#FF69B4",
        "indianred" => "#CD5C5C",
        "indigo" => "#4B0082",
        "ivory" => "#FFFFF0",
        "khaki" => "#F0E68C",
        "lavender" => "#E6E6FA",
        "lavenderblush" => "#FFF0F5",
        "lawngreen" => "#7CFC00",
        "lemonchiffon" => "#FFFACD",
        "lightblue" => "#ADD8E6",
        "lightcoral" => "#F08080",
        "lightcyan" => "#E0FFFF",
        "lightgoldenrodyellow" => "#FAFAD2",
        "lightgray" => "#D3D3D3",
        "lightgreen" => "#90EE90",
        "lightgrey" => "#D3D3D3",
        "lightpink" => "#FFB6C1",
        "lightsalmon" => "#FFA07A",
        "lightseagreen" => "#20B2AA",
        "lightskyblue" => "#87CEFA",
        "lightslategray" => "#778899",
        "lightslategrey" => "#778899",
        "lightsteelblue" => "#B0C4DE",
        "lightyellow" => "#FFFFE0",
        "lime" => "#00FF00",
        "limegreen" => "#32CD32",
        "linen" => "#FAF0E6",
        "magenta" => "#FF00FF",
        "maroon" => "#800000",
        "mediumaquamarine" => "#66CDAA",
        "mediumblue" => "#0000CD",
        "mediumorchid" => "#BA55D3",
        "mediumpurple" => "#9370DB",
        "mediumseagreen" => "#3CB371",
        "mediumslateblue" => "#7B68EE",
        "mediumspringgreen" => "#00FA9A",
        "mediumturquoise" => "#48D1CC",
        "mediumvioletred" => "#C71585",
        "midnightblue" => "#191970",
        "mintcream" => "#F5FFFA",
        "mistyrose" => "#FFE4E1",
        "moccasin" => "#FFE4B5",
        "navajowhite" => "#FFDEAD",
        "navy" => "#000080",
        "oldlace" => "#FDF5E6",
        "olive" => "#808000",
        "olivedrab" => "#6B8E23",
        "orange" => "#FFA500",
        "orangered" => "#FF4500",
        "orchid" => "#DA70D6",
        "palegoldenrod" => "#EEE8AA",
        "palegreen" => "#98FB98",
        "paleturquoise" => "#AFEEEE",
        "palevioletred" => "#DB7093",
        "papayawhip" => "#FFEFD5",
        "peachpuff" => "#FFDAB9",
        "peru" => "#CD853F",
        "pink" => "#FFC0CB",
        "plum" => "#DDA0DD",
        "powderblue" => "#B0E0E6",
        "purple" => "#800080",
        "rebeccapurple" => "#663399",
        "red" => "#FF0000",
        "rosybrown" => "#BC8F8F",
        "royalblue" => "#4169E1",
        "saddlebrown" => "#8B4513",
        "salmon" => "#FA8072",
        "sandybrown" => "#F4A460",
        "seagreen" => "#2E8B57",
        "seashell" => "#FFF5EE",
        "sienna" => "#A0522D",
        "silver" => "#C0C0C0",
        "skyblue" => "#87CEEB",
        "slateblue" => "#6A5ACD",
        "slategray" => "#708090",
        "slategrey" => "#708090",
        "snow" => "#FFFAFA",
        "springgreen" => "#00FF7F",
        "steelblue" => "#4682B4",
        "tan" => "#D2B48C",
        "teal" => "#008080",
        "thistle" => "#D8BFD8",
        "tomato" => "#FF6347",
        "turquoise" => "#40E0D0",
        "violet" => "#EE82EE",
        "wheat" => "#F5DEB3",
        "white" => "#FFFFFF",
        "whitesmoke" => "#F5F5F5",
        "yellow" => "#FFFF00",
        "yellowgreen" => "#9ACD32",
        _ => return None,
    };
    parse_hex(hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::item::{convert_type, ItemType};

    #[test]
    fn parses_hex_color_forms() {
        assert_eq!(
            parse_color("#abc").unwrap(),
            ParsedColor {
                r: 170,
                g: 187,
                b: 204,
                a: 1.0
            }
        );
        assert_eq!(format_hex(&parse_color("#abcd").unwrap()), "#AABBCCDD");
        assert_eq!(
            format_rgb(&parse_color("#aabbcc80").unwrap()),
            "rgba(170, 187, 204, 0.502)"
        );
    }

    #[test]
    fn parses_rgb_color_forms() {
        assert_eq!(
            format_hex(&parse_color("rgb(255, 0, 128)").unwrap()),
            "#FF0080"
        );
        assert_eq!(
            format_hex(&parse_color("rgba(255, 0, 128, .5)").unwrap()),
            "#FF008080"
        );
        assert_eq!(
            format_hex(&parse_color("rgb(255 0 128 / 50%)").unwrap()),
            "#FF008080"
        );
        assert_eq!(
            format_rgb(&parse_color("rgb(100% 0% 50%)").unwrap()),
            "rgb(255, 0, 128)"
        );
    }

    #[test]
    fn parses_hsl_color_forms() {
        assert_eq!(
            format_rgb(&parse_color("hsl(120, 100%, 50%)").unwrap()),
            "rgb(0, 255, 0)"
        );
        assert_eq!(
            format_rgb(&parse_color("hsla(120, 100%, 50%, 0.5)").unwrap()),
            "rgba(0, 255, 0, 0.5)"
        );
        assert_eq!(
            format_hex(&parse_color("hsl(120 100% 50% / 50%)").unwrap()),
            "#00FF0080"
        );
    }

    #[test]
    fn parses_named_colors() {
        assert_eq!(
            format_hex(&parse_color("rebeccapurple").unwrap()),
            "#663399"
        );
        assert_eq!(
            format_rgb(&parse_color("transparent").unwrap()),
            "rgba(0, 0, 0, 0)"
        );
        assert!(parse_color("currentColor").is_none());
    }

    #[test]
    fn rejects_invalid_colors() {
        for value in [
            "#12",
            "#abcd12345",
            "rgb(999, 0, 0)",
            "rgb(255 0)",
            "hsl(120 50 50)",
            "hello red",
        ] {
            assert!(parse_color(value).is_none(), "{value} should not parse");
        }
    }

    #[test]
    fn returns_labeled_conversion_variants() {
        let variants = color_variants("#336699");
        assert_eq!(
            variants[0],
            ColorVariant {
                format: "HEX".to_string(),
                value: "#336699".to_string()
            }
        );
        assert_eq!(
            variants[1],
            ColorVariant {
                format: "RGB".to_string(),
                value: "rgb(51, 102, 153)".to_string()
            }
        );
        assert_eq!(
            variants[2],
            ColorVariant {
                format: "HSL".to_string(),
                value: "hsl(210, 50%, 40%)".to_string()
            }
        );
    }

    #[test]
    fn convert_type_uses_expanded_color_parser() {
        assert_eq!(convert_type("https://example.com"), ItemType::Link);
        assert_eq!(convert_type("#abcd"), ItemType::Color);
        assert_eq!(convert_type("rgb(255 0 128 / 50%)"), ItemType::Color);
        assert_eq!(convert_type("hsl(120 100% 50% / 50%)"), ItemType::Color);
        assert_eq!(convert_type("rebeccapurple"), ItemType::Color);
        assert_eq!(convert_type("hello red"), ItemType::Text);
    }
}
