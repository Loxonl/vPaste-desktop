use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};
use tokio::sync::Notify;

use crate::clipboard::item::{Item, ItemType};

#[derive(Clone)]
struct Batch {
    epoch: u64,
    revision: u64,
    #[cfg(target_os = "windows")]
    queued_at: Instant,
    values: Vec<String>,
}

#[derive(Default)]
struct State {
    visible: bool,
    epoch: u64,
    media_revision: u64,
    link_revision: u64,
    media: Option<Batch>,
    links: Option<Batch>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    started: AtomicBool,
    media_wake: Notify,
    link_wake: Notify,
}

#[derive(Clone, Default)]
pub(crate) struct BackgroundResources(Arc<Inner>);

impl BackgroundResources {
    pub(crate) fn epoch(&self) -> u64 {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .epoch
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.visible == visible {
            return;
        }
        state.visible = visible;
        state.epoch = state.epoch.wrapping_add(1);
        state.media_revision = state.media_revision.wrapping_add(1);
        state.link_revision = state.link_revision.wrapping_add(1);
        state.media = None;
        state.links = None;
        drop(state);
        self.0.media_wake.notify_one();
        self.0.link_wake.notify_one();
    }

    pub(crate) fn submit(&self, app: tauri::AppHandle, items: &[Item], epoch: u64, links: bool) {
        self.submit_refs(app, &items.iter().collect::<Vec<_>>(), epoch, links);
    }

    pub(crate) fn submit_refs(
        &self,
        app: tauri::AppHandle,
        items: &[&Item],
        epoch: u64,
        links: bool,
    ) {
        #[cfg(target_os = "windows")]
        let images = unique(
            items
                .iter()
                .filter(|item| item.item_type == ItemType::Image)
                .map(|item| item.content.as_str()),
            6,
        );
        #[cfg(not(target_os = "windows"))]
        let images: Vec<String> = Vec::new();
        let urls = if links && crate::config::get().link_auto_preview {
            unique(
                items
                    .iter()
                    .filter(|item| item.item_type == ItemType::Link)
                    .map(|item| item.content.split("|||").next().unwrap_or_default())
                    .filter(|url| crate::clipboard::is_previewable_domain_link(url)),
                10,
            )
        } else {
            Vec::new()
        };
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.visible || state.epoch != epoch {
            return;
        }
        state.media_revision = state.media_revision.wrapping_add(1);
        state.media = if images.is_empty() {
            None
        } else {
            Some(Batch {
                epoch,
                revision: state.media_revision,
                #[cfg(target_os = "windows")]
                queued_at: Instant::now(),
                values: images,
            })
        };
        if links {
            state.link_revision = state.link_revision.wrapping_add(1);
            state.links = if urls.is_empty() {
                None
            } else {
                Some(Batch {
                    epoch,
                    revision: state.link_revision,
                    #[cfg(target_os = "windows")]
                    queued_at: Instant::now(),
                    values: urls,
                })
            };
        }
        let has_work = state.media.is_some() || state.links.is_some();
        drop(state);
        if has_work && !self.0.started.swap(true, Ordering::SeqCst) {
            #[cfg(target_os = "windows")]
            {
                let service = self.clone();
                tauri::async_runtime::spawn(async move {
                    service.clipboard_warm_loop().await;
                });
            }
            let service = self.clone();
            tauri::async_runtime::spawn(async move {
                service.link_loop(app).await;
            });
        }
        self.0.media_wake.notify_one();
        self.0.link_wake.notify_one();
    }

    fn current(&self, batch: &Batch, media: bool) -> bool {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.visible
            && state.epoch == batch.epoch
            && (if media {
                state.media_revision
            } else {
                state.link_revision
            }) == batch.revision
    }

    async fn next(&self, media: bool) -> Batch {
        loop {
            let wake = if media {
                &self.0.media_wake
            } else {
                &self.0.link_wake
            };
            let notified = wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let batch = {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if media {
                    state.media.take()
                } else {
                    state.links.take()
                }
            };
            if let Some(batch) = batch {
                return batch;
            }
            notified.await;
        }
    }

    #[cfg(target_os = "windows")]
    async fn delay(&self, batch: &Batch, until: Instant) -> bool {
        loop {
            let notified = self.0.media_wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.current(batch, true) {
                return false;
            }
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return true;
            }
            tokio::select! {
                _ = tokio::time::sleep(remaining) => return self.current(batch, true),
                _ = notified => {},
            }
        }
    }

    #[cfg(target_os = "windows")]
    async fn clipboard_warm_loop(&self) {
        loop {
            let batch = self.next(true).await;
            if !self
                .delay(&batch, batch.queued_at + Duration::from_millis(2700))
                .await
            {
                continue;
            }
            // Preserve native clipboard-format warm work; display thumbnails are
            // created synchronously during capture, or on a foreground cache miss.
            for path in batch.values.iter().take(2) {
                if !self.current(&batch, true) {
                    break;
                }
                let path = path.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    crate::prewarm_image_clipboard_cache_path(&path)
                })
                .await;
            }
        }
    }

    async fn link_loop(&self, app: tauri::AppHandle) {
        loop {
            let batch = self.next(false).await;
            if !self.current(&batch, false) || !crate::config::get().link_auto_preview {
                continue;
            }
            let service = self.clone();
            let request = batch.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::clipboard::refresh_link_previews_with_cancellation(
                    request.values.clone(),
                    || service.current(&request, false) && crate::config::get().link_auto_preview,
                )
            })
            .await;
            if let Ok(Ok(updates)) = result {
                let visible = {
                    let state = self
                        .0
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    state.visible && state.epoch == batch.epoch
                };
                if !updates.is_empty() && visible {
                    let _ = app.emit_to(
                        "clipboard",
                        "clipboard-resources-updated",
                        serde_json::json!({ "epoch": batch.epoch }),
                    );
                }
            }
        }
    }
}

fn unique<'a>(values: impl Iterator<Item = &'a str>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .filter(|value| !value.is_empty() && seen.insert((*value).to_string()))
        .take(limit)
        .map(str::to_string)
        .collect()
}

pub(crate) fn set_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(service) = app.try_state::<BackgroundResources>() {
        service.set_visible(visible);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_visibility_epoch_cannot_resume_after_hide_and_reopen() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let batch = {
            let state = service.0.state.lock().unwrap();
            Batch {
                epoch: state.epoch,
                revision: state.media_revision,
                #[cfg(target_os = "windows")]
                queued_at: Instant::now(),
                values: vec!["image.png".into()],
            }
        };
        assert!(service.current(&batch, true));
        service.set_visible(false);
        service.set_visible(true);
        assert!(!service.current(&batch, true));
        assert_ne!(service.epoch(), batch.epoch);
    }
}
