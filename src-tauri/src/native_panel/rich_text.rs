//! Bounded native display model. Original HTML/RTF stays in Rust for actions.
//! Does not invoke WebKit or NSAttributedString's HTML importer.
use crate::rich_card_assets::RichRenderPayload;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;

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
}
#[derive(Default, Serialize)]
pub(super) struct Block {
    runs: Vec<Run>,
    rows: Vec<Vec<Vec<Run>>>,
}
struct Budget {
    chars: usize,
    runs: usize,
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
fn styled(el: ElementRef<'_>, style: &Run) -> Run {
    let name = el.value().name();
    let mut style = style.clone();
    style.bold |= matches!(name, "b" | "strong" | "th" | "h1" | "h2" | "h3");
    style.italic |= matches!(name, "i" | "em");
    style.underline |= matches!(name, "u" | "a");
    style.mono |= matches!(name, "code" | "pre");
    if matches!(name, "h1" | "h2" | "h3") {
        style.size = 20.0;
    }
    for part in el.value().attr("style").unwrap_or("").split(';') {
        if let Some((key, value)) = part.split_once(':') {
            let value = value.trim();
            match key.trim().to_ascii_lowercase().as_str() {
                "color" => style.color = value.to_string(),
                "background-color" => style.background = value.to_string(),
                "font-weight" => {
                    style.bold |= value == "bold" || value.parse::<u16>().is_ok_and(|v| v >= 600)
                }
                "font-style" => style.italic |= value == "italic",
                "font-size" => {
                    style.size = value
                        .trim_end_matches("px")
                        .trim_end_matches("pt")
                        .parse::<f64>()
                        .ok()
                        .filter(|size| size.is_finite())
                        .unwrap_or(14.0)
                        .clamp(10.0, 26.0)
                }
                _ => {}
            }
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
    if depth > 32 || budget.runs >= 512 {
        return;
    }
    let name = el.value().name();
    if matches!(
        name,
        "script" | "style" | "iframe" | "object" | "svg" | "video"
    ) {
        return;
    }
    let mut style = styled(el, style);
    if name == "img" {
        if let Some(resource) = el
            .value()
            .attr("src")
            .and_then(|src| render.resources.iter().find(|r| r.token == src))
        {
            style.image = resource.asset_path.clone();
            style.text = String::new();
            add(runs, style, budget);
        }
        return;
    }
    if name == "li" {
        let mut r = style.clone();
        r.text = "• ".into();
        add(runs, r, budget);
    }
    if name == "br" {
        let mut r = style.clone();
        r.text = "\n".into();
        add(runs, r, budget);
        return;
    }
    for child in el.children() {
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
            });
        }
        let mut table = Block::default();
        let inherited = styled(el, style);
        for row in el
            .select(&Selector::parse("tr").unwrap())
            .filter(|row| {
                row.ancestors()
                    .filter_map(ElementRef::wrap)
                    .find(|parent| parent.value().name() == "table")
                    .is_some_and(|parent| parent.id() == el.id())
            })
            .take(24)
        {
            let mut cells = Vec::new();
            for cell in row
                .children()
                .filter_map(ElementRef::wrap)
                .filter(|cell| matches!(cell.value().name(), "td" | "th"))
                .take(12)
            {
                let mut runs = Vec::new();
                walk(cell, &inherited, &mut runs, budget, render, depth + 1);
                cells.push(runs);
            }
            if !cells.is_empty() {
                table.rows.push(cells);
            }
        }
        if !table.rows.is_empty() {
            result.push(table);
        }
    } else if el.select(&table_selector).next().is_none() {
        walk(el, style, pending, budget, render, depth);
    } else {
        let inherited = styled(el, style);
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
    let document = Html::parse_fragment(&render.html);
    let mut budget = Budget { chars: 0, runs: 0 };
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
}
