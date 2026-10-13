use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{DateTime, Utc};
use lazy_static::lazy_static;
use log::{error, info, warn};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::{config, runtime_mode};

const UPDATE_EVENT: &str = "app-update-state-changed";
const RELEASES_URL: &str = "https://github.com/Loxonl/vPaste-desktop/releases";
const RC_UPDATE_ENDPOINT: &str = "https://vpaste.app/download/rc/latest.json";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const SCHEDULER_TICK: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);
const CHECKED_UPDATE_REUSE: Duration = Duration::from_secs(10 * 60);
const RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_secs(15 * 60),
    Duration::from_secs(60 * 60),
    Duration::from_secs(6 * 60 * 60),
];
/// A last-check timestamp further in the future than this means the system
/// clock moved backwards; the stored value is then treated as unusable.
const CLOCK_SKEW_TOLERANCE: Duration = Duration::from_secs(5 * 60);
const PENDING_METADATA_FILE: &str = "pending.json";
#[cfg(target_os = "windows")]
const NOTIFIED_VERSION_FILE: &str = "ready-notified-version";
const PARTIAL_SUFFIX: &str = "partial";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateErrorStage {
    Check,
    Download,
    Restore,
    Install,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// Monotonic counter so windows can drop snapshots older than one they
    /// already rendered (command results and events can arrive out of order).
    revision: u64,
    status: UpdateStatus,
    current_version: String,
    available_version: Option<String>,
    date: Option<String>,
    body: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    error_stage: Option<UpdateErrorStage>,
    portable: bool,
    feed_enabled: bool,
    release_url: &'static str,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            revision: 0,
            status: UpdateStatus::Disabled,
            current_version: String::new(),
            available_version: None,
            date: None,
            body: None,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            error_stage: None,
            portable: false,
            feed_enabled: false,
            release_url: RELEASES_URL,
        }
    }
}

/// Metadata committed next to a verified update package. Older builds wrote
/// only `version`, `signature`, `date` and `body`; the remaining fields are
/// optional so that cache keeps restoring after this upgrade.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PendingUpdateMetadata {
    version: String,
    signature: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Clone)]
struct PendingUpdate {
    metadata: PendingUpdateMetadata,
    package_path: PathBuf,
    /// macOS installs through the Tauri updater, which needs the `Update`
    /// object returned by a manifest check. Windows launches the cached Inno
    /// Setup installer directly and can restore without the network.
    #[cfg(not(target_os = "windows"))]
    update: Update,
}

#[derive(Default)]
struct RetrySchedule {
    failures: u32,
    retry_at: Option<Instant>,
}

lazy_static! {
    static ref UPDATE_STATE: Mutex<UpdateState> = Mutex::new(UpdateState::default());
    static ref PENDING_UPDATE: Mutex<Option<PendingUpdate>> = Mutex::new(None);
    static ref LAST_CHECKED_UPDATE: Mutex<Option<(Instant, Update)>> = Mutex::new(None);
    static ref RETRY_SCHEDULE: Mutex<RetrySchedule> = Mutex::new(RetrySchedule::default());
}

static OPERATION_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static AUTOMATIC_DOWNLOAD_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Set at startup on macOS when a cached package exists; the next manifest
/// check is allowed to run before the normal 24 hour interval to restore it.
static CACHE_RESTORE_PENDING: AtomicBool = AtomicBool::new(false);

/// Serializes check, prepare, restore and install across every window, the
/// tray and the background scheduler.
struct OperationGuard;

impl OperationGuard {
    fn acquire() -> Option<Self> {
        OPERATION_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        OPERATION_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

pub fn initialize(app: &AppHandle) {
    let feed_enabled = update_feed_enabled();
    let portable = runtime_mode::is_portable();
    let mut state = UPDATE_STATE.lock().unwrap();
    state.current_version = app.package_info().version.to_string();
    state.portable = portable;
    state.feed_enabled = feed_enabled;
    if !feed_enabled {
        state.status = UpdateStatus::Disabled;
    } else if state.status == UpdateStatus::Disabled {
        state.status = UpdateStatus::Idle;
    }
}

pub fn start_background_checks(app: AppHandle) {
    initialize(&app);
    tauri::async_runtime::spawn(async move {
        if update_feed_enabled() && !runtime_mode::is_portable() {
            restore_cached_update_at_startup(&app).await;
        }
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if automatic_check_due() {
                if let Err(err) = check_internal(app.clone(), true).await {
                    error!("automatic update check failed: {err}");
                }
            }
            tokio::time::sleep(SCHEDULER_TICK).await;
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
    let endpoint = if let Some(endpoint) = debug_update_endpoint() {
        Some(
            endpoint
                .parse::<tauri::Url>()
                .map_err(|err| format!("invalid debug update endpoint: {err}"))?,
        )
    } else if option_env!("VPASTE_UPDATE_CHANNEL") == Some("rc") {
        Some(
            RC_UPDATE_ENDPOINT
                .parse::<tauri::Url>()
                .map_err(|err| format!("invalid RC update endpoint: {err}"))?,
        )
    } else {
        None
    };
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT));
    if let Some(endpoint) = endpoint {
        builder = builder
            .endpoints(vec![endpoint])
            .map_err(|err| err.to_string())?;
    }
    builder.build().map_err(|err| err.to_string())
}

/// The manifest key this build installs from, e.g. `darwin-aarch64`.
fn current_update_target() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn automatic_check_due() -> bool {
    let config = config::get();
    automatic_check_due_at(
        CheckGate {
            feed_enabled: update_feed_enabled(),
            portable: runtime_mode::is_portable(),
            pending_update: PENDING_UPDATE.lock().unwrap().is_some(),
            automatic_checks_enabled: config.update_check_enabled,
            cache_restore_pending: CACHE_RESTORE_PENDING.load(Ordering::SeqCst),
            retry_allowed: retry_allowed_at(&RETRY_SCHEDULE.lock().unwrap(), Instant::now()),
        },
        &config.last_update_check_at,
        Utc::now(),
    )
}

#[derive(Clone, Copy)]
struct CheckGate {
    feed_enabled: bool,
    portable: bool,
    pending_update: bool,
    automatic_checks_enabled: bool,
    cache_restore_pending: bool,
    retry_allowed: bool,
}

fn automatic_check_due_at(gate: CheckGate, last_check_at: &str, now: DateTime<Utc>) -> bool {
    if !gate.feed_enabled
        || gate.portable
        || gate.pending_update
        || !gate.automatic_checks_enabled
        || !gate.retry_allowed
    {
        return false;
    }
    if gate.cache_restore_pending {
        return true;
    }
    let Ok(last_check) = DateTime::parse_from_rfc3339(last_check_at) else {
        return true;
    };
    let last_check = last_check.with_timezone(&Utc);
    if last_check > now {
        // A timestamp from the future means the clock moved backwards. Within
        // a small tolerance keep waiting; beyond it, check instead of
        // stalling until the clock catches up.
        return (last_check - now)
            .to_std()
            .map(|ahead| ahead > CLOCK_SKEW_TOLERANCE)
            .unwrap_or(true);
    }
    now.signed_duration_since(last_check)
        .to_std()
        .map(|elapsed| elapsed >= CHECK_INTERVAL)
        .unwrap_or(true)
}

fn retry_backoff(failures: u32) -> Duration {
    let index = (failures.max(1) as usize - 1).min(RETRY_BACKOFF.len() - 1);
    RETRY_BACKOFF[index]
}

fn retry_allowed_at(schedule: &RetrySchedule, now: Instant) -> bool {
    schedule.retry_at.map_or(true, |retry_at| now >= retry_at)
}

fn record_operation_failure() {
    let mut schedule = RETRY_SCHEDULE.lock().unwrap();
    schedule.failures = schedule.failures.saturating_add(1);
    schedule.retry_at = Some(Instant::now() + retry_backoff(schedule.failures));
}

/// Records a completed check cycle: the manifest was read and either no update
/// exists or the update reached a terminal state (ready or manual download).
fn record_check_success() {
    *RETRY_SCHEDULE.lock().unwrap() = RetrySchedule::default();
    let completed_at = Utc::now().to_rfc3339();
    config::update(|current| current.last_update_check_at = completed_at);
}

fn snapshot() -> UpdateState {
    UPDATE_STATE.lock().unwrap().clone()
}

fn emit_state(app: &AppHandle) -> UpdateState {
    let state = {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.revision += 1;
        state.clone()
    };
    let _ = app.emit(UPDATE_EVENT, state.clone());
    state
}

fn set_failed(app: &AppHandle, stage: UpdateErrorStage, message: String) -> String {
    error!("update {stage:?} failed: {message}");
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Failed;
        state.error = Some(message.clone());
        state.error_stage = Some(stage);
    }
    emit_state(app);
    message
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

async fn fetch_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = build_updater(app)?;
    // The client timeout covers the request; this also bounds anything the
    // plugin does around it so a stuck check always releases the guard.
    match tokio::time::timeout(CHECK_TIMEOUT + CONNECT_TIMEOUT, updater.check()).await {
        Ok(result) => result.map_err(|err| err.to_string()),
        Err(_) => Err("timed out while checking for updates".to_string()),
    }
}

async fn check_internal(app: AppHandle, automatic: bool) -> Result<UpdateState, String> {
    if !update_feed_enabled() {
        initialize(&app);
        return Ok(emit_state(&app));
    }
    let Some(guard) = OperationGuard::acquire() else {
        // Another window, the tray or the scheduler already runs an update
        // operation; report its live state instead of starting a second one.
        return Ok(snapshot());
    };
    if PENDING_UPDATE.lock().unwrap().is_some() {
        return Ok(snapshot());
    }
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Checking;
        state.error = None;
        state.error_stage = None;
    }
    emit_state(&app);

    let update = match fetch_update(&app).await {
        Ok(update) => update,
        Err(err) => {
            record_operation_failure();
            return Err(set_failed(&app, UpdateErrorStage::Check, err));
        }
    };
    CACHE_RESTORE_PENDING.store(false, Ordering::SeqCst);

    let Some(update) = update else {
        record_check_success();
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

    if runtime_mode::is_portable() {
        set_available_update(&update);
        UPDATE_STATE.lock().unwrap().status = UpdateStatus::ManualDownload;
        record_check_success();
        return Ok(emit_state(&app));
    }

    if let Some(ready) = reuse_cached_update(&app, &update).await {
        return Ok(ready);
    }
    *LAST_CHECKED_UPDATE.lock().unwrap() = Some((Instant::now(), update.clone()));
    set_available_update(&update);
    if automatic {
        prepare_update(&app, update, true, guard).await
    } else {
        Ok(emit_state(&app))
    }
}

fn set_available_update(update: &Update) {
    let mut state = UPDATE_STATE.lock().unwrap();
    state.status = UpdateStatus::Available;
    state.current_version = update.current_version.clone();
    state.available_version = Some(update.version.clone());
    state.date = update.date.map(|date| date.to_string());
    state.body = update.body.clone();
    state.downloaded_bytes = 0;
    state.total_bytes = None;
    state.error = None;
    state.error_stage = None;
}

fn take_recent_checked_update() -> Option<Update> {
    let (checked_at, update) = LAST_CHECKED_UPDATE.lock().unwrap().take()?;
    (checked_at.elapsed() < CHECKED_UPDATE_REUSE).then_some(update)
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
    let Some(guard) = OperationGuard::acquire() else {
        return Ok(snapshot());
    };
    if PENDING_UPDATE.lock().unwrap().is_some() {
        return Ok(snapshot());
    }
    let update = match take_recent_checked_update() {
        Some(update) => update,
        None => match fetch_update(&app).await {
            Ok(Some(update)) => update,
            Ok(None) => {
                return Err(set_failed(
                    &app,
                    UpdateErrorStage::Check,
                    "no update is currently available".to_string(),
                ))
            }
            Err(err) => {
                record_operation_failure();
                return Err(set_failed(&app, UpdateErrorStage::Check, err));
            }
        },
    };
    CACHE_RESTORE_PENDING.store(false, Ordering::SeqCst);
    if let Some(ready) = reuse_cached_update(&app, &update).await {
        return Ok(ready);
    }
    set_available_update(&update);
    emit_state(&app);
    prepare_update(&app, update, false, guard).await
}

fn updates_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?
        .join("updates"))
}

fn updater_public_key(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "the updater public key is not configured".to_string())
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("update cache task failed: {err}"))?
}

/// Restores a cached package for `update` when the cache holds the same
/// version, signature and target and the file still verifies.
async fn reuse_cached_update(app: &AppHandle, update: &Update) -> Option<UpdateState> {
    let root = updates_root(app).ok()?;
    let public_key = updater_public_key(app).ok()?;
    let current_version = app.package_info().version.to_string();
    let target = current_update_target();
    let version = update.version.clone();
    let signature = update.signature.clone();
    let restored = run_blocking(move || {
        let Some(metadata) = load_pending_metadata(&root)? else {
            return Ok(None);
        };
        if metadata.version != version || metadata.signature != signature {
            return Ok(None);
        }
        match validate_cached_package(&root, &metadata, &public_key, &current_version, &target) {
            Ok(path) => Ok(Some((metadata, path))),
            Err(err) => {
                warn!("discarding cached update {}: {err}", metadata.version);
                discard_pending_cache(&root);
                Ok(None)
            }
        }
    })
    .await;
    let (metadata, package_path) = match restored {
        Ok(Some(restored)) => restored,
        Ok(None) => return None,
        Err(err) => {
            warn!("failed to read cached update: {err}");
            return None;
        }
    };
    info!(
        "restored cached update {} without downloading",
        metadata.version
    );
    Some(mark_ready(
        app,
        PendingUpdate {
            metadata,
            package_path,
            #[cfg(not(target_os = "windows"))]
            update: update.clone(),
        },
    ))
}

fn mark_ready(app: &AppHandle, pending: PendingUpdate) -> UpdateState {
    let version = pending.metadata.version.clone();
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Ready;
        state.available_version = Some(version.clone());
        state.date = pending.metadata.date.clone();
        state.body = pending.metadata.body.clone();
        state.error = None;
        state.error_stage = None;
    }
    *PENDING_UPDATE.lock().unwrap() = Some(pending);
    LAST_CHECKED_UPDATE.lock().unwrap().take();
    record_check_success();
    let ready = emit_state(app);
    notify_ready_once(app, &version);
    ready
}

async fn restore_cached_update_at_startup(app: &AppHandle) {
    let (root, public_key) = match (updates_root(app), updater_public_key(app)) {
        (Ok(root), Ok(public_key)) => (root, public_key),
        (Err(err), _) | (_, Err(err)) => {
            warn!("update cache is unavailable: {err}");
            return;
        }
    };
    let current_version = app.package_info().version.to_string();
    let target = current_update_target();
    let restored = run_blocking(move || {
        let Some(metadata) = load_pending_metadata(&root)? else {
            return Ok(None);
        };
        if !is_newer_version(&current_version, &metadata.version).unwrap_or(false) {
            discard_pending_cache(&root);
            return Ok(None);
        }
        if cfg!(target_os = "windows") {
            match validate_cached_package(&root, &metadata, &public_key, &current_version, &target)
            {
                Ok(path) => Ok(Some((metadata, Some(path)))),
                Err(err) => {
                    discard_pending_cache(&root);
                    Err(err)
                }
            }
        } else {
            // The Tauri updater needs a fresh manifest check to rebuild its
            // install object; the package is verified again at that point.
            Ok(Some((metadata, None)))
        }
    })
    .await;

    match restored {
        Ok(None) => {}
        #[cfg(target_os = "windows")]
        Ok(Some((metadata, Some(package_path)))) => {
            let _guard = OperationGuard::acquire();
            if PENDING_UPDATE.lock().unwrap().is_none() {
                {
                    let mut state = UPDATE_STATE.lock().unwrap();
                    state.downloaded_bytes = 0;
                    state.total_bytes = None;
                }
                mark_ready(
                    app,
                    PendingUpdate {
                        metadata,
                        package_path,
                    },
                );
            }
        }
        Ok(Some((metadata, _))) => {
            info!(
                "cached update {} found; waiting for the manifest to restore it",
                metadata.version
            );
            CACHE_RESTORE_PENDING.store(true, Ordering::SeqCst);
        }
        Err(err) => {
            set_failed(
                app,
                UpdateErrorStage::Restore,
                format!("the downloaded update could not be restored: {err}"),
            );
        }
    }
}

async fn wait_for_download_stall(last_progress: Arc<Mutex<Instant>>) {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if last_progress.lock().unwrap().elapsed() >= DOWNLOAD_STALL_TIMEOUT {
            return;
        }
    }
}

async fn prepare_update(
    app: &AppHandle,
    mut update: Update,
    automatic: bool,
    _guard: OperationGuard,
) -> Result<UpdateState, String> {
    let version = update.version.clone();
    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Downloading;
        state.downloaded_bytes = 0;
        state.total_bytes = None;
        state.error = None;
        state.error_stage = None;
    }
    emit_state(app);

    // The manifest timeout is far too short for a package download.
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let automatic_download_generation = AUTOMATIC_DOWNLOAD_GENERATION.load(Ordering::SeqCst);
    let last_progress = Arc::new(Mutex::new(Instant::now()));
    let progress_app = app.clone();
    let progress_marker = last_progress.clone();
    let download = update.download(
        move |chunk_length, content_length| {
            *progress_marker.lock().unwrap() = Instant::now();
            {
                let mut state = UPDATE_STATE.lock().unwrap();
                state.downloaded_bytes = state.downloaded_bytes.saturating_add(chunk_length as u64);
                state.total_bytes = content_length;
            }
            emit_state(&progress_app);
        },
        || {},
    );
    let cancellation = async {
        if automatic {
            wait_for_automatic_download_cancellation(automatic_download_generation).await
        } else {
            std::future::pending::<()>().await
        }
    };
    let downloaded = tokio::select! {
        result = download => result.map_err(|err| err.to_string()),
        _ = wait_for_download_stall(last_progress) => {
            Err("the download stopped receiving data".to_string())
        }
        _ = cancellation => {
            let mut state = UPDATE_STATE.lock().unwrap();
            state.status = UpdateStatus::Available;
            state.downloaded_bytes = 0;
            state.total_bytes = None;
            state.error = None;
            state.error_stage = None;
            drop(state);
            return Ok(emit_state(app));
        }
    };
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(err) => {
            record_operation_failure();
            return Err(set_failed(app, UpdateErrorStage::Download, err));
        }
    };

    let metadata = PendingUpdateMetadata {
        version: version.clone(),
        signature: update.signature.clone(),
        target: Some(current_update_target()),
        file_name: None,
        size: Some(bytes.len() as u64),
        date: update.date.map(|date| date.to_string()),
        body: update.body.clone(),
    };
    let root = updates_root(app).map_err(|err| set_failed(app, UpdateErrorStage::Download, err))?;
    let public_key =
        updater_public_key(app).map_err(|err| set_failed(app, UpdateErrorStage::Download, err))?;
    let committed =
        run_blocking(move || commit_pending_package(&root, metadata, &bytes, &public_key)).await;
    let (metadata, package_path) = match committed {
        Ok(committed) => committed,
        Err(err) => {
            record_operation_failure();
            return Err(set_failed(
                app,
                UpdateErrorStage::Download,
                format!("failed to save the downloaded update: {err}"),
            ));
        }
    };
    info!("update {version} downloaded and verified");
    Ok(mark_ready(
        app,
        PendingUpdate {
            metadata,
            package_path,
            #[cfg(not(target_os = "windows"))]
            update,
        },
    ))
}

fn is_newer_version(current: &str, candidate: &str) -> Result<bool, String> {
    let current = Version::parse(current)
        .map_err(|err| format!("invalid current application version {current}: {err}"))?;
    let candidate = Version::parse(candidate)
        .map_err(|err| format!("invalid pending update version {candidate}: {err}"))?;
    Ok(candidate > current)
}

fn package_file_name(version: &str, target: &str) -> Result<String, String> {
    Version::parse(version).map_err(|err| format!("invalid update version {version}: {err}"))?;
    if target.is_empty()
        || !target
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err(format!("invalid update target {target}"));
    }
    Ok(if target.starts_with("windows-") {
        // Name used by earlier builds, kept so their caches keep restoring.
        format!("vPaste_{version}_windows_x64_setup.exe")
    } else {
        format!("vPaste_{version}_{target}.app.tar.gz")
    })
}

fn metadata_target(metadata: &PendingUpdateMetadata) -> String {
    // Caches written before targets were recorded only existed on Windows x64.
    metadata
        .target
        .clone()
        .unwrap_or_else(|| "windows-x86_64".to_string())
}

fn package_path(root: &Path, metadata: &PendingUpdateMetadata) -> Result<PathBuf, String> {
    let expected = package_file_name(&metadata.version, &metadata_target(metadata))?;
    if let Some(file_name) = &metadata.file_name {
        if file_name != &expected {
            return Err(format!("unexpected cached package name {file_name}"));
        }
    }
    Ok(root.join(&metadata.version).join(expected))
}

fn decode_updater_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|err| format!("invalid base64 in {label}: {err}"))?;
    String::from_utf8(bytes).map_err(|err| format!("invalid UTF-8 in {label}: {err}"))
}

fn verify_package_bytes(
    public_key: &str,
    release_signature: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let public_key_text = decode_updater_text(public_key, "updater public key")?;
    let signature_text = decode_updater_text(release_signature, "update signature")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|err| format!("invalid updater public key: {err}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|err| format!("invalid update signature: {err}"))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|err| format!("update signature verification failed: {err}"))
}

fn write_file_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("invalid cache path {}", path.display()))?;
    let partial = path.with_file_name(format!("{file_name}.{PARTIAL_SUFFIX}"));
    let result = (|| {
        let mut file = fs::File::create(&partial)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        // `rename` replaces the destination in one step on Windows and Unix,
        // so a valid previous file is never deleted before its replacement
        // is complete.
        fs::rename(&partial, path)
    })();
    if let Err(err) = result {
        let _ = fs::remove_file(&partial);
        return Err(format!("failed to write {}: {err}", path.display()));
    }
    Ok(())
}

fn load_pending_metadata(root: &Path) -> Result<Option<PendingUpdateMetadata>, String> {
    let path = root.join(PENDING_METADATA_FILE);
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
    };
    match serde_json::from_slice(&contents) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(err) => {
            discard_pending_cache(root);
            Err(format!("invalid pending update metadata: {err}"))
        }
    }
}

/// Checks that a cached package is installable by this build: newer than the
/// running version, built for this platform, complete and correctly signed.
fn validate_cached_package(
    root: &Path,
    metadata: &PendingUpdateMetadata,
    public_key: &str,
    current_version: &str,
    expected_target: &str,
) -> Result<PathBuf, String> {
    if !is_newer_version(current_version, &metadata.version)? {
        return Err(format!(
            "cached update {} is not newer than {current_version}",
            metadata.version
        ));
    }
    let target = metadata_target(metadata);
    if target != expected_target {
        return Err(format!(
            "cached update targets {target}, expected {expected_target}"
        ));
    }
    let path = package_path(root, metadata)?;
    let bytes = fs::read(&path)
        .map_err(|err| format!("failed to read cached update {}: {err}", path.display()))?;
    if let Some(size) = metadata.size {
        if bytes.len() as u64 != size {
            return Err(format!(
                "cached update has {} bytes, expected {size}",
                bytes.len()
            ));
        }
    }
    verify_package_bytes(public_key, &metadata.signature, &bytes)?;
    Ok(path)
}

/// Writes a verified package and its metadata. The metadata file is the commit
/// point: it is only replaced after the package is on disk and verified again
/// from disk, so an interrupted write never looks like a complete download and
/// an earlier valid cache stays usable until then.
fn commit_pending_package(
    root: &Path,
    mut metadata: PendingUpdateMetadata,
    bytes: &[u8],
    public_key: &str,
) -> Result<(PendingUpdateMetadata, PathBuf), String> {
    verify_package_bytes(public_key, &metadata.signature, bytes)?;
    let target = metadata_target(&metadata);
    let file_name = package_file_name(&metadata.version, &target)?;
    metadata.target = Some(target);
    metadata.file_name = Some(file_name);
    metadata.size = Some(bytes.len() as u64);
    let path = package_path(root, &metadata)?;
    let parent = path
        .parent()
        .ok_or_else(|| "cached update has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    write_file_atomically(&path, bytes)?;
    let stored =
        fs::read(&path).map_err(|err| format!("failed to read back {}: {err}", path.display()))?;
    if stored.len() != bytes.len() {
        return Err("the saved update is incomplete".to_string());
    }
    verify_package_bytes(public_key, &metadata.signature, &stored)?;
    drop(stored);
    let contents = serde_json::to_vec_pretty(&metadata).map_err(|err| err.to_string())?;
    write_file_atomically(&root.join(PENDING_METADATA_FILE), &contents)?;
    remove_stale_version_dirs(root, Some(&metadata.version));
    Ok((metadata, path))
}

/// Removes version directories this updater created, except `keep`. Only
/// directories named as a semantic version are touched.
fn remove_stale_version_dirs(root: &Path, keep: Option<&str>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if Some(name.as_str()) == keep || Version::parse(&name).is_err() {
            continue;
        }
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            if let Err(err) = fs::remove_dir_all(entry.path()) {
                warn!("failed to remove stale update cache {name}: {err}");
            }
        }
    }
}

fn discard_pending_cache(root: &Path) {
    let metadata_path = root.join(PENDING_METADATA_FILE);
    if let Err(err) = fs::remove_file(&metadata_path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            warn!("failed to remove {}: {err}", metadata_path.display());
        }
    }
    remove_stale_version_dirs(root, None);
}

#[cfg(target_os = "windows")]
fn notify_ready_once(app: &AppHandle, version: &str) {
    let marker = match updates_root(app) {
        Ok(root) => root.join(NOTIFIED_VERSION_FILE),
        Err(err) => {
            error!("failed to locate update notification marker: {err}");
            return;
        }
    };
    if fs::read_to_string(&marker).ok().as_deref().map(str::trim) == Some(version) {
        return;
    }
    // Record first so a failing or disabled notification is not retried on
    // every launch.
    if let Err(err) = write_file_atomically(&marker, version.as_bytes()) {
        error!("failed to record update notification: {err}");
    }
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
fn notify_ready_once(_app: &AppHandle, _version: &str) {}

#[tauri::command]
pub async fn restart_and_install_app_update(app: AppHandle) -> Result<(), String> {
    if runtime_mode::is_portable() {
        return Err("portable builds must be updated manually".to_string());
    }
    let Some(guard) = OperationGuard::acquire() else {
        return Err("another update operation is already in progress".to_string());
    };
    let Some(pending) = PENDING_UPDATE.lock().unwrap().clone() else {
        return Err("the update has not finished downloading".to_string());
    };

    {
        let mut state = UPDATE_STATE.lock().unwrap();
        state.status = UpdateStatus::Installing;
        state.error = None;
        state.error_stage = None;
    }
    emit_state(&app);

    // Re-verify right before installing: the file may have been removed or
    // modified since it was downloaded.
    let root =
        updates_root(&app).map_err(|err| set_failed(&app, UpdateErrorStage::Install, err))?;
    let public_key =
        updater_public_key(&app).map_err(|err| set_failed(&app, UpdateErrorStage::Install, err))?;
    let current_version = app.package_info().version.to_string();
    let metadata = pending.metadata.clone();
    let verify_root = root.clone();
    let verified = run_blocking(move || {
        let path = validate_cached_package(
            &verify_root,
            &metadata,
            &public_key,
            &current_version,
            &current_update_target(),
        )?;
        fs::read(&path).map_err(|err| format!("failed to read {}: {err}", path.display()))
    })
    .await;
    let bytes = match verified {
        Ok(bytes) => bytes,
        Err(err) => {
            PENDING_UPDATE.lock().unwrap().take();
            let discard_root = root.clone();
            let _ = run_blocking(move || {
                discard_pending_cache(&discard_root);
                Ok(())
            })
            .await;
            {
                let mut state = UPDATE_STATE.lock().unwrap();
                state.downloaded_bytes = 0;
                state.total_bytes = None;
            }
            return Err(set_failed(
                &app,
                UpdateErrorStage::Install,
                format!("the downloaded update is no longer valid; check for updates again: {err}"),
            ));
        }
    };

    if let Err(err) = install_pending_update(&app, &pending, bytes).await {
        // The package still verified, so leave it ready for a direct retry.
        error!("update install failed: {err}");
        {
            let mut state = UPDATE_STATE.lock().unwrap();
            state.status = UpdateStatus::Ready;
            state.error = Some(err.clone());
            state.error_stage = Some(UpdateErrorStage::Install);
        }
        emit_state(&app);
        return Err(err);
    }
    // Keep the operation locked until the process exits.
    std::mem::forget(guard);

    #[cfg(target_os = "windows")]
    {
        app.exit(0);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    app.restart()
}

#[cfg(target_os = "windows")]
async fn install_pending_update(
    app: &AppHandle,
    pending: &PendingUpdate,
    _verified_bytes: Vec<u8>,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let version = &pending.metadata.version;
    let installer_path = &pending.package_path;
    let log_path = installer_path.with_extension("install.log");
    info!(
        "launching vPaste {version} installer at {}",
        installer_path.display()
    );
    Command::new(installer_path)
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
    let _ = app.emit("app-update-installer-started", version.clone());
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn install_pending_update(
    app: &AppHandle,
    pending: &PendingUpdate,
    verified_bytes: Vec<u8>,
) -> Result<(), String> {
    let update = pending.update.clone();
    let version = pending.metadata.version.clone();
    info!("installing vPaste {version} with the Tauri updater");
    run_blocking(move || {
        update
            .install(verified_bytes)
            .map_err(|err| format!("failed to install the update: {err}"))
    })
    .await?;
    PENDING_UPDATE.lock().unwrap().take();
    let _ = app.emit("app-update-installer-started", version);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        automatic_check_due_at, commit_pending_package, discard_pending_cache, is_newer_version,
        load_pending_metadata, package_file_name, public_update_feed_enabled, retry_allowed_at,
        retry_backoff, validate_cached_package, CheckGate, PendingUpdateMetadata, RetrySchedule,
        UpdateStatus, CHECK_INTERVAL, PENDING_METADATA_FILE,
    };
    use chrono::{Duration, TimeZone, Utc};
    use std::fs;
    use std::time::{Duration as StdDuration, Instant};

    // Throwaway keypair generated with `tauri signer generate` for these tests
    // only; it is unrelated to the release signing key.
    const TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0RkM4MUUzNjYzNkE5N0YKUldSL3FUWm00NEg4UlBNaDcvbWF1U214Mlh6aE14TmNYcGx4ekpWQXBYK0VZYlczd05XZVlqT2EK";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSL3FUWm00NEg4UkNZVFNtVlJMVlI3YVloeDBTTGxHZDVuR2I5NCtLVzF3eXJHT2M3NFNVOGJSeWNHY09JWHZPRFBidG9FbmE5Wk9kcFZZL1ZFMkRaekt4UjE4c0taaGcwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxODU1NTY1CWZpbGU6cGF5bG9hZC5iaW4KS2YxbHpNbHB6TnZCVDlwalh4R2QvMlU2WlJoVEZwQ1pLUURSWVZhVWZlNHl1eTVoVFpSQWI0YVpJNDdxR0lUWUZXbGdnM0NVd3NINGJHbmtVY2FCQ2c9PQo=";
    const TEST_PAYLOAD: &[u8] = b"vpaste updater cache fixture\n";
    const TARGET: &str = "darwin-aarch64";

    fn gate() -> CheckGate {
        CheckGate {
            feed_enabled: true,
            portable: false,
            pending_update: false,
            automatic_checks_enabled: true,
            cache_restore_pending: false,
            retry_allowed: true,
        }
    }

    fn metadata(version: &str) -> PendingUpdateMetadata {
        PendingUpdateMetadata {
            version: version.to_string(),
            signature: TEST_SIGNATURE.to_string(),
            target: Some(TARGET.to_string()),
            file_name: None,
            size: None,
            date: None,
            body: Some("notes".to_string()),
        }
    }

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
        assert!(is_newer_version("1.7.0-rc.1", "1.7.0-rc.2").unwrap());
        assert!(!is_newer_version("1.7.0", "1.7.0").unwrap());
        assert!(!is_newer_version("1.7.0", "1.6.0").unwrap());
        assert!(!is_newer_version("1.7.0", "1.7.0-rc.9").unwrap());
    }

    #[test]
    fn automatic_checks_wait_a_day_and_skip_prepared_updates() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        let recent = (now - Duration::hours(23)).to_rfc3339();
        let old = (now - Duration::hours(24)).to_rfc3339();

        assert!(!automatic_check_due_at(gate(), &recent, now));
        assert!(automatic_check_due_at(gate(), &old, now));
        assert!(!automatic_check_due_at(
            CheckGate {
                pending_update: true,
                ..gate()
            },
            &old,
            now
        ));
    }

    #[test]
    fn automatic_checks_respect_feed_portable_and_user_switches() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        assert!(!automatic_check_due_at(
            CheckGate {
                feed_enabled: false,
                ..gate()
            },
            "",
            now
        ));
        assert!(!automatic_check_due_at(
            CheckGate {
                portable: true,
                ..gate()
            },
            "",
            now
        ));
        assert!(!automatic_check_due_at(
            CheckGate {
                automatic_checks_enabled: false,
                ..gate()
            },
            "",
            now
        ));
    }

    #[test]
    fn failed_checks_back_off_instead_of_waiting_a_day_or_retrying_immediately() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        let blocked = CheckGate {
            retry_allowed: false,
            ..gate()
        };
        assert!(!automatic_check_due_at(blocked, "", now));

        assert_eq!(retry_backoff(1), StdDuration::from_secs(15 * 60));
        assert_eq!(retry_backoff(2), StdDuration::from_secs(60 * 60));
        assert_eq!(retry_backoff(3), StdDuration::from_secs(6 * 60 * 60));
        assert_eq!(retry_backoff(30), StdDuration::from_secs(6 * 60 * 60));

        let start = Instant::now();
        let schedule = RetrySchedule {
            failures: 1,
            retry_at: Some(start + retry_backoff(1)),
        };
        assert!(!retry_allowed_at(&schedule, start));
        assert!(retry_allowed_at(&schedule, start + retry_backoff(1)));
        assert!(retry_allowed_at(&RetrySchedule::default(), start));
    }

    #[test]
    fn cached_mac_updates_restore_before_the_daily_interval() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        let recent = (now - Duration::minutes(5)).to_rfc3339();
        let restoring = CheckGate {
            cache_restore_pending: true,
            ..gate()
        };
        assert!(automatic_check_due_at(restoring, &recent, now));
        assert!(!automatic_check_due_at(
            CheckGate {
                retry_allowed: false,
                ..restoring
            },
            &recent,
            now
        ));
    }

    #[test]
    fn clock_rollback_does_not_stop_checks() {
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        let far_future = (now + Duration::days(30)).to_rfc3339();
        let near_future = (now + Duration::minutes(1)).to_rfc3339();
        assert!(automatic_check_due_at(gate(), &far_future, now));
        assert!(!automatic_check_due_at(gate(), &near_future, now));
        assert!(automatic_check_due_at(gate(), "not a timestamp", now));
        assert_eq!(CHECK_INTERVAL, StdDuration::from_secs(86_400));
    }

    #[test]
    fn package_names_are_platform_specific_and_reject_path_segments() {
        assert_eq!(
            package_file_name("1.7.0", "windows-x86_64").unwrap(),
            "vPaste_1.7.0_windows_x64_setup.exe"
        );
        assert_eq!(
            package_file_name("1.7.0-rc.1", "darwin-x86_64").unwrap(),
            "vPaste_1.7.0-rc.1_darwin-x86_64.app.tar.gz"
        );
        assert!(package_file_name("../1.7.0", TARGET).is_err());
        assert!(package_file_name("1.7.0", "darwin/../x").is_err());
    }

    #[test]
    fn committed_cache_restores_without_downloading_again() {
        let dir = tempfile::tempdir().unwrap();
        let (stored, path) =
            commit_pending_package(dir.path(), metadata("1.7.0"), TEST_PAYLOAD, TEST_PUBLIC_KEY)
                .unwrap();
        assert_eq!(stored.size, Some(TEST_PAYLOAD.len() as u64));
        assert_eq!(fs::read(&path).unwrap(), TEST_PAYLOAD);

        let loaded = load_pending_metadata(dir.path()).unwrap().unwrap();
        assert_eq!(loaded, stored);
        assert_eq!(
            validate_cached_package(dir.path(), &loaded, TEST_PUBLIC_KEY, "1.6.0", TARGET).unwrap(),
            path
        );
        assert!(fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".partial")));
    }

    #[test]
    fn invalid_signatures_never_become_ready_and_keep_the_previous_cache() {
        let dir = tempfile::tempdir().unwrap();
        commit_pending_package(dir.path(), metadata("1.7.0"), TEST_PAYLOAD, TEST_PUBLIC_KEY)
            .unwrap();
        let before = fs::read(dir.path().join(PENDING_METADATA_FILE)).unwrap();

        assert!(commit_pending_package(
            dir.path(),
            metadata("1.8.0"),
            b"tampered payload",
            TEST_PUBLIC_KEY
        )
        .is_err());
        assert_eq!(
            fs::read(dir.path().join(PENDING_METADATA_FILE)).unwrap(),
            before
        );
        assert!(!dir.path().join("1.8.0").exists());
    }

    #[test]
    fn tampered_missing_or_mismatched_caches_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let (stored, path) =
            commit_pending_package(dir.path(), metadata("1.7.0"), TEST_PAYLOAD, TEST_PUBLIC_KEY)
                .unwrap();

        assert!(
            validate_cached_package(
                dir.path(),
                &stored,
                TEST_PUBLIC_KEY,
                "1.6.0",
                "darwin-x86_64"
            )
            .is_err(),
            "architecture mismatch"
        );
        assert!(
            validate_cached_package(dir.path(), &stored, TEST_PUBLIC_KEY, "1.7.0", TARGET).is_err(),
            "not newer than the running version"
        );

        fs::write(&path, b"vpaste updater cache fixturE\n").unwrap();
        assert!(
            validate_cached_package(dir.path(), &stored, TEST_PUBLIC_KEY, "1.6.0", TARGET).is_err(),
            "modified package"
        );

        fs::remove_file(&path).unwrap();
        assert!(
            validate_cached_package(dir.path(), &stored, TEST_PUBLIC_KEY, "1.6.0", TARGET).is_err(),
            "missing package"
        );
    }

    #[test]
    fn interrupted_downloads_and_corrupt_metadata_are_not_ready() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("1.7.0")).unwrap();
        fs::write(
            dir.path()
                .join("1.7.0")
                .join("vPaste_1.7.0_darwin-aarch64.app.tar.gz.partial"),
            TEST_PAYLOAD,
        )
        .unwrap();
        assert_eq!(load_pending_metadata(dir.path()).unwrap(), None);

        fs::write(dir.path().join(PENDING_METADATA_FILE), b"{not json").unwrap();
        assert!(load_pending_metadata(dir.path()).is_err());
        assert!(!dir.path().join(PENDING_METADATA_FILE).exists());
        assert!(!dir.path().join("1.7.0").exists());
    }

    #[test]
    fn legacy_windows_metadata_still_restores() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = format!(
            r#"{{"version":"1.7.0","signature":"{TEST_SIGNATURE}","date":null,"body":null}}"#
        );
        fs::create_dir_all(dir.path().join("1.7.0")).unwrap();
        fs::write(
            dir.path()
                .join("1.7.0")
                .join("vPaste_1.7.0_windows_x64_setup.exe"),
            TEST_PAYLOAD,
        )
        .unwrap();
        fs::write(dir.path().join(PENDING_METADATA_FILE), legacy).unwrap();

        let loaded = load_pending_metadata(dir.path()).unwrap().unwrap();
        assert!(validate_cached_package(
            dir.path(),
            &loaded,
            TEST_PUBLIC_KEY,
            "1.6.0",
            "windows-x86_64"
        )
        .is_ok());
    }

    #[test]
    fn newer_cache_replaces_stale_versions_and_discard_only_touches_version_dirs() {
        let dir = tempfile::tempdir().unwrap();
        commit_pending_package(dir.path(), metadata("1.7.0"), TEST_PAYLOAD, TEST_PUBLIC_KEY)
            .unwrap();
        commit_pending_package(dir.path(), metadata("1.7.1"), TEST_PAYLOAD, TEST_PUBLIC_KEY)
            .unwrap();
        fs::create_dir_all(dir.path().join("unrelated")).unwrap();
        assert!(!dir.path().join("1.7.0").exists());
        assert!(dir.path().join("1.7.1").exists());

        discard_pending_cache(dir.path());
        assert!(!dir.path().join("1.7.1").exists());
        assert!(!dir.path().join(PENDING_METADATA_FILE).exists());
        assert!(dir.path().join("unrelated").exists());
    }
}
