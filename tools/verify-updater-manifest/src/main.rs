use std::{collections::BTreeSet, fs, path::PathBuf};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

fn arg_value(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("missing required argument {name}"))?;
    args.get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

fn decode_base64_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|err| format!("invalid base64 in {label}: {err}"))?;
    String::from_utf8(bytes).map_err(|err| format!("invalid UTF-8 in {label}: {err}"))
}

fn updater_pubkey() -> Result<String, String> {
    let config: serde_json::Value = serde_json::from_slice(
        &fs::read("src-tauri/tauri.conf.json").map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    config
        .get("plugins")
        .and_then(|value| value.get("updater"))
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "the updater public key is not configured".to_string())
        .and_then(|value| decode_base64_text(value, "updater public key"))
}

fn asset_name_from_url(value: &str) -> Result<String, String> {
    value
        .rsplit_once('/')
        .map(|(_, name)| name.to_string())
        .filter(|name| !name.is_empty() && !name.contains('/') && name != "." && name != "..")
        .ok_or_else(|| format!("invalid updater asset URL: {value}"))
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let manifest_path = PathBuf::from(arg_value(&args, "--manifest")?);
    let assets_dir = PathBuf::from(arg_value(&args, "--assets-dir")?);
    let expected_version = arg_value(&args, "--version")?;
    let expected_platforms: BTreeSet<String> = arg_value(&args, "--platforms")?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    let manifest: Manifest = serde_json::from_slice(
        &fs::read(&manifest_path).map_err(|err| format!("failed to read manifest: {err}"))?,
    )
    .map_err(|err| format!("invalid updater manifest JSON: {err}"))?;
    if manifest.version != expected_version {
        return Err(format!(
            "manifest version {} does not match {expected_version}",
            manifest.version
        ));
    }
    let actual_platforms: BTreeSet<String> = manifest.platforms.keys().cloned().collect();
    if actual_platforms != expected_platforms {
        return Err(format!(
            "manifest platforms {:?} do not match expected {:?}",
            actual_platforms, expected_platforms
        ));
    }

    let public_key = PublicKey::decode(&updater_pubkey()?)
        .map_err(|err| format!("invalid updater public key: {err}"))?;
    for platform in expected_platforms {
        let entry: PlatformEntry = serde_json::from_value(
            manifest
                .platforms
                .get(&platform)
                .cloned()
                .ok_or_else(|| format!("missing platform {platform}"))?,
        )
        .map_err(|err| format!("invalid platform entry {platform}: {err}"))?;
        let signature_text =
            decode_base64_text(&entry.signature, &format!("{platform} signature"))?;
        let signature = Signature::decode(&signature_text)
            .map_err(|err| format!("invalid {platform} signature: {err}"))?;
        let asset_path = assets_dir.join(asset_name_from_url(&entry.url)?);
        let asset_bytes = fs::read(&asset_path).map_err(|err| {
            format!(
                "failed to read updater asset {}: {err}",
                asset_path.display()
            )
        })?;
        public_key
            .verify(&asset_bytes, &signature, true)
            .map_err(|err| format!("{platform} updater signature verification failed: {err}"))?;
    }

    println!("Verified updater signatures in {}", manifest_path.display());
    Ok(())
}
