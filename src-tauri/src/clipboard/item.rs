use regex::Regex;
use strum_macros::EnumString;

use crate::clipboard::color;

#[derive(serde::Serialize, Debug)]
pub struct Page<T> {
    pub list: Vec<T>,
    pub consumed: u128,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    #[serde(rename = "nextId")]
    pub next_id: u64,
    #[serde(rename = "nextTime")]
    pub next_time: u64,
}

#[derive(serde::Serialize, Debug)]
pub struct Item {
    pub id: usize,
    pub content: String,
    #[serde(rename = "previewContent")]
    pub preview_content: String,
    #[serde(rename = "textContent")]
    pub text_content: String,
    #[serde(rename = "richHtml")]
    pub rich_html: String,
    #[serde(rename = "appSource")]
    pub app_source: String,
    #[serde(rename = "appIconPath")]
    pub app_icon_path: String,
    pub hash: String,
    #[serde(rename = "titleColor")]
    pub title_color: String,
    #[serde(rename = "itemType")]
    pub item_type: ItemType,
    pub time: u64,
    pub search_index: u8,
    pub label: u64,
    pub tags: Vec<ItemTag>,
}

#[derive(serde::Serialize, Debug, Clone)]
pub struct ItemTag {
    pub id: i64,
    pub name: String,
}

#[derive(serde::Serialize, strum_macros::Display, EnumString, Debug, PartialEq)]
pub enum ItemType {
    Text,
    TextFile,
    Color,
    Image,
    Link,
    File,
}

#[allow(dead_code)]
pub fn convert_type(content: &str) -> ItemType {
    let url_regex = Regex::new(r"^(http|https)://[^\s/$.?#].[^\s]*$").unwrap();
    if url_regex.is_match(content) {
        return ItemType::Link;
    }
    if color::is_color(content.trim()) {
        return ItemType::Color;
    }

    ItemType::Text
}
