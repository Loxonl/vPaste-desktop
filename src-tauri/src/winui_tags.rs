//! Request adapter for managing saved-clipboard tags from the native WinUI panel.
//!
//! The existing clipboard tag helpers remain the single source of truth for
//! normalization, uniqueness, persistence, and deletion behavior.

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TagRequest {
    TagsList,
    TagsCreate { name: String },
    TagsRename { tag_id: i64, name: String },
    TagsDelete { tag_id: i64 },
}

impl TagRequest {
    #[cfg(test)]
    pub(crate) fn parse(input: &[u8]) -> Result<Self, String> {
        let value = serde_json::from_slice(input).map_err(|error| error.to_string())?;
        Self::parse_value(value)
    }

    fn parse_value(mut value: Value) -> Result<Self, String> {
        let object = value
            .as_object_mut()
            .ok_or_else(|| "WinUI tag request must be a JSON object".to_string())?;
        let operation = object
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| "WinUI tag request is missing its operation".to_string())?;
        let allowed_fields: &[&str] = match operation {
            "tagsList" => &["op"],
            "tagsCreate" => &["op", "name"],
            "tagsRename" => &["op", "tagId", "name"],
            "tagsDelete" => &["op", "tagId"],
            _ => return Err(format!("Unknown WinUI tag operation: {operation}")),
        };
        if let Some(field) = object
            .keys()
            .find(|field| !allowed_fields.contains(&field.as_str()) && field.as_str() != "id")
        {
            return Err(format!("Unexpected field in WinUI tag request: {field}"));
        }
        object.remove("id");

        let request = serde_json::from_value::<Self>(value)
            .map_err(|error| format!("Invalid WinUI tag request: {error}"))?;
        if matches!(
            &request,
            Self::TagsRename { tag_id, .. } | Self::TagsDelete { tag_id } if *tag_id <= 0
        ) {
            return Err("WinUI tag id must be positive".into());
        }
        Ok(request)
    }

    fn operation(&self) -> &'static str {
        match self {
            Self::TagsList => "tagsList",
            Self::TagsCreate { .. } => "tagsCreate",
            Self::TagsRename { .. } => "tagsRename",
            Self::TagsDelete { .. } => "tagsDelete",
        }
    }
}

pub async fn dispatch(app: AppHandle, op: String, payload: Value) -> Result<Value, String> {
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.remove("id");
    }
    let request = TagRequest::parse_value(payload)?;
    if request.operation() != op {
        return Err("WinUI tag operation does not match its payload".into());
    }

    let changed = match request {
        TagRequest::TagsList => false,
        TagRequest::TagsCreate { name } => {
            crate::create_item_tag(name)?;
            true
        }
        TagRequest::TagsRename { tag_id, name } => {
            crate::rename_item_tag(tag_id, name)?;
            true
        }
        TagRequest::TagsDelete { tag_id } => {
            crate::delete_item_tag(tag_id)?;
            true
        }
    };

    if changed {
        let _ = app.emit("item-tags-changed", json!({}));
    }

    serde_json::to_value(json!({ "items": crate::list_item_tags()? }))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::TagRequest;

    #[test]
    fn parses_supported_operations_and_payloads() {
        assert!(matches!(
            TagRequest::parse(br#"{"op":"tagsList"}"#),
            Ok(TagRequest::TagsList)
        ));
        assert!(matches!(
            TagRequest::parse(br#"{"id":12,"op":"tagsList"}"#),
            Ok(TagRequest::TagsList)
        ));
        assert!(matches!(
            TagRequest::parse(br#"{"op":"tagsCreate","name":"Work"}"#),
            Ok(TagRequest::TagsCreate { name }) if name == "Work"
        ));
        assert!(matches!(
            TagRequest::parse(br#"{"op":"tagsRename","tagId":4,"name":"Notes"}"#),
            Ok(TagRequest::TagsRename { tag_id: 4, name }) if name == "Notes"
        ));
        assert!(matches!(
            TagRequest::parse(br#"{"op":"tagsDelete","tagId":4}"#),
            Ok(TagRequest::TagsDelete { tag_id: 4 })
        ));
    }

    #[test]
    fn rejects_unknown_operations_and_invalid_payloads() {
        assert!(TagRequest::parse(br#"{"op":"tagsReset"}"#).is_err());
        assert!(TagRequest::parse(br#"{"op":"tagsCreate","name":3}"#).is_err());
        assert!(TagRequest::parse(br#"{"op":"tagsRename","tagId":0}"#).is_err());
        assert!(TagRequest::parse(br#"{"op":"tagsRename","tagId":0,"name":"Notes"}"#).is_err());
        assert!(TagRequest::parse(br#"{"op":"tagsDelete","tagId":4,"extra":true}"#).is_err());
    }
}
