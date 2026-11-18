//! Native presentation of the existing custom-tab file, not a second store.
use serde_json::{json, Value};
use std::sync::Mutex;

static STORE_ACCESS: Mutex<()> = Mutex::new(());

fn label_for_tab(tab: &Value, tag_name: &str) -> Result<String, String> {
    let filter = &tab["filter"];
    let mut values = json!({"mode":"custom"});
    if let Some(item_type) = filter["itemType"].as_str().filter(|s| !s.is_empty()) {
        values["item_type"] = json!(item_type);
    }
    // Match normalizeAppSources in customTabs.ts: an explicit empty array wins
    // over the legacy single source. Never turn an intentional 'Any' into it.
    let sources: Vec<&str> = match filter["appSources"].as_array() {
        Some(sources) => sources.iter().filter_map(Value::as_str).collect(),
        None => filter["appSource"].as_str().into_iter().collect(),
    };
    let sources: Vec<_> = sources
        .into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if !sources.is_empty() {
        values["app_sources"] = json!(sources);
    }
    match filter["favorite"].as_str() {
        Some("yes") => values["favorite"] = json!(true),
        Some("no") => values["favorite"] = json!(false),
        _ => {}
    }
    if let Some(amount) = filter["relativeAmount"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
    {
        values["relative_amount"] = json!(amount);
        values["relative_unit"] = json!(filter["relativeUnit"].as_str().unwrap_or("day"));
    }
    if !tag_name.is_empty() {
        values["tag_name"] = json!(tag_name);
    }
    Ok(format!("__filter:{values}"))
}

fn apply_change(mut stored: Value, request: &Value) -> Result<Value, String> {
    let tabs = stored.as_array_mut().ok_or("Invalid stored filter tabs")?;
    if request["op"] == "filtersDelete" {
        let id = request["tabId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing filter ID")?;
        let index = tabs
            .iter()
            .position(|tab| tab["id"] == id)
            .ok_or("Filter no longer exists / 筛选标签已不存在")?;
        tabs.remove(index);
        return Ok(stored);
    }
    if request["op"] != "filtersSave" {
        return Err("Unknown filter operation".into());
    }
    let draft = &request["tab"];
    let id = draft["id"].as_str().unwrap_or("");
    let name = draft["name"].as_str().unwrap_or("").trim();
    let unchanged_name = !id.is_empty()
        && tabs
            .iter()
            .any(|tab| tab["id"] == id && tab["name"].as_str().map(str::trim) == Some(name));
    if name.is_empty() || (name.encode_utf16().count() > 20 && !unchanged_name) {
        return Err("Use a name of 1–20 characters / 名称应为 1–20 个字符".into());
    }
    let filter = draft["filter"]
        .as_object()
        .ok_or("Invalid filter conditions")?;
    let item_type = filter.get("itemType").and_then(Value::as_str).unwrap_or("");
    if !["", "Text", "Image", "File", "Link", "Color"].contains(&item_type) {
        return Err("Invalid content type / 无效的内容类型".into());
    }
    if let Some(amount) = filter
        .get("relativeAmount")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if amount.parse::<u64>().ok().filter(|n| *n > 0).is_none() {
            return Err("Use a positive whole number / 时间范围请输入正整数".into());
        }
    }
    if !["any", "yes", "no"].contains(
        &filter
            .get("favorite")
            .and_then(Value::as_str)
            .unwrap_or("any"),
    ) || !["minute", "hour", "day", "week", "month"].contains(
        &filter
            .get("relativeUnit")
            .and_then(Value::as_str)
            .unwrap_or("day"),
    ) {
        return Err("Invalid filter conditions / 无效的筛选条件".into());
    }
    if let Some(sources) = filter.get("appSources") {
        if sources
            .as_array()
            .is_none_or(|items| items.iter().any(|s| !s.is_string()))
        {
            return Err("Invalid source applications".into());
        }
    }
    if id.is_empty() {
        let mut created = draft.clone();
        created["id"] = json!(format!("custom-{:016x}", rand::random::<u64>()));
        created["name"] = json!(name);
        tabs.push(created);
    } else {
        let current = tabs
            .iter_mut()
            .find(|tab| tab["id"] == id)
            .ok_or("Filter no longer exists / 筛选标签已不存在")?;
        current["name"] = json!(name);
        if !current["filter"].is_object() {
            current["filter"] = json!({});
        }
        for (key, value) in filter {
            current["filter"][key] = value.clone();
        }
    }
    Ok(stored)
}

pub(super) fn history_label(id: &str, tag_name: &str) -> Result<String, String> {
    let _guard = STORE_ACCESS.lock().map_err(|e| e.to_string())?;
    let tabs = crate::get_custom_tabs()?;
    let tab = tabs
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"] == id))
        .ok_or("Filter no longer exists / 筛选标签已不存在")?;
    label_for_tab(tab, tag_name)
}

fn change_with_store(
    request: &Value,
    read: impl FnOnce() -> Result<Value, String>,
    write: impl FnOnce(Value) -> Result<(), String>,
) -> Result<Value, String> {
    let next = apply_change(read()?, request)?;
    write(next.clone())?;
    Ok(next)
}

pub(super) async fn dispatch(operation: String, payload: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if operation == "filterSources" {
            return crate::list_recent_app_source_options(7)
                .map(|sources| json!({"sources":sources}));
        }
        let _guard = STORE_ACCESS.lock().map_err(|e| e.to_string())?;
        let items = if operation == "filtersList" {
            crate::get_custom_tabs()?
        } else {
            change_with_store(&payload, crate::get_custom_tabs, crate::save_custom_tabs)?
        };
        Ok(json!({"items":items}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab() -> Value {
        json!({"id":"custom-1", "name":"Work", "extra":"keep",
            "filter":{"itemType":"Text", "appSource":"Legacy", "appSources":["Code", "Terminal"],
                "favorite":"no", "relativeAmount":"2", "relativeUnit":"week", "future":"keep"}})
    }

    #[test]
    fn projection_matches_webview_conditions_and_record_tag_composition() {
        let label = label_for_tab(&tab(), "研究 \"A\"").unwrap();
        let value: Value = serde_json::from_str(label.strip_prefix("__filter:").unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"mode":"custom", "item_type":"Text", "app_sources":["Code", "Terminal"],
            "favorite":false, "relative_amount":2, "relative_unit":"week", "tag_name":"研究 \"A\""})
        );
        let legacy = json!({"filter":{"appSource":"Code"}});
        assert!(label_for_tab(&legacy, "").unwrap().contains("Code"));
        let empty = json!({"filter":{"appSources":[], "appSource":"Legacy", "relativeAmount":"0"}});
        assert_eq!(
            label_for_tab(&empty, "").unwrap(),
            "__filter:{\"mode\":\"custom\"}"
        );
    }

    #[test]
    fn update_preserves_other_tabs_unknown_fields_and_existing_order() {
        let other = json!({"id":"other", "name":"Untouched", "future":42});
        let stored = json!([other.clone(), tab()]);
        let request = json!({"op":"filtersSave", "tab":{"id":"custom-1", "name":" Renamed ",
            "filter":{"itemType":"Image", "appSources":[], "favorite":"any", "relativeAmount":"", "relativeUnit":"day"}}});
        let next = apply_change(stored, &request).unwrap();
        assert_eq!(next[0], other);
        assert_eq!(next[1]["name"], "Renamed");
        assert_eq!(next[1]["extra"], "keep");
        assert_eq!(next[1]["filter"]["future"], "keep");
        assert_eq!(next[1]["filter"]["itemType"], "Image");
    }

    #[test]
    fn create_gets_an_id_and_delete_only_removes_that_filter() {
        let request = json!({"op":"filtersSave", "tab":{"id":"", "name":"New", "filter":{}}});
        let created = apply_change(json!([tab()]), &request).unwrap();
        assert_eq!(created.as_array().unwrap().len(), 2);
        assert!(!created[1]["id"].as_str().unwrap().is_empty());
        let removed =
            apply_change(created, &json!({"op":"filtersDelete", "tabId":"custom-1"})).unwrap();
        assert_eq!(removed.as_array().unwrap().len(), 1);
        assert_eq!(removed[0]["name"], "New");
    }

    #[test]
    fn invalid_or_stale_edits_do_not_replace_stored_tabs() {
        for draft in [
            json!({"id":"gone", "name":"Valid", "filter":{}}),
            json!({"id":"custom-1", "name":" ", "filter":{}}),
            json!({"id":"custom-1", "name":"Valid", "filter":{"relativeAmount":"-2"}}),
            json!({"id":"custom-1", "name":"Valid", "filter":{"relativeAmount":"1.5"}}),
            json!({"id":"custom-1", "name":"Valid", "filter":{"itemType":"Unknown"}}),
        ] {
            let stored = json!([tab()]);
            assert!(
                apply_change(stored.clone(), &json!({"op":"filtersSave", "tab":draft})).is_err()
            );
            assert_eq!(stored, json!([tab()]));
        }
        assert!(apply_change(
            json!([tab()]),
            &json!({"op":"filtersDelete", "tabId":"gone"})
        )
        .is_err());
    }

    #[test]
    fn failed_write_is_an_error_and_invalid_draft_never_reaches_storage() {
        let request = json!({"op":"filtersSave", "tab":{"id":"", "name":"New", "filter":{}}});
        assert_eq!(
            change_with_store(&request, || Ok(json!([])), |_| Err("disk full".into())).unwrap_err(),
            "disk full"
        );
        let invalid = json!({"op":"filtersSave", "tab":{"id":"", "name":"", "filter":{}}});
        assert!(change_with_store(
            &invalid,
            || Ok(json!([])),
            |_| panic!("invalid draft must not write")
        )
        .is_err());
    }

    #[test]
    fn unchanged_legacy_long_name_can_save_conditions_without_allowing_new_long_names() {
        let mut legacy = tab();
        legacy["name"] = json!("x".repeat(32));
        let stored = json!([legacy.clone(), {"id":"other", "name":"Other", "filter":{}}]);
        let mut draft = legacy.clone();
        draft["filter"]["favorite"] = json!("yes");
        let saved =
            apply_change(stored.clone(), &json!({"op":"filtersSave", "tab":draft})).unwrap();
        assert_eq!(saved[0]["name"], legacy["name"]);
        assert_eq!(saved[0]["filter"]["favorite"], "yes");
        assert_eq!(saved[0]["extra"], "keep");
        assert_eq!(saved[1], stored[1]);
        for id in ["custom-1", ""] {
            let draft = json!({"id":id, "name":"y".repeat(32), "filter":{}});
            assert!(
                apply_change(stored.clone(), &json!({"op":"filtersSave", "tab":draft})).is_err()
            );
        }
    }
}
