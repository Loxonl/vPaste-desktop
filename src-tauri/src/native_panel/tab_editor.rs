//! Native editor data and targeted mutations of the existing tab stores.
use super::{current, dynamic_tabs, tab_target, TabTarget};
use crate::clipboard::{self, item::ItemTag};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;

#[cfg(test)]
mod tests;

// Serializes native editor saves, not other existing storage writers.
static SAVE: Mutex<()> = Mutex::new(());
const EMOJIS: &str = include_str!("../../../src/clipboard/name-prefix-emojis.json");
const INVALID: &str = "Invalid tab draft / 无效的标签内容";
const NAME: &str = "Enter a tab name / 请输入标签名称";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    name: String,
    filter: Option<Filter>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Filter {
    item_type: String,
    app_sources: Vec<String>,
    favorite: String,
    relative_amount: String,
    relative_unit: String,
}

impl Filter {
    fn from_stored(value: &Value) -> Self {
        let text = |key: &str, fallback: &str| value[key].as_str().unwrap_or(fallback).to_owned();
        let sources: Vec<&str> = match value["appSources"].as_array() {
            Some(values) => values.iter().filter_map(Value::as_str).collect(),
            None => value["appSource"].as_str().into_iter().collect(),
        };
        let mut app_sources = Vec::new();
        for source in sources.into_iter().map(str::trim).filter(|s| !s.is_empty()) {
            if !app_sources.iter().any(|existing| existing == source) {
                app_sources.push(source.to_owned());
            }
        }
        Self {
            item_type: text("itemType", ""),
            app_sources,
            favorite: text("favorite", "any"),
            relative_amount: match &value["relativeAmount"] {
                Value::Number(n) => n.to_string(),
                _ => text("relativeAmount", ""),
            },
            relative_unit: text("relativeUnit", "day"),
        }
    }

    fn normalized(self, old: &Self) -> Result<Self, String> {
        if !["", "Text", "Image", "File", "Link", "Color"].contains(&self.item_type.as_str())
            && self.item_type != old.item_type
            || !["any", "yes", "no"].contains(&self.favorite.as_str())
                && self.favorite != old.favorite
            || !["minute", "hour", "day", "week", "month"].contains(&self.relative_unit.as_str())
                && self.relative_unit != old.relative_unit
        {
            return Err(INVALID.into());
        }
        let amount = self.relative_amount.trim();
        if !amount.is_empty()
            && (amount != old.relative_amount.trim() || self.relative_unit != old.relative_unit)
            && !amount
                .parse::<u64>()
                .is_ok_and(|value| value > 0 && value <= 9_007_199_254_740_991)
        {
            return Err("Enter a positive whole number / 时间范围请输入正整数".into());
        }
        let mut sources = Vec::new();
        for value in self
            .app_sources
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if !sources.iter().any(|existing| existing == value) {
                sources.push(value.to_owned());
            }
        }
        Ok(Self {
            app_sources: sources,
            relative_amount: amount.to_owned(),
            ..self
        })
    }
}

fn validate_name<'a>(raw: &'a str, max: usize, previous: &str) -> Result<&'a str, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(NAME.into());
    }
    if (name.encode_utf16().count() > max && name != previous.trim()) || name.contains('\0') {
        return Err(INVALID.into());
    }
    Ok(name)
}

fn save_filter(tabs: &mut Vec<Value>, id: &str, draft: Draft) -> Result<String, String> {
    let existing = if id.is_empty() {
        None
    } else {
        if matches!(id, "all" | "favorite") || id.starts_with("record:") {
            return Err(INVALID.into());
        }
        Some(
            tabs.iter()
                .position(|tab| tab["id"] == id)
                .ok_or("Tab no longer exists / 标签已不存在")?,
        )
    };
    let old = existing.map(|i| &tabs[i]).unwrap_or(&Value::Null);
    // Generated names can be longer than the form's manual 20-unit limit.
    let name = validate_name(&draft.name, 1024, old["name"].as_str().unwrap_or(""))?;
    let filter = draft
        .filter
        .ok_or(INVALID)?
        .normalized(&Filter::from_stored(&old["filter"]))?;
    let legacy_source = filter.app_sources.first().cloned().unwrap_or_default();
    let mut fields = serde_json::to_value(filter).map_err(|err| err.to_string())?;
    fields["appSource"] = json!(legacy_source);
    if let Some(index) = existing {
        let mut updated = old.clone();
        updated["name"] = json!(name);
        let mut old_filter = updated["filter"].as_object().cloned().unwrap_or_default();
        old_filter.extend(fields.as_object().ok_or(INVALID)?.clone());
        updated["filter"] = Value::Object(old_filter);
        tabs[index] = updated;
        Ok(id.to_owned())
    } else {
        let id = loop {
            let candidate = format!("tab-{:016x}", rand::random::<u64>());
            if tabs.iter().all(|tab| tab["id"] != candidate) {
                break candidate;
            }
        };
        tabs.push(json!({"id":id,"name":name,"filter":fields}));
        Ok(id)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Saved {
    id: String,
    active_id: Option<String>,
    order_warning: bool,
}

fn save_record(
    id: &str,
    raw_name: &str,
    tags: &[ItemTag],
    create: impl FnOnce(&str) -> Result<ItemTag, String>,
    rename: impl FnOnce(i64, &str) -> Result<ItemTag, String>,
) -> Result<Saved, String> {
    let tag = if id.is_empty() {
        create(validate_name(raw_name, 20, "")?)?
    } else {
        let TabTarget::Record(tag) = tab_target(id, &Value::Null, tags)? else {
            return Err(INVALID.into());
        };
        rename(tag.id, validate_name(raw_name, 20, &tag.name)?)?
    };
    let id_out = format!("record:{}", tag.id);
    Ok(Saved {
        active_id: id.is_empty().then(|| id_out.clone()),
        id: id_out,
        order_warning: false,
    })
}

pub(super) fn load(kind: &str, id: &str) -> Result<Value, String> {
    let (kind, name, filter) = if id.is_empty() {
        (kind, String::new(), Value::Null)
    } else {
        let custom = crate::get_custom_tabs()?;
        let tags = clipboard::list_tags()?;
        match tab_target(id, &custom, &tags)? {
            TabTarget::Filter(tab) => (
                "filter",
                tab["name"].as_str().ok_or(INVALID)?.to_owned(),
                tab["filter"].clone(),
            ),
            TabTarget::Record(tag) => ("record", tag.name.clone(), Value::Null),
        }
    };
    let emojis: Vec<&str> = serde_json::from_str(EMOJIS).map_err(|err| err.to_string())?;
    match kind {
        "record" => Ok(json!({"kind":kind,"name":name,"emojis":emojis})),
        "filter" => {
            let (sources, unavailable) = match crate::list_recent_app_source_options(7) {
                Ok(options) => (options, false),
                Err(error) => {
                    log::warn!("Could not load tab editor source options: {error}");
                    (vec![], true)
                }
            };
            Ok(
                json!({"kind":kind,"name":name,"filter":Filter::from_stored(&filter),
                "sources":sources,"emojis":emojis,"sourcesUnavailable":unavailable}),
            )
        }
        _ => Err(INVALID.into()),
    }
}

pub(super) fn store_record(id: &str, name: &str, tags: &[ItemTag]) -> Result<Saved, String> {
    let saved = save_record(id, name, tags, clipboard::create_tag, clipboard::rename_tag)?;
    if !id.is_empty() {
        // Loaded history refs include tag names. Mark them stale before Swift
        // requests its post-save delta, without echoing an item-tags event.
        super::history::invalidate_record_tags();
    }
    Ok(saved)
}

pub(super) fn save(session: u64, kind: &str, id: &str, draft: Value) -> Result<Value, String> {
    let draft: Draft = serde_json::from_value(draft).map_err(|_| INVALID)?;
    let _guard = SAVE.lock().map_err(|err| err.to_string())?;
    if !current(session) {
        return Err("Tab editor is no longer open".into());
    }
    let mut custom = crate::get_custom_tabs()?;
    let tags = clipboard::list_tags()?;
    let mut saved = match kind {
        "record" if draft.filter.is_none() => store_record(id, &draft.name, &tags)?,
        "filter" => {
            let id = save_filter(custom.as_array_mut().ok_or(INVALID)?, id, draft)?;
            crate::save_custom_tabs(custom.clone())?;
            Saved {
                active_id: Some(id.clone()),
                id,
                order_warning: false,
            }
        }
        _ => return Err(INVALID.into()),
    };
    if id.is_empty() {
        let known_ids = dynamic_tabs(&custom, &tags, &[])
            .into_iter()
            .map(|tab| tab.id)
            .collect::<Vec<_>>();
        // Creation has committed. An order error must not send the user back to
        // retry Save and create a second tab.
        if let Err(error) =
            clipboard::db::append_tab_order(&clipboard::db::db(), &saved.id, &known_ids)
        {
            log::warn!("Could not save the new tab's position: {error}");
            saved.order_warning = true;
        }
    }
    serde_json::to_value(saved).map_err(|err| err.to_string())
}
