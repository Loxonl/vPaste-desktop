//! Bounded native display model. Original HTML/RTF stays in Rust for actions.
//! Does not invoke WebKit or NSAttributedString's HTML importer.
use crate::rich_card_assets::RichRenderPayload;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Run {
    text: String,
    bold: bool,
    italic: bool,
    underline: bool,
    mono: bool,
    color: String,
    background: String,
    size: f64,
    image: String,
    #[serde(skip_serializing_if = "is_false")]
    strike: bool,
    #[serde(skip_serializing_if = "is_zero")]
    image_width: f64,
    #[serde(skip_serializing_if = "is_zero")]
    image_height: f64,
}
fn is_zero(value: &f64) -> bool {
    *value == 0.0
}
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CellSpan {
    column: usize,
    column_span: usize,
    row_span: usize,
}
#[derive(Default, Serialize)]
pub(super) struct Block {
    runs: Vec<Run>,
    rows: Vec<Vec<Vec<Run>>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    spans: Vec<Vec<CellSpan>>,
}
struct Budget {
    chars: usize,
    runs: usize,
    windows: bool,
    class_styles: HashMap<String, Vec<(String, String)>>,
}
fn declarations(css: &str) -> Vec<(String, String)> {
    css.split(';')
        .filter_map(|part| part.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}
fn class_styles(document: &Html) -> HashMap<String, Vec<(String, String)>> {
    static RULE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}").unwrap());
    let mut result = HashMap::new();
    for style in document.select(&Selector::parse("style").unwrap()).take(16) {
        let css: String = style
            .text()
            .collect::<String>()
            .chars()
            .take(65_536)
            .collect();
        for captures in RULE.captures_iter(&css).take(128 - result.len()) {
            let rules: Vec<_> = declarations(&captures[2])
                .into_iter()
                .filter(|(key, value)| {
                    let lower = value.to_ascii_lowercase();
                    matches!(
                        key.as_str(),
                        "color"
                            | "background"
                            | "background-color"
                            | "font-weight"
                            | "font-style"
                            | "text-decoration"
                    ) && !value.is_empty()
                        && value.len() <= 2048
                        && !["url", "expression", "@import", "\\", "/*"]
                            .iter()
                            .any(|word| lower.contains(word))
                })
                .collect();
            if !rules.is_empty() {
                result.insert(captures[1].to_string(), rules);
            }
        }
        if result.len() >= 128 {
            break;
        }
    }
    result
}
fn add(runs: &mut Vec<Run>, mut run: Run, budget: &mut Budget) {
    if budget.chars >= 16_384 || budget.runs >= 512 {
        return;
    }
    run.text = run.text.chars().take(16_384 - budget.chars).collect();
    budget.chars += run.text.chars().count();
    budget.runs += 1;
    runs.push(run);
}
fn styled(el: ElementRef<'_>, style: &Run, budget: &Budget) -> Run {
    let name = el.value().name();
    let mut style = style.clone();
    style.bold |= matches!(name, "b" | "strong" | "th" | "h1" | "h2" | "h3");
    style.italic |= matches!(name, "i" | "em");
    style.underline |= matches!(name, "u" | "a");
    style.mono |= matches!(name, "code" | "pre");
    if matches!(name, "h1" | "h2" | "h3") {
        style.size = 20.0;
    }
    let mut rules = declarations(el.value().attr("style").unwrap_or(""));
    if budget.windows {
        // Match the WebView sanitizer: inline declarations win; the first
        // selected class supplying an absent property wins over later classes.
        let mut seen: HashSet<String> = rules.iter().map(|(key, _)| key.clone()).collect();
        for class in el.value().classes() {
            for (key, value) in budget.class_styles.get(class).into_iter().flatten() {
                if seen.insert(key.clone()) {
                    rules.push((key.clone(), value.clone()));
                }
            }
        }
    }
    for (key, value) in rules {
        match key.as_str() {
            "color" => style.color = value.to_string(),
            "background-color" => style.background = value.to_string(),
            "background"
                if budget.windows && crate::clipboard::color::parse_color(&value).is_some() =>
            {
                style.background = value
            }
            "font-weight" => {
                let bold = value == "bold" || value.parse::<u16>().is_ok_and(|v| v >= 600);
                if budget.windows {
                    style.bold = bold;
                } else {
                    style.bold |= bold;
                }
            }
            "font-style" => {
                if budget.windows {
                    style.italic = value == "italic";
                } else {
                    style.italic |= value == "italic";
                }
            }
            "text-decoration" if budget.windows => {
                style.underline = value.contains("underline");
                style.strike = value.contains("line-through");
            }
            "font-size" => {
                style.size = value
                    .trim_end_matches("px")
                    .trim_end_matches("pt")
                    .parse::<f64>()
                    .ok()
                    .filter(|size| size.is_finite())
                    .unwrap_or(14.0)
                    .mul_add(
                        if budget.windows && value.ends_with("pt") {
                            4.0 / 3.0
                        } else {
                            1.0
                        },
                        0.0,
                    )
                    .clamp(10.0, 26.0)
            }
            _ => {}
        }
    }
    style
}
fn walk(
    el: ElementRef<'_>,
    style: &Run,
    runs: &mut Vec<Run>,
    budget: &mut Budget,
    render: &RichRenderPayload,
    depth: usize,
) {
    if depth > 32 || budget.runs >= 512 || (budget.windows && budget.chars >= 16_384) {
        return;
    }
    let name = el.value().name();
    if matches!(
        name,
        "script" | "style" | "iframe" | "object" | "svg" | "video"
    ) {
        return;
    }
    let mut style = styled(el, style, budget);
    if name == "img" {
        if let Some(resource) = el
            .value()
            .attr("src")
            .and_then(|src| render.resources.iter().find(|r| r.token == src))
        {
            style.image = resource.asset_path.clone();
            style.text = String::new();
            if budget.windows {
                let rules = declarations(el.value().attr("style").unwrap_or(""));
                let dimension = |name: &str, max: f64| {
                    rules
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value.as_str())
                        .or_else(|| el.value().attr(name))
                        .and_then(|v| v.trim().trim_end_matches("px").parse::<f64>().ok())
                        .filter(|v| v.is_finite() && *v > 0.0)
                        .map(|v| v.min(max))
                        .unwrap_or(0.0)
                };
                style.image_width = dimension("width", 188.0);
                style.image_height = dimension("height", 100.0);
                if style.image_width <= 32.0
                    && style.image_height <= 32.0
                    && el
                        .ancestors()
                        .filter_map(ElementRef::wrap)
                        .any(|p| matches!(p.value().name(), "p" | "li"))
                {
                    style.image_width = 13.0;
                    style.image_height = 13.0;
                }
            }
            add(runs, style, budget);
        }
        return;
    }
    if name == "li" {
        let mut r = style.clone();
        r.text = if budget.windows {
            let depth = el
                .ancestors()
                .filter_map(ElementRef::wrap)
                .filter(|p| matches!(p.value().name(), "ul" | "ol"))
                .count()
                .saturating_sub(1)
                .min(16);
            let number = el
                .prev_siblings()
                .filter_map(ElementRef::wrap)
                .filter(|p| p.value().name() == "li")
                .take(512)
                .count()
                + 1;
            let ordered = el
                .parent()
                .and_then(ElementRef::wrap)
                .is_some_and(|p| p.value().name() == "ol");
            format!(
                "{}{}",
                "  ".repeat(depth),
                if ordered {
                    format!("{number}. ")
                } else {
                    "• ".into()
                }
            )
        } else {
            "• ".into()
        };
        add(runs, r, budget);
    }
    if budget.windows
        && matches!(name, "ul" | "ol")
        && runs.last().is_some_and(|run| !run.text.ends_with('\n'))
    {
        let mut line = style.clone();
        line.text = "\n".into();
        add(runs, line, budget);
    }
    if name == "br" {
        let mut r = style.clone();
        r.text = "\n".into();
        add(runs, r, budget);
        return;
    }
    for child in el.children() {
        if budget.windows && (budget.runs >= 512 || budget.chars >= 16_384) {
            break;
        }
        match child.value() {
            Node::Text(text) => {
                let mut r = style.clone();
                r.text = text.text.to_string();
                add(runs, r, budget);
            }
            Node::Element(_) => {
                if let Some(child) = ElementRef::wrap(child) {
                    walk(child, &style, runs, budget, render, depth + 1)
                }
            }
            _ => {}
        }
    }
    if matches!(name, "p" | "div" | "li" | "pre" | "h1" | "h2" | "h3" | "tr") {
        let mut r = style;
        r.text = "\n".into();
        add(runs, r, budget);
    }
}
fn blocks(
    el: ElementRef<'_>,
    style: &Run,
    pending: &mut Vec<Run>,
    result: &mut Vec<Block>,
    budget: &mut Budget,
    render: &RichRenderPayload,
    depth: usize,
) {
    if depth > 32 || budget.runs >= 512 || budget.chars >= 16_384 {
        return;
    }
    let name = el.value().name();
    if matches!(
        name,
        "script" | "style" | "iframe" | "object" | "svg" | "video"
    ) {
        return;
    }
    let table_selector = Selector::parse("table").unwrap();
    if name == "table" {
        if !pending.is_empty() {
            result.push(Block {
                runs: std::mem::take(pending),
                rows: Vec::new(),
                spans: Vec::new(),
            });
        }
        let mut table = Block::default();
        let inherited = styled(el, style, budget);
        let mut occupied = [[false; 12]; 24];
        for (row_index, row) in el
            .select(&Selector::parse("tr").unwrap())
            .filter(|row| {
                row.ancestors()
                    .filter_map(ElementRef::wrap)
                    .find(|parent| parent.value().name() == "table")
                    .is_some_and(|parent| parent.id() == el.id())
            })
            .take(24)
            .enumerate()
        {
            let mut cells = Vec::new();
            let mut spans = Vec::new();
            let mut column = 0;
            for cell in row
                .children()
                .filter_map(ElementRef::wrap)
                .filter(|cell| matches!(cell.value().name(), "td" | "th"))
                .take(12)
            {
                if budget.windows {
                    while column < 12 && occupied[row_index][column] {
                        column += 1;
                    }
                    if column == 12 {
                        break;
                    }
                    let span = |name: &str, max: usize| {
                        cell.value()
                            .attr(name)
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(1)
                            .clamp(1, max)
                    };
                    let free = occupied[row_index][column..]
                        .iter()
                        .take_while(|used| !**used)
                        .count();
                    let column_span = span("colspan", free);
                    let row_span = span("rowspan", 24 - row_index);
                    for line in occupied.iter_mut().skip(row_index).take(row_span) {
                        for used in line.iter_mut().skip(column).take(column_span) {
                            *used = true;
                        }
                    }
                    spans.push(CellSpan {
                        column,
                        column_span,
                        row_span,
                    });
                    column += column_span;
                }
                let mut runs = Vec::new();
                walk(cell, &inherited, &mut runs, budget, render, depth + 1);
                cells.push(runs);
            }
            if budget.windows {
                table.spans.push(spans);
            }
            if !cells.is_empty() || budget.windows {
                table.rows.push(cells);
            }
        }
        if !table.rows.is_empty() {
            result.push(table);
        }
    } else if el.select(&table_selector).next().is_none() {
        walk(el, style, pending, budget, render, depth);
    } else {
        let inherited = styled(el, style, budget);
        for child in el.children() {
            match child.value() {
                Node::Text(text) => {
                    let mut run = inherited.clone();
                    run.text = text.text.to_string();
                    add(pending, run, budget);
                }
                Node::Element(_) => {
                    if let Some(child) = ElementRef::wrap(child) {
                        blocks(
                            child,
                            &inherited,
                            pending,
                            result,
                            budget,
                            render,
                            depth + 1,
                        );
                    }
                }
                _ => {}
            }
        }
    }
}

pub(super) fn convert(render: &RichRenderPayload) -> Vec<Block> {
    convert_impl(render, false)
}

pub(super) fn convert_for_windows(render: &RichRenderPayload) -> Vec<Block> {
    convert_impl(render, true)
}

fn convert_impl(render: &RichRenderPayload, windows: bool) -> Vec<Block> {
    let document = Html::parse_fragment(&render.html);
    let mut budget = Budget {
        chars: 0,
        runs: 0,
        windows,
        class_styles: if windows {
            class_styles(&document)
        } else {
            HashMap::new()
        },
    };
    let mut result = Vec::new();
    let mut runs = Vec::new();
    blocks(
        document.root_element(),
        &Run::default(),
        &mut runs,
        &mut result,
        &mut budget,
        render,
        0,
    );
    if !runs.is_empty() {
        result.push(Block {
            runs,
            rows: Vec::new(),
            spans: Vec::new(),
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_do_not_drop_surrounding_text_or_later_tables() {
        let render = RichRenderPayload {
            html: "<p>前文</p><table><tr><td>甲</td></tr></table><p>中间</p><table><tr><td>乙</td></tr></table><p>结尾</p>".into(),
            resources: Vec::new(),
        };
        let blocks = convert(&render);
        let text: String = blocks
            .iter()
            .flat_map(|b| b.runs.iter().chain(b.rows.iter().flatten().flatten()))
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(blocks.iter().filter(|b| !b.rows.is_empty()).count(), 2);
        for expected in ["前文", "甲", "中间", "乙", "结尾"] {
            assert!(text.contains(expected));
        }
    }

    #[test]
    fn display_projection_is_bounded_and_does_not_include_scripts() {
        let render = RichRenderPayload {
            html: format!("<script>bad()</script><p>{}</p>", "字".repeat(20_000)),
            resources: Vec::new(),
        };
        let blocks = convert(&render);
        let text: String = blocks
            .iter()
            .flat_map(|b| &b.runs)
            .map(|r| r.text.as_str())
            .collect();
        assert!(text.chars().count() <= 16_384);
        assert!(!text.contains("bad()"));
    }

    #[test]
    fn windows_projection_keeps_the_existing_mac_contract_and_resource_limits() {
        let render = RichRenderPayload { html: "<style>.x{font-weight:bold;color:red}</style><p class='x' style='font-size:12pt'>Legacy</p><ol><li>Item</li></ol><table><tr><td colspan='2'>Cell</td></tr></table>".into(), resources: vec![] };
        let legacy = serde_json::to_value(convert(&render)).unwrap();
        let runs = legacy[0]["runs"].as_array().unwrap();
        assert_eq!(runs[0]["text"], "Legacy");
        assert_eq!(runs[0]["size"], 12.0);
        assert_eq!(runs[0]["bold"], false);
        assert_eq!(runs[0]["color"], "");
        assert!(runs.iter().any(|r| r["text"] == "• "));
        assert!(!legacy.to_string().contains("spans"));
        assert!(!legacy.to_string().contains("strike"));
        let large = RichRenderPayload {
            html: format!(
                "<style>.x{{color:red}}</style><p class='x'>{}</p>",
                "字".repeat(20_000)
            ),
            resources: vec![],
        };
        let projected = convert_for_windows(&large);
        assert!(
            projected
                .iter()
                .flat_map(|b| &b.runs)
                .map(|r| r.text.chars().count())
                .sum::<usize>()
                <= 16_384
        );
        assert!(projected.iter().flat_map(|b| &b.runs).count() <= 512);
    }
}
