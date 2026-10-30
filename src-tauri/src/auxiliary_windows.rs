use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;
use tokio::sync::{oneshot, watch};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Open,
    Closing,
    Closed,
}

struct Instance(watch::Sender<Lifecycle>);
impl tauri::Resource for Instance {}

fn instance(window: &tauri::Window) -> Arc<Instance> {
    let mut resources = window.resources_table();
    let existing = resources
        .names()
        .find_map(|(id, name)| (name == std::any::type_name::<Instance>()).then_some(id));
    if let Some(id) = existing {
        return resources.get(id).expect("window lifecycle resource");
    }
    let instance = Arc::new(Instance(watch::channel(Lifecycle::Open).0));
    resources.add_arc(instance.clone());
    let destroyed = instance.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            destroyed.0.send_replace(Lifecycle::Closed);
        }
    });
    instance
}

fn native_window(window: &tauri::WebviewWindow) -> tauri::Window {
    AsRef::<tauri::Webview>::as_ref(window).window()
}

pub(crate) fn is_open(window: &tauri::WebviewWindow) -> bool {
    *instance(&native_window(window)).0.borrow() == Lifecycle::Open
}

pub(crate) fn destroy(window: &tauri::WebviewWindow) -> Result<(), String> {
    destroy_native(&native_window(window))
}

pub(crate) fn destroy_native(window: &tauri::Window) -> Result<(), String> {
    let instance = instance(window);
    let requested = instance.0.send_if_modified(|state| {
        if *state != Lifecycle::Open {
            return false;
        }
        *state = Lifecycle::Closing;
        true
    });
    if !requested {
        return Ok(());
    }
    if let Err(error) = window.destroy() {
        instance.0.send_if_modified(|state| {
            if *state != Lifecycle::Closing {
                return false;
            }
            *state = Lifecycle::Open;
            true
        });
        return Err(error.to_string());
    }
    Ok(())
}

async fn wait_for_closing(mut lifecycle: watch::Receiver<Lifecycle>) -> Result<(), String> {
    loop {
        if *lifecycle.borrow_and_update() != Lifecycle::Open {
            return Ok(());
        }
        lifecycle
            .changed()
            .await
            .map_err(|error| error.to_string())?;
    }
}

async fn wait_until_not_closing(mut lifecycle: watch::Receiver<Lifecycle>) -> Result<(), String> {
    loop {
        if *lifecycle.borrow_and_update() != Lifecycle::Closing {
            return Ok(());
        }
        lifecycle
            .changed()
            .await
            .map_err(|error| error.to_string())?;
    }
}

#[derive(Clone, Copy)]
pub(crate) enum WindowKind {
    #[cfg(debug_assertions)]
    DevMemory,
    ClipboardPreview,
    PasteQueue,
    Config,
    TextEditor,
    PasteFallbackNotice,
    OnboardingPermission,
    TrayMenu,
    EmojiPicker,
    TabEditor,
    TestRoom,
}

impl WindowKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            #[cfg(debug_assertions)]
            Self::DevMemory => "devMemory",
            Self::ClipboardPreview => "clipboardPreview",
            Self::PasteQueue => "pasteQueue",
            Self::Config => "config",
            Self::TextEditor => "textEditor",
            Self::PasteFallbackNotice => "pasteFallbackNotice",
            Self::OnboardingPermission => "onboardingPermission",
            Self::TrayMenu => "trayMenu",
            Self::EmojiPicker => "emojiPicker",
            Self::TabEditor => "tabEditor",
            Self::TestRoom => "testRoom",
        }
    }
}

#[derive(Default)]
pub(crate) struct Readiness {
    windows: Mutex<HashMap<&'static str, watch::Sender<bool>>>,
    creation: Mutex<()>,
}

impl Readiness {
    fn subscribe(&self, kind: WindowKind) -> watch::Receiver<bool> {
        self.windows
            .lock()
            .unwrap()
            .entry(kind.label())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe()
    }

    fn reset(&self, kind: WindowKind) {
        self.windows
            .lock()
            .unwrap()
            .get(kind.label())
            .expect("readiness is subscribed before creating a window")
            .send_replace(false);
    }

    pub(crate) fn signal(&self, label: &str) -> Result<(), String> {
        let windows = self.windows.lock().unwrap();
        let sender = windows
            .get(label)
            .ok_or_else(|| format!("auxiliary window was not requested: {label}"))?;
        sender.send_replace(true);
        Ok(())
    }
}

async fn wait_for_ready(mut receiver: watch::Receiver<bool>) -> Result<(), String> {
    loop {
        if *receiver.borrow_and_update() {
            return Ok(());
        }
        receiver.changed().await.map_err(|err| err.to_string())?;
    }
}

pub(crate) async fn ensure(
    app: &tauri::AppHandle,
    kind: WindowKind,
) -> Result<tauri::WebviewWindow, String> {
    tokio::time::timeout(Duration::from_secs(15), ensure_open(app, kind))
        .await
        .map_err(|_| format!("{} window did not finish loading or closing", kind.label()))?
}

async fn ensure_open(
    app: &tauri::AppHandle,
    kind: WindowKind,
) -> Result<tauri::WebviewWindow, String> {
    loop {
        let ready = app.state::<Readiness>().subscribe(kind);
        let handle = app.clone();
        let (window, created, native_create_ms) =
            tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
                // WebView2 creation must run outside synchronous UI event handlers.
                // Serialize the check/build pair so concurrent cold opens share a window.
                let state = handle.state::<Readiness>();
                let _creation = state.creation.lock().unwrap();
                match handle.get_webview_window(kind.label()) {
                    Some(window) => Ok((window, false, 0)),
                    None => {
                        state.reset(kind);
                        let started = Instant::now();
                        let window = crate::build_auxiliary_window(&handle, kind)
                            .map_err(|err| err.to_string())?;
                        Ok((window, true, started.elapsed().as_millis()))
                    }
                }
            })
            .await
            .map_err(|err| err.to_string())??;
        let page_started = Instant::now();
        let instance = instance(&native_window(&window));
        let lifecycle = instance.0.subscribe();
        if *lifecycle.borrow() == Lifecycle::Open {
            tokio::select! {
                result = wait_for_ready(ready.clone()) => result?,
                result = wait_for_closing(lifecycle.clone()) => result?,
            }
            if *lifecycle.borrow() == Lifecycle::Open {
                if *ready.borrow() {
                    if matches!(kind, WindowKind::ClipboardPreview) {
                        log::info!(
                            "preview window ready: created={} native_create_ms={} page_ready_ms={}",
                            created,
                            native_create_ms,
                            page_started.elapsed().as_millis()
                        );
                    }
                    return Ok(window);
                }
                continue;
            }
            return Err(format!("{} window closed while loading", kind.label()));
        }
        wait_until_not_closing(lifecycle).await?;
        // Let the event loop settle before rechecking the manager. A Closed
        // instance is never returned even if its entry is briefly still present.
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

pub(crate) async fn on_main_thread(
    app: tauri::AppHandle,
    action: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (sender, receiver) = oneshot::channel();
    // Creation must be asynchronous, but keep the existing native focus/hide
    // operations on the UI thread and serialize concurrent opening requests.
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .map_err(|err| err.to_string())?;
    receiver.await.map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closing_window_waits_for_destruction_and_old_instances_stay_closed() {
        let (sender, receiver) = watch::channel(Lifecycle::Open);
        sender.send_replace(Lifecycle::Closing);
        let pending = tokio::spawn(wait_until_not_closing(receiver));
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        sender.send_replace(Lifecycle::Closed);
        pending.await.unwrap().unwrap();
        let new = Instance(watch::channel(Lifecycle::Open).0);
        assert!(*sender.borrow() == Lifecycle::Closed);
        assert!(*new.0.borrow() == Lifecycle::Open);
    }

    #[tokio::test]
    async fn failed_destruction_releases_waiters_without_claiming_the_page_is_ready() {
        let (sender, receiver) = watch::channel(Lifecycle::Closing);
        let pending = tokio::spawn(wait_until_not_closing(receiver));
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        sender.send_replace(Lifecycle::Open);
        pending.await.unwrap().unwrap();
        let readiness = Readiness::default();
        assert!(!*readiness.subscribe(WindowKind::Config).borrow());
    }

    #[test]
    #[cfg(debug_assertions)]
    fn memory_monitor_has_its_own_debug_window_kind() {
        assert_eq!(WindowKind::DevMemory.label(), "devMemory");
        assert_ne!(WindowKind::DevMemory.label(), "clipboard");
    }

    #[test]
    fn every_non_main_window_has_a_recreation_kind() {
        let labels = [
            WindowKind::ClipboardPreview,
            WindowKind::PasteQueue,
            WindowKind::Config,
            WindowKind::TextEditor,
            WindowKind::PasteFallbackNotice,
            WindowKind::OnboardingPermission,
            WindowKind::TrayMenu,
            WindowKind::EmojiPicker,
            WindowKind::TabEditor,
            WindowKind::TestRoom,
        ]
        .map(WindowKind::label);
        assert_eq!(
            labels,
            [
                "clipboardPreview",
                "pasteQueue",
                "config",
                "textEditor",
                "pasteFallbackNotice",
                "onboardingPermission",
                "trayMenu",
                "emojiPicker",
                "tabEditor",
                "testRoom",
            ]
        );
        assert!(!labels.contains(&"clipboard"));
    }

    #[tokio::test]
    async fn first_open_waits_for_the_page_and_releases_every_waiter() {
        let readiness = Readiness::default();
        let first = tokio::spawn(wait_for_ready(readiness.subscribe(WindowKind::Config)));
        let second = tokio::spawn(wait_for_ready(readiness.subscribe(WindowKind::Config)));
        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());
        readiness.signal("config").unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn readiness_is_not_lost_before_a_waiter_starts_or_on_reopening() {
        let readiness = Readiness::default();
        let receiver = readiness.subscribe(WindowKind::TextEditor);
        readiness.signal("textEditor").unwrap();
        wait_for_ready(receiver).await.unwrap();
        wait_for_ready(readiness.subscribe(WindowKind::TextEditor))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn recreating_a_destroyed_window_waits_for_its_new_page() {
        let readiness = Readiness::default();
        let receiver = readiness.subscribe(WindowKind::TrayMenu);
        readiness.signal("trayMenu").unwrap();
        readiness.reset(WindowKind::TrayMenu);
        let pending = tokio::spawn(wait_for_ready(receiver));
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        readiness.signal("trayMenu").unwrap();
        pending.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_different_window_cannot_release_the_pending_open() {
        let readiness = Readiness::default();
        let config = readiness.subscribe(WindowKind::Config);
        let editor = readiness.subscribe(WindowKind::TabEditor);
        readiness.signal("config").unwrap();
        assert!(*config.borrow());
        assert!(!*editor.borrow());
        assert!(readiness.signal("clipboard").is_err());
    }
}
