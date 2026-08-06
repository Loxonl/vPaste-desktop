#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "windows")]
use base64::Engine;
use chrono::{DateTime, Utc};
use lazy_static::lazy_static;
use log::error;
#[cfg(target_os = "windows")]
use log::info;
#[cfg(target_os = "windows")]
use minisign_verify::{PublicKey, Signature};
#[cfg(any(target_os = "windows", test))]
use semver::Version;
#[cfg(target_os = "windows")]
use serde::Deserialize;
use serde::Serialize;
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::{config, runtime_mode};

const UPDATE_EVENT: &str = "app-update-state-changed";
const RELEASES_URL: &str = "https://github.com/Loxonl/vPaste-desktop/releases";
const RC_UPDATE_ENDPOINT: &str = "https://vpaste.app/download/rc/latest.json";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    Disabled,
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    ManualDownload,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    status: UpdateStatus,
    current_version: String,
    available_version: Option<String>,
    date: Option<String>,
    body: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    portable: bool,
    feed_enabled: bool,
    release_url: &'static str,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            status: UpdateStatus::Disabled,
            current_version: String::new(),
            available_version: None,
            date: None,
            body: None,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            portable: false,
            feed_enabled: false,
            release_url: RELEASES_URL,
        }
    }
}

enum PendingUpdate {
    #[cfg(target_os = "windows")]
    Windows { version: String, path: PathBuf },
    #[cfg(not(target_os = "windows"))]
    Bundled {
        version: String,
        update: Update,
        bytes: Vec<u8>,
    },
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize, Serialize)]
struct PendingWindowsUpdateMetadata {
    version: String,
    signature: String,
    date: Option<String>,
    body: Option<String>,
}

lazy_static! {
    static ref UPDATE_STATE: Mutex<UpdateState> = Mutex::new(UpdateState::default());
    static ref PENDING_UPDATE: Mutex<Option<PendingUpdate>> = Mutex::new(None);
}

static CHECK_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static AUTOMATIC_DOWNLOAD_GENERATION: AtomicU64 = AtomicU64::new(0);

struct CheckGuard;

impl CheckGuard {
    fn acquire() -> Result<Self, String> {
        CHECK_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "an update operation is already in progress".to_string())
    }
}

impl Drop for CheckGuard {
    fn drop(&mut self) {
        CHECK_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

pub fn initialize(app: &AppHandle) {
    let feed_enabled = update_feed_enabled();
    let portable = runtime_mode::is_portable();
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.current_version = app.package_info().version.to_string();
        state.portable = portable;
        state.feed_enabled = feed_enabled;
        state.status = if feed_enabled {
            UpdateStatus::Idle
        } else {
            UpdateStatus::Disabled
        };
    }

    #[cfg(target_os = "windows")]
    if feed_enabled && !portable {
        match restore_pending_windows_update(app) {
            Ok(Some(metadata)) => {
                let mut state = UPDATE_STATE.lock().unwrap();
                state.status = UpdateStatus::Ready;
                state.available_version = Some(metadata.version);
                state.date = metadata.date;
                state.body = metadata.body;
                state.downloaded_bytes = 0;
                state.total_bytes = None;
                state.error = None;
            }
            Ok(None) => {}
            Err(err) => {
                error!("failed to restore pending Windows update: {err}");
                let mut state = UPDATE_STATE.lock().unwrap();
                state.status = UpdateStatus::Failed;
                state.error = Some(format!("failed to restore downloaded update: {err}"));
            }
        }
    }
}

pub fn start_background_checks(app: AppHandle) {
    initialize(&app);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if automatic_check_due() {
                if let Err(err) = check_internal(app.clone(), true).await {
                    error!("automatic update check failed: {err}");
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

fn public_update_feed_enabled() -> bool {
    option_env!("VPASTE_PUBLIC_UPDATE_FEED") == Some("1")
}

fn debug_update_endpoint() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("VPASTE_DEBUG_UPDATE_ENDPOINT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn update_feed_enabled() -> bool {
    public_update_feed_enabled() || debug_update_endpoint().is_some()
}

fn build_updater(app: &AppHandle) -> Result<Updater, String> {
    if let Some(endpoint) = debug_update_endpoint() {
        let endpoint = endpoint
            .parse::<tauri::Url>()
            .map_err(|err| format!("invalid debug update endpoint: {err}"))?;
        return app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|err| err.to_string())?
            .build()
            .map_err(|err| err.to_string());
    }
    if option_env!("VPASTE_UPDATE_CHANNEL") == Some("rc") {
        let endpoint = RC_UPDATE_ENDPOINT
            .parse::<tauri::Url>()
            .map_err(|err| format!("invalid RC update endpoint: {err}"))?;
        return app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|err| err.to_string())?
            .build()
            .map_err(|err| err.to_string());
    }
    app.updater().map_err(|err| err.to_string())
}

fn automatic_check_due() -> bool {
    let config = config::get();
    automatic_check_due_at(
        update_feed_enabled(),
        runtime_mode::is_portable(),
        PENDING_UPDATE.lock().unwrap().is_some(),
        config.update_check_enabled,
        &config.last_update_check_at,
        Utc::now(),
    )
}

fn automatic_check_due_at(
    feed_enabled: bool,
    portable: bool,
    pending_update: bool,
    automatic_checks_enabled: bool,
    last_check_at: &str,
    now: DateTime<Utc>,
) -> bool {
    if !feed_enabled || portable || pending_update || !automatic_checks_enabled {
        return false;
    }
    let Ok(last_check) = DateTime::parse_from_rfc3339(last_check_at) else {
        return true;
    };
    now.signed_duration_since(last_check.with_timezone(&Utc))
        .to_std()
        .map(|elapsed| elapsed >= CHECK_INTERVAL)
        .unwrap_or(false)
}

fn snapshot() -> UpdateState {
    UPDATE_STATE.lock().unwrap().clone()
}

fn emit_state(app: &AppHandle) -> UpdateState {
    let state = snapshot();
    let _ = app.emit(UPDATE_EVENT, state.clone());
    state
}

fn set_failed(app: &AppHandle, message: String) -> String {
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Failed;
        state.error = Some(message.clone());
    }
    emit_state(app);
    message
}

fn mark_check_completed() {
    let completed_at = Utc::now().to_rfc3339();
    config::update(|current| current.last_update_check_at = completed_at);
}

pub fn set_automatic_updates_enabled(enabled: bool) {
    if enabled {
        return;
    }
    AUTOMATIC_DOWNLOAD_GENERATION.fetch_add(1, Ordering::SeqCst);
}

async fn wait_for_automatic_download_cancellation(generation: u64) {
    while AUTOMATIC_DOWNLOAD_GENERATION.load(Ordering::SeqCst) == generation
        && config::get().update_check_enabled
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> UpdateState {
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        if state.current_version.is_empty() {
            state.current_version = app.package_info().version.to_string();
        }
        state.portable = runtime_mode::is_portable();
        state.feed_enabled = update_feed_enabled();
        if !state.feed_enabled && state.status == UpdateStatus::Idle {
            state.status = UpdateStatus::Disabled;
        }
    }
    snapshot()
}

#[tauri::command]
pub async fn check_for_app_update(app: AppHandle) -> Result<UpdateState, String> {
    check_internal(app, false).await
}

async fn check_internal(app: AppHandle, automatic: bool) -> Result<UpdateState, String> {
    if !update_feed_enabled() {
        initialize(&app);
        return Ok(emit_state(&app));
    }
    let _guard = CheckGuard::acquire()?;
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Checking;
        state.error = None;
    }
    emit_state(&app);
    mark_check_completed();

    let updater = build_updater(&app).map_err(|err| set_failed(&app, err))?;
    let update = updater
        .check()
        .await
        .map_err(|err| set_failed(&app, err.to_string()))?;

    let Some(update) = update else {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Idle;
        state.available_version = None;
        state.date = None;
        state.body = None;
        state.downloaded_bytes = 0;
        state.total_bytes = None;
        drop(state);
        return Ok(emit_state(&app));
    };

    set_available_update(&app, &update);
    if runtime_mode::is_portable() {
        UPDATE_STATE.lock().unwrap().status = UpdateStatus::ManualDownload;
        return Ok(emit_state(&app));
    }
    if automatic {
        prepare_update(&app, update, true).await
    } else {
        Ok(emit_state(&app))
    }
}

fn set_available_update(app: &AppHandle, update: &Update) {
    let mut state = UPDATE_STATE.lock().unwrap();
    state.status = UpdateStatus::Available;
    state.current_version = update.current_version.clone();
    state.available_version = Some(update.version.clone());
    state.date = update.date.map(|date| date.to_string());
    state.body = update.body.clone();
    state.downloaded_bytes = 0;
    state.total_bytes = None;
    state.error = None;
    drop(state);
    emit_state(app);
}

#[tauri::command]
pub async fn prepare_app_update(app: AppHandle) -> Result<UpdateState, String> {
    if runtime_mode::is_portable() {
        UPDATE_STATE.lock().unwrap().status = UpdateStatus::ManualDownload;
        return Ok(emit_state(&app));
    }
    if !update_feed_enabled() {
        initialize(&app);
        return Ok(emit_state(&app));
    }
    let _guard = CheckGuard::acquire()?;
    let updater = build_updater(&app).map_err(|err| set_failed(&app, err))?;
    let update = updater
        .check()
        .await
        .map_err(|err| set_failed(&app, err.to_string()))?
        .ok_or_else(|| set_failed(&app, "no update is currently available".to_string()))?;
    set_available_update(&app, &update);
    prepare_update(&app, update, false).await
}

async fn prepare_update(
    app: &AppHandle,
    update: Update,
    automatic: bool,
) -> Result<UpdateState, String> {
    let version = update.version.clone();
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Downloading;
        state.downloaded_bytes = 0;
        state.total_bytes = None;
        state.error = None;
    }
    emit_state(app);

    let automatic_download_generation = AUTOMATIC_DOWNLOAD_GENERATION.load(Ordering::SeqCst);
    let progress_app = app.clone();
    let download = update.download(
        move |chunk_length, content_length| {
            {
                let mut state = UPDATE_STATE.lock().unwrap();
                state.downloaded_bytes = state.downloaded_bytes.saturating_add(chunk_length as u64);
                state.total_bytes = content_length;
            }
            emit_state(&progress_app);
        },
        || {},
    );
    let bytes = if automatic {
        tokio::select! {
            result = download => result.map_err(|err| set_failed(app, err.to_string()))?,
            _ = wait_for_automatic_download_cancellation(automatic_download_generation) => {
                let mut state = UPDATE_STATE.lock().unwrap();
                state.status = UpdateStatus::Available;
                state.downloaded_bytes = 0;
                state.total_bytes = None;
                state.error = None;
                drop(state);
                return Ok(emit_state(app));
            }
        }
    } else {
        download
            .await
            .map_err(|err| set_failed(app, err.to_string()))?
    };

    store_pending_update(app, version.clone(), update, bytes)
        .map_err(|err| set_failed(app, err))?;
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Ready;
        state.available_version = Some(version.clone());
        state.error = None;
    }
    let ready = emit_state(app);
    show_ready_notification(app, &version);
    Ok(ready)
}

#[cfg(any(target_os = "windows", test))]
fn is_newer_version(current: &str, candidate: &str) -> Result<bool, String> {
    let current = Version::parse(current)
        .map_err(|err| format!("invalid current application version {current}: {err}"))?;
    let candidate = Version::parse(candidate)
        .map_err(|err| format!("invalid pending update version {candidate}: {err}"))?;
    Ok(candidate > current)
}

#[cfg(target_os = "windows")]
fn pending_windows_metadata_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?
        .join("updates")
        .join("pending.json"))
}

#[cfg(target_os = "windows")]
fn pending_windows_installer_path(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Version::parse(version)
        .map_err(|err| format!("invalid pending update version {version}: {err}"))?;
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?
        .join("updates")
        .join(version)
        .join(format!("vPaste_{version}_windows_x64_setup.exe")))
}

#[cfg(target_os = "windows")]
fn updater_public_key(app: &AppHandle) -> Result<&str, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "the updater public key is not configured".to_string())
}

#[cfg(target_os = "windows")]
fn decode_updater_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|err| format!("invalid base64 in {label}: {err}"))?;
    String::from_utf8(bytes).map_err(|err| format!("invalid UTF-8 in {label}: {err}"))
}

#[cfg(target_os = "windows")]
fn verify_pending_windows_installer(
    app: &AppHandle,
    installer_path: &PathBuf,
    release_signature: &str,
) -> Result<(), String> {
    let public_key_text = decode_updater_text(updater_public_key(app)?, "updater public key")?;
    let signature_text = decode_updater_text(release_signature, "update signature")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|err| format!("invalid updater public key: {err}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|err| format!("invalid update signature: {err}"))?;
    let bytes = fs::read(installer_path).map_err(|err| {
        format!(
            "failed to read pending installer {}: {err}",
            installer_path.display()
        )
    })?;
    public_key
        .verify(&bytes, &signature, true)
        .map_err(|err| format!("pending installer signature verification failed: {err}"))
}

#[cfg(target_os = "windows")]
fn persist_pending_windows_update(
    app: &AppHandle,
    metadata: &PendingWindowsUpdateMetadata,
) -> Result<(), String> {
    let metadata_path = pending_windows_metadata_path(app)?;
    let parent = metadata_path
        .parent()
        .ok_or_else(|| "pending update metadata has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let partial_path = metadata_path.with_extension("json.download");
    let contents = serde_json::to_vec_pretty(metadata).map_err(|err| err.to_string())?;
    fs::write(&partial_path, contents).map_err(|err| err.to_string())?;
    if metadata_path.exists() {
        fs::remove_file(&metadata_path).map_err(|err| err.to_string())?;
    }
    fs::rename(&partial_path, &metadata_path).map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn restore_pending_windows_update(
    app: &AppHandle,
) -> Result<Option<PendingWindowsUpdateMetadata>, String> {
    let metadata_path = pending_windows_metadata_path(app)?;
    if !metadata_path.exists() {
        return Ok(None);
    }
    let metadata: PendingWindowsUpdateMetadata =
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|err| err.to_string())?)
            .map_err(|err| format!("invalid pending update metadata: {err}"))?;
    if !is_newer_version(&app.package_info().version.to_string(), &metadata.version)? {
        fs::remove_file(&metadata_path).map_err(|err| err.to_string())?;
        return Ok(None);
    }
    let installer_path = pending_windows_installer_path(app, &metadata.version)?;
    verify_pending_windows_installer(app, &installer_path, &metadata.signature)?;
    *PENDING_UPDATE.lock().unwrap() = Some(PendingUpdate::Windows {
        version: metadata.version.clone(),
        path: installer_path,
    });
    Ok(Some(metadata))
}

#[cfg(target_os = "windows")]
fn store_pending_update(
    app: &AppHandle,
    version: String,
    update: Update,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let update_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?
        .join("updates")
        .join(&version);
    fs::create_dir_all(&update_dir).map_err(|err| err.to_string())?;
    let installer_path = update_dir.join(format!("vPaste_{version}_windows_x64_setup.exe"));
    let partial_path = installer_path.with_extension("exe.download");
    fs::write(&partial_path, bytes).map_err(|err| err.to_string())?;
    if installer_path.exists() {
        fs::remove_file(&installer_path).map_err(|err| err.to_string())?;
    }
    fs::rename(&partial_path, &installer_path).map_err(|err| err.to_string())?;
    persist_pending_windows_update(
        app,
        &PendingWindowsUpdateMetadata {
            version: version.clone(),
            signature: update.signature,
            date: update.date.map(|date| date.to_string()),
            body: update.body,
        },
    )?;
    *PENDING_UPDATE.lock().unwrap() = Some(PendingUpdate::Windows {
        version,
        path: installer_path,
    });
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn store_pending_update(
    _app: &AppHandle,
    version: String,
    update: Update,
    bytes: Vec<u8>,
) -> Result<(), String> {
    *PENDING_UPDATE.lock().unwrap() = Some(PendingUpdate::Bundled {
        version,
        update,
        bytes,
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn show_ready_notification(app: &AppHandle, version: &str) {
    let language = config::get().multilingual;
    let (title, body) = if language == "Chinese" {
        (
            "vPaste 更新已就绪",
            format!("版本 {version} 已下载，重启 vPaste 即可完成更新"),
        )
    } else {
        (
            "vPaste update ready",
            format!("Version {version} is downloaded. Restart vPaste to update"),
        )
    };
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        error!("failed to show update notification: {err}");
    }
}

#[cfg(not(target_os = "windows"))]
fn show_ready_notification(_app: &AppHandle, _version: &str) {}

#[tauri::command]
pub fn restart_and_install_app_update(app: AppHandle) -> Result<(), String> {
    if runtime_mode::is_portable() {
        return Err("portable builds must be updated manually".to_string());
    }
    if PENDING_UPDATE.lock().unwrap().is_none() {
        return Err("the update has not finished downloading".to_string());
    }

    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Installing;
        state.error = None;
    }
    emit_state(&app);
    install_pending_update(&app).map_err(|err| set_failed(&app, err))?;

    #[cfg(target_os = "windows")]
    {
        app.exit(0);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    app.restart()
}

#[cfg(target_os = "windows")]
fn install_pending_update(app: &AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let (version, installer_path) = {
        let pending = PENDING_UPDATE.lock().unwrap();
        let Some(PendingUpdate::Windows { version, path }) = pending.as_ref() else {
            return Err("the prepared Windows installer is missing".to_string());
        };
        (version.clone(), path.clone())
    };
    let log_path = installer_path.with_extension("install.log");
    info!(
        "launching vPaste {version} installer at {}",
        installer_path.display()
    );
    Command::new(&installer_path)
        .args([
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/CLOSEAPPLICATIONS",
            "/RESTARTAPPLICATIONS",
            "/RESTARTAPP",
        ])
        .arg(format!("/LOG={}", log_path.display()))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| format!("failed to start the update installer: {err}"))?;
    let _ = app.emit("app-update-installer-started", version);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_pending_update(app: &AppHandle) -> Result<(), String> {
    let pending = PENDING_UPDATE.lock().unwrap();
    let Some(PendingUpdate::Bundled {
        version,
        update,
        bytes,
    }) = pending.as_ref()
    else {
        return Err("the prepared update is missing".to_string());
    };
    update.install(bytes).map_err(|err| err.to_string())?;
    let version = version.clone();
    drop(pending);
    PENDING_UPDATE.lock().unwrap().take();
    let _ = app.emit("app-update-installer-started", version);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        automatic_check_due_at, is_newer_version, public_update_feed_enabled, UpdateStatus,
    };
    use chrono::{Duration, TimeZone, Utc};

    #[test]
    fn release_feed_is_disabled_unless_explicitly_compiled_in() {
        assert_eq!(
            public_update_feed_enabled(),
            option_env!("VPASTE_PUBLIC_UPDATE_FEED") == Some("1")
        );
    }

    #[test]
    fn update_states_distinguish_downloaded_and_installing() {
        assert_ne!(UpdateStatus::Ready, UpdateStatus::Installing);
    }

    #[test]
    fn pending_updates_must_be_newer_semver_versions() {
        assert!(is_newer_version("1.6.0", "1.7.0").unwrap());
        assert!(is_newer_version("1.7.0-rc.1", "1.7.0").unwrap());
        assert!(!is_newer_version("1.7.0", "1.7.0").unwrap());
        assert!(!is_newer_version("1.7.0", "1.6.0").unwrap());
    }

    #[test]
    fn automatic_checks_wait_a_day_and_skip_prepared_updates() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        let recent = (now - Duration::hours(23)).to_rfc3339();
        let old = (now - Duration::hours(24)).to_rfc3339();

        assert!(!automatic_check_due_at(
            true, false, false, true, &recent, now
        ));
        assert!(automatic_check_due_at(true, false, false, true, &old, now));
        assert!(!automatic_check_due_at(true, false, true, true, &old, now));
    }

    #[test]
    fn automatic_checks_respect_feed_portable_and_user_switches() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        assert!(!automatic_check_due_at(false, false, false, true, "", now));
        assert!(!automatic_check_due_at(true, true, false, true, "", now));
        assert!(!automatic_check_due_at(true, false, false, false, "", now));
    }
}
