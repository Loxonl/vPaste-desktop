//! Private, Windows-only UI transport. Business commands remain in Rust.
use serde::Deserialize;
use serde_json::{json, Value};

pub(super) const PROTOCOL_VERSION: u32 = 2;
pub(super) const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub(super) const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(super) fn check_version(actual: u32) -> Result<(), String> {
    if actual == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(format!(
            "WinUI bridge version {actual} is incompatible with {PROTOCOL_VERSION}; rebuild the native app"
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub id: u64,
    pub op: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tag_id: i64,
    #[serde(default)]
    pub last_id: u64,
    #[serde(default)]
    pub last_time: u64,
    #[serde(default)]
    pub navigation_direction: i8,
    #[serde(default)]
    pub argument: String,
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub card_scale: f64,
}

pub(super) fn request(bytes: &[u8]) -> Result<(Request, Value), String> {
    if bytes.is_empty() || bytes.len() > MAX_REQUEST_BYTES {
        return Err("invalid WinUI request size".into());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let request = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    // Queue and tag parsers also consume their own fields from the full payload.
    Ok((request, value))
}

pub(super) fn response(id: u64, op: &str, result: Result<Value, String>) -> Option<Vec<u8>> {
    let value = match result {
        Ok(data) => json!({"id":id, "op":op, "data":data}),
        Err(error) => json!({"id":id, "op":op, "error":error}),
    };
    let bytes = serde_json::to_vec(&value).ok()?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return serde_json::to_vec(&json!({"id":id, "op":op,
            "error":"Native result is too large; narrow the filter and retry / 返回内容过大，请缩小筛选范围后重试"})).ok();
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_incompatible_dll_before_starting_ui() {
        assert!(check_version(PROTOCOL_VERSION).is_ok());
        assert!(check_version(1).is_err());
        assert!(check_version(0).unwrap_err().contains("rebuild"));
        assert!(check_version(PROTOCOL_VERSION + 1).is_err());
    }

    #[test]
    fn keeps_complete_queue_tag_and_preview_envelopes() {
        for value in [
            json!({"id":7,"op":"queueAdd","hashes":["one","two"]}),
            json!({"id":8,"op":"recordTagCreate","name":"工作😀","hash":"one"}),
            json!({"id":9,"op":"previewSelect","hash":"one","navigationDirection":-1}),
        ] {
            let (parsed, original) = request(&serde_json::to_vec(&value).unwrap()).unwrap();
            assert_eq!(parsed.id, value["id"]);
            assert_eq!(original, value);
        }
    }

    #[test]
    fn rejects_malformed_and_oversized_requests_without_dispatch() {
        for bytes in [
            b"".as_slice(),
            b"null",
            b"[]",
            b"{",
            br#"{"op":"query"}"#,
            br#"{"id":-1,"op":"query"}"#,
            br#"{"id":1,"op":"query","limit":"bad"}"#,
        ] {
            assert!(request(bytes).is_err());
        }
        assert!(request(&vec![b' '; MAX_REQUEST_BYTES + 1]).is_err());
        let error = response(10, "edit", Err("保存失败".into())).unwrap();
        let error: Value = serde_json::from_slice(&error).unwrap();
        assert_eq!(error["id"], 10);
        assert_eq!(error["op"], "edit");
        assert_eq!(error["error"], "保存失败");
    }
}
