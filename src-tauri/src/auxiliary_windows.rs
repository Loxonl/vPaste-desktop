use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tokio::sync::{oneshot, watch};

#[derive(Clone, Copy)]
pub(crate) enum WindowKind {
    Config,
    TextEditor,
    PasteFallbackNotice,
    OnboardingPermission,
    TrayMenu,
    EmojiPicker,
    TabEditor,
}

impl WindowKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::TextEditor => "textEditor",
            Self::PasteFallbackNotice => "pasteFallbackNotice",
            Self::OnboardingPermission => "onboardingPermission",
            Self::TrayMenu => "trayMenu",
            Self::EmojiPicker => "emojiPicker",
            Self::TabEditor => "tabEditor",
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
    let ready = app.state::<Readiness>().subscribe(kind);
    let handle = app.clone();
    let window = tauri::async_runtime::spawn_blocking(move || {
        // WebView2 creation must run outside synchronous UI event handlers.
        // Serialize the check/build pair so concurrent cold opens share a window.
        let state = handle.state::<Readiness>();
        let _creation = state.creation.lock().unwrap();
        match handle.get_webview_window(kind.label()) {
            Some(window) => Ok(window),
            None => {
                state.reset(kind);
                crate::build_auxiliary_window(&handle, kind).map_err(|err| err.to_string())
            }
        }
    })
    .await
    .map_err(|err| err.to_string())??;
    tokio::time::timeout(Duration::from_secs(15), wait_for_ready(ready))
        .await
        .map_err(|_| format!("{} window did not finish loading", kind.label()))??;
    Ok(window)
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
