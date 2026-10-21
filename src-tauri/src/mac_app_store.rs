use std::ffi::CStr;
use std::process::Command;
use std::time::Duration;

use cocoa::base::{id, nil};
use objc::{class, msg_send, sel, sel_impl};
use serde::Deserialize;

pub const ITEM_ID: &str = env!("VPASTE_APP_STORE_ID");
pub const BUNDLE_ID: &str = "com.loxonl.vpaste";
pub const STORE_URL: &str = concat!("https://apps.apple.com/app/id", env!("VPASTE_APP_STORE_ID"));

#[derive(Deserialize)]
struct LookupResponse {
    results: Vec<LookupResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupResult {
    track_id: u64,
    bundle_id: String,
    version: String,
}

fn parse_listing(body: &str, expected_id: u64) -> Result<String, String> {
    let response: LookupResponse =
        serde_json::from_str(body).map_err(|err| format!("invalid App Store response: {err}"))?;
    let listing = response
        .results
        .into_iter()
        .find(|result| result.track_id == expected_id && result.bundle_id == BUNDLE_ID)
        .ok_or_else(|| "vPaste is not available in the App Store for this region".to_string())?;
    if listing.version.trim().is_empty() {
        return Err("the App Store did not provide a version".to_string());
    }
    Ok(listing.version)
}

fn storefront_country() -> Option<String> {
    // The public lookup API defaults to the US store when no country is sent.
    // Use the Mac's region so an app released only in the user's store remains visible.
    unsafe {
        let locale: id = msg_send![class!(NSLocale), currentLocale];
        if locale == nil {
            return None;
        }
        let country: id = msg_send![locale, countryCode];
        if country == nil {
            return None;
        }
        let bytes: *const std::ffi::c_char = msg_send![country, UTF8String];
        if bytes.is_null() {
            return None;
        }
        let value = CStr::from_ptr(bytes).to_string_lossy().into_owned();
        (value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
            .then(|| value.to_ascii_lowercase())
    }
}

pub async fn lookup_version() -> Result<String, String> {
    let item_id: u64 = ITEM_ID
        .parse()
        .map_err(|err| format!("invalid App Store item ID: {err}"))?;
    let mut url =
        reqwest::Url::parse("https://itunes.apple.com/lookup").map_err(|err| err.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("id", ITEM_ID);
        if let Some(country) = storefront_country() {
            query.append_pair("country", &country);
        }
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| err.to_string())?;
    let body = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|err| format!("App Store lookup failed: {err}"))?
        .text()
        .await
        .map_err(|err| format!("App Store response could not be read: {err}"))?;
    parse_listing(&body, item_id)
}

pub fn open_store_page() -> Result<(), String> {
    let status = Command::new("open")
        .args(["-b", "com.apple.AppStore", STORE_URL])
        .status()
        .map_err(|err| format!("failed to open the App Store: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("App Store exited with {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_listing;

    #[test]
    fn accepts_only_the_matching_app_and_id() {
        let body = r#"{"results":[{"trackId":6824847075,"bundleId":"com.loxonl.vpaste","version":"1.7.0"}]}"#;
        assert_eq!(parse_listing(body, 6824847075).unwrap(), "1.7.0");
        assert!(parse_listing(body, 123).is_err());
        let other_app = body.replace("com.loxonl.vpaste", "com.example.other");
        assert!(parse_listing(&other_app, 6824847075).is_err());
    }

    #[test]
    fn unavailable_and_malformed_responses_are_errors() {
        assert!(parse_listing(r#"{"results":[]}"#, 6824847075).is_err());
        assert!(parse_listing("not-json", 6824847075).is_err());
        assert!(parse_listing(
            r#"{"results":[{"trackId":6824847075,"bundleId":"com.loxonl.vpaste","version":""}]}"#,
            6824847075
        )
        .is_err());
    }
}
