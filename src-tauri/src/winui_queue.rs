//! Typed request adapter for queue operations initiated by the native WinUI panel.
//!
//! Queue persistence and behavior remain owned by `paste_queue` and the existing
//! Tauri command helpers in `main.rs`; this module only validates the bridge
//! payload and converts command results into JSON for the native UI.

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum QueueRequest {
    QueueState,
    QueueAdd {
        hashes: Vec<String>,
    },
    QueueRemove {
        hash: String,
    },
    QueueReorder {
        hashes: Vec<String>,
    },
    QueueReverse,
    QueueClear,
    QueuePaste {
        #[serde(default)]
        hash: Option<String>,
    },
    QueueUndo,
}

impl QueueRequest {
    #[cfg(test)]
    pub(crate) fn parse(input: &[u8]) -> Result<Self, String> {
        let mut value =
            serde_json::from_slice::<Value>(input).map_err(|error| error.to_string())?;
        validate_fields(&value)?;
        if let Some(object) = value.as_object_mut() {
            object.remove("id");
        }
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    fn operation(&self) -> &'static str {
        match self {
            Self::QueueState => "queueState",
            Self::QueueAdd { .. } => "queueAdd",
            Self::QueueRemove { .. } => "queueRemove",
            Self::QueueReorder { .. } => "queueReorder",
            Self::QueueReverse => "queueReverse",
            Self::QueueClear => "queueClear",
            Self::QueuePaste { .. } => "queuePaste",
            Self::QueueUndo => "queueUndo",
        }
    }
}

fn validate_fields(payload: &Value) -> Result<(), String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "WinUI queue request must be a JSON object".to_string())?;
    let operation = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "WinUI queue request is missing its operation".to_string())?;
    let allowed = match operation {
        "queueState" | "queueReverse" | "queueClear" | "queueUndo" => &["op", "id"][..],
        "queueAdd" | "queueReorder" => &["op", "id", "hashes"][..],
        "queueRemove" | "queuePaste" => &["op", "id", "hash"][..],
        _ => return Err(format!("Unknown WinUI queue operation: {operation}")),
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("Unexpected WinUI queue request field: {key}"));
    }
    Ok(())
}

pub async fn dispatch(app: AppHandle, op: String, payload: Value) -> Result<Value, String> {
    validate_fields(&payload)?;
    let mut payload = payload.clone();
    if let Some(object) = payload.as_object_mut() {
        object.remove("id");
    }
    let request = serde_json::from_value::<QueueRequest>(payload)
        .map_err(|error| format!("Invalid WinUI queue request: {error}"))?;
    if request.operation() != op.as_str() {
        return Err("WinUI queue operation does not match its payload".into());
    }

    let state = match request {
        QueueRequest::QueueState => crate::get_paste_queue_state()?,
        QueueRequest::QueueAdd { hashes } => crate::add_paste_queue_items(app.clone(), hashes)?,
        QueueRequest::QueueRemove { hash } => crate::remove_paste_queue_item(app.clone(), hash)?,
        QueueRequest::QueueReorder { hashes } => crate::reorder_paste_queue(app.clone(), hashes)?,
        QueueRequest::QueueReverse => crate::reverse_paste_queue(app.clone())?,
        QueueRequest::QueueClear => crate::clear_paste_queue(app.clone())?,
        QueueRequest::QueuePaste { hash } => {
            crate::paste_queue_item(app, hash)?;
            crate::get_paste_queue_state()?
        }
        QueueRequest::QueueUndo => crate::undo_paste_queue_consume(app.clone())?,
    };

    serde_json::to_value(state).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::QueueRequest;

    #[test]
    fn parses_supported_operations_and_camel_case_payloads() {
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueState"}"#),
            Ok(QueueRequest::QueueState)
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueAdd","hashes":["a","b"]}"#),
            Ok(QueueRequest::QueueAdd { hashes }) if hashes == ["a", "b"]
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueRemove","hash":"a"}"#),
            Ok(QueueRequest::QueueRemove { hash }) if hash == "a"
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueReorder","hashes":["b","a"]}"#),
            Ok(QueueRequest::QueueReorder { hashes }) if hashes == ["b", "a"]
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueReverse"}"#),
            Ok(QueueRequest::QueueReverse)
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueClear"}"#),
            Ok(QueueRequest::QueueClear)
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queuePaste"}"#),
            Ok(QueueRequest::QueuePaste { hash: None })
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queuePaste","hash":"a"}"#),
            Ok(QueueRequest::QueuePaste { hash: Some(hash) }) if hash == "a"
        ));
        assert!(matches!(
            QueueRequest::parse(br#"{"op":"queueUndo"}"#),
            Ok(QueueRequest::QueueUndo)
        ));
    }

    #[test]
    fn rejects_unknown_operations_malformed_payloads_and_extra_fields() {
        assert!(QueueRequest::parse(br#"{"op":"queueActivate"}"#).is_err());
        assert!(QueueRequest::parse(br#"{"op":"queueAdd","hashes":"a"}"#).is_err());
        assert!(QueueRequest::parse(br#"{"op":"queueRemove"}"#).is_err());
        assert!(QueueRequest::parse(br#"{"op":"queueClear","unexpected":true}"#).is_err());
    }
}
