use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};
use tokio::sync::Notify;

use crate::clipboard::item::{Item, ItemType};

const LINK_UPDATE_COALESCE: Duration = Duration::from_millis(100);
const LINK_BATCH_SIZE: usize = 10;

#[derive(Clone)]
struct Batch {
    epoch: u64,
    revision: u64,
    #[cfg(target_os = "windows")]
    queued_at: Instant,
    values: Vec<String>,
}

#[derive(Clone)]
struct LinkBatch {
    epoch: u64,
    revision: u64,
    records: Vec<crate::clipboard::LinkPreviewRecord>,
    retry: bool,
}

#[derive(Default)]
struct State {
    visible: bool,
    epoch: u64,
    media_revision: u64,
    link_revision: u64,
    history_link_view: Option<(u64, crate::history_views::HistoryQuery)>,
    media: Option<Batch>,
    links: VecDeque<crate::clipboard::LinkPreviewRecord>,
    link_retries: Vec<(Instant, crate::clipboard::LinkPreviewRecord)>,
    link_rows: HashMap<String, Vec<u64>>,
    link_update: Option<(u64, u64)>,
}

impl State {
    fn enqueue_links<'a>(&mut self, items: impl IntoIterator<Item = &'a Item>, reset: bool) {
        if reset {
            self.link_revision = self.link_revision.wrapping_add(1);
            self.links.clear();
            self.link_retries.clear();
            self.link_rows.clear();
            self.link_update = None;
        }
        if !self.visible {
            return;
        }
        for item in items
            .into_iter()
            .filter(|item| item.item_type == ItemType::Link)
        {
            let url = item.content.split("|||").next().unwrap_or_default().trim();
            if item.id == 0 || !crate::clipboard::is_previewable_domain_link(url) {
                continue;
            }
            let id = item.id as u64;
            let rows = self.link_rows.entry(url.to_string()).or_default();
            if rows.contains(&id) {
                continue;
            }
            rows.push(id);
            self.links.push_back(crate::clipboard::LinkPreviewRecord {
                id,
                hash: item.hash.clone(),
                time: item.time,
                content: item.content.clone(),
            });
        }
    }

    fn take_link_batch(&mut self) -> Option<LinkBatch> {
        self.take_link_batch_at(Instant::now())
    }

    fn take_link_batch_at(&mut self, now: Instant) -> Option<LinkBatch> {
        if !self.visible {
            return None;
        }
        let retry = self.links.is_empty();
        let records: Vec<_> = if retry {
            let mut selected = 0;
            self.link_retries
                .extract_if(.., |(retry_at, _)| {
                    let ready = *retry_at <= now && selected < LINK_BATCH_SIZE;
                    selected += usize::from(ready);
                    ready
                })
                .map(|(_, record)| record)
                .collect()
        } else {
            self.links
                .drain(..self.links.len().min(LINK_BATCH_SIZE))
                .collect()
        };
        (!records.is_empty()).then_some(LinkBatch {
            epoch: self.epoch,
            revision: self.link_revision,
            records,
            retry,
        })
    }

    fn link_current(&self, batch: &LinkBatch) -> bool {
        self.visible && self.epoch == batch.epoch && self.link_revision == batch.revision
    }

    fn mark_link_update(&mut self, url: &str) -> bool {
        // A completed image may survive an older search; refresh only a current view of that URL.
        if !self.visible || !self.link_rows.contains_key(url) {
            return false;
        }
        self.link_update = Some((self.epoch, self.link_revision));
        true
    }

    fn take_link_update(&mut self) -> Option<u64> {
        let (epoch, revision) = self.link_update.take()?;
        (self.visible && self.epoch == epoch && self.link_revision == revision).then_some(epoch)
    }
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    started: AtomicBool,
    media_wake: Notify,
    link_wake: Notify,
    link_update_wake: Notify,
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
        state.history_link_view = None;
        state.links.clear();
        state.link_retries.clear();
        state.link_rows.clear();
        state.link_update = None;
        drop(state);
        self.0.media_wake.notify_one();
        self.0.link_wake.notify_one();
    }

    pub(crate) fn select_history_link_view(
        &self,
        epoch: u64,
        request: u64,
        query: crate::history_views::HistoryQuery,
    ) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.visible
            || state.epoch != epoch
            || state
                .history_link_view
                .as_ref()
                .is_some_and(|(previous, _)| *previous >= request)
        {
            return;
        }
        let changed = state.history_link_view.as_ref().map(|(_, query)| query) != Some(&query);
        state.history_link_view = Some((request, query));
        if changed {
            state.enqueue_links(std::iter::empty::<&Item>(), true);
        }
        drop(state);
        if changed {
            self.0.link_wake.notify_one();
        }
    }

    #[cfg(all(target_os = "windows", feature = "winui"))]
    pub(crate) fn reset_links_for_view(&self, epoch: u64) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.visible && state.epoch == epoch {
            state.enqueue_links(std::iter::empty::<&Item>(), true);
        }
        drop(state);
        self.0.link_wake.notify_one();
    }

    pub(crate) fn submit(
        &self,
        app: tauri::AppHandle,
        items: &[Item],
        epoch: u64,
        reset_links: bool,
    ) {
        self.submit_refs(app, &items.iter().collect::<Vec<_>>(), epoch, reset_links);
    }

    pub(crate) fn submit_refs(
        &self,
        app: tauri::AppHandle,
        items: &[&Item],
        epoch: u64,
        reset_links: bool,
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
        let link_enabled = crate::config::get().link_auto_preview;
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
        if link_enabled {
            state.enqueue_links(items.iter().copied(), reset_links);
        } else {
            state.enqueue_links(std::iter::empty::<&Item>(), true);
        }
        let has_work = state.media.is_some() || !state.links.is_empty();
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
                service.link_loop().await;
            });
            let service = self.clone();
            tauri::async_runtime::spawn(async move {
                service.link_update_loop(app).await;
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

    #[cfg(target_os = "windows")]
    async fn next_media(&self) -> Batch {
        loop {
            let notified = self.0.media_wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let batch = {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                state.media.take()
            };
            if let Some(batch) = batch {
                return batch;
            }
            notified.await;
        }
    }

    fn link_current(&self, batch: &LinkBatch) -> bool {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .link_current(batch)
    }

    fn defer_rate_limited_link(
        &self,
        batch: &LinkBatch,
        record: crate::clipboard::LinkPreviewRecord,
        retry_at: Instant,
    ) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !batch.retry && state.link_current(batch) {
            state.link_retries.push((retry_at, record));
            self.0.link_wake.notify_one();
        }
    }

    fn related_link_rows(&self, batch: &LinkBatch, url: &str) -> Vec<u64> {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.link_current(batch) {
            return Vec::new();
        }
        state
            .link_rows
            .get(url)
            .filter(|rows| rows.len() > 1)
            .cloned()
            .unwrap_or_default()
    }

    async fn next_links(&self) -> LinkBatch {
        loop {
            let notified = self.0.link_wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (batch, next_retry) = {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let batch = state.take_link_batch();
                let next_retry = state
                    .link_retries
                    .iter()
                    .map(|(retry_at, _)| *retry_at)
                    .min();
                (batch, next_retry)
            };
            if let Some(batch) = batch {
                return batch;
            }
            if let Some(retry_at) = next_retry {
                tokio::select! {
                    _ = tokio::time::sleep_until(retry_at.into()) => {},
                    _ = notified => {},
                }
            } else {
                notified.await;
            }
        }
    }

    fn link_record_updated(&self, url: &str) {
        let pending = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mark_link_update(url);
        if pending {
            self.0.link_update_wake.notify_one();
        }
    }

    async fn next_link_update(&self) -> u64 {
        loop {
            self.0.link_update_wake.notified().await;
            tokio::time::sleep(LINK_UPDATE_COALESCE).await;
            if let Some(epoch) = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take_link_update()
            {
                return epoch;
            }
        }
    }

    async fn link_update_loop(&self, app: tauri::AppHandle) {
        loop {
            let epoch = self.next_link_update().await;
            let _ = app.emit_to(
                "clipboard",
                "clipboard-resources-updated",
                serde_json::json!({ "epoch": epoch }),
            );
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
            let batch = self.next_media().await;
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

    async fn link_loop(&self) {
        loop {
            let batch = self.next_links().await;
            if !self.link_current(&batch) || !crate::config::get().link_auto_preview {
                continue;
            }
            let service = self.clone();
            let request = batch.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::clipboard::refresh_loaded_link_previews(
                    request.records.clone(),
                    || service.link_current(&request) && crate::config::get().link_auto_preview,
                    |url| service.related_link_rows(&request, url),
                    |url| service.link_record_updated(url),
                    |record, retry_at| service.defer_rate_limited_link(&request, record, retry_at),
                )
            })
            .await;
            if !matches!(result, Ok(Ok(_))) {
                log::warn!("link preview batch failed: stage=refresh");
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

    fn link(id: usize) -> Item {
        Item {
            id,
            hash: format!("link-{id}"),
            content: format!("https://example.com/{id}"),
            item_type: ItemType::Link,
            preview_content: String::new(),
            text_content: String::new(),
            rich_html: String::new(),
            app_source: String::new(),
            source_metadata: Default::default(),
            app_icon_path: String::new(),
            title_color: String::new(),
            time: 1,
            search_index: 1,
            label: 0,
            tags: Vec::new(),
        }
    }

    #[test]
    fn link_queue_drains_all_loaded_records_in_ten_item_batches() {
        let mut state = State {
            visible: true,
            ..Default::default()
        };
        state.enqueue_links(&(1..=26).map(link).collect::<Vec<_>>(), true);
        let batches = std::iter::from_fn(|| state.take_link_batch()).collect::<Vec<_>>();
        assert_eq!(
            batches
                .iter()
                .map(|batch| batch.records.len())
                .collect::<Vec<_>>(),
            [10, 10, 6]
        );
        assert_eq!(
            batches
                .iter()
                .flat_map(|batch| &batch.records)
                .map(|record| record.id)
                .collect::<Vec<_>>(),
            (1..=26).collect::<Vec<_>>()
        );
    }

    #[test]
    fn link_pagination_appends_without_cancelling_or_duplicating_existing_work() {
        let mut state = State {
            visible: true,
            ..Default::default()
        };
        state.enqueue_links(&(1..=12).map(link).collect::<Vec<_>>(), true);
        let first = state.take_link_batch().unwrap();
        state.enqueue_links(&(11..=23).map(link).collect::<Vec<_>>(), false);
        assert_eq!(first.revision, state.link_revision);
        let remaining = std::iter::from_fn(|| state.take_link_batch())
            .flat_map(|batch| batch.records)
            .map(|record| record.id)
            .collect::<Vec<_>>();
        assert_eq!(remaining, (11..=23).collect::<Vec<_>>());
        state.enqueue_links(&[link(1)], false);
        assert!(state.take_link_batch().is_none());
    }

    #[test]
    fn a_new_search_replaces_link_work_and_hiding_clears_the_queue() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let old = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(1)], true);
            let old = state.take_link_batch().unwrap();
            state.enqueue_links(&[link(2)], true);
            assert_ne!(state.link_revision, old.revision);
            old
        };
        assert!(!service.link_current(&old));
        service.set_visible(false);
        assert!(service.0.state.lock().unwrap().take_link_batch().is_none());
        service.set_visible(true);
        assert!(!service.link_current(&old));
    }

    #[test]
    fn preview_refresh_of_the_same_view_keeps_active_and_pending_links() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let epoch = service.epoch();
        let query = crate::history_views::HistoryQuery {
            keywords: String::new(),
            label: "link".into(),
        };
        service.select_history_link_view(epoch, 1, query.clone());
        let active_batch = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&(1..=12).map(link).collect::<Vec<_>>(), false);
            state.take_link_batch().unwrap()
        };

        service.link_record_updated("https://example.com/1");
        service.select_history_link_view(epoch, 2, query.clone());

        assert!(
            service.link_current(&active_batch),
            "showing the first result must not cancel the current batch"
        );
        let remaining = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(2), link(11)], false);
            state.take_link_batch().unwrap().records
        };
        assert_eq!(
            remaining.iter().map(|record| record.id).collect::<Vec<_>>(),
            [11, 12],
            "pending work must survive the refresh without duplicate requests"
        );
        let next_query = crate::history_views::HistoryQuery {
            keywords: "different".into(),
            ..query.clone()
        };
        service.select_history_link_view(epoch, 4, next_query.clone());
        assert!(!service.link_current(&active_batch));

        service.select_history_link_view(epoch, 3, query);
        let state = service.0.state.lock().unwrap();
        assert_eq!(state.history_link_view, Some((4, next_query)));
    }

    #[test]
    fn link_queue_does_not_accept_non_links_or_unsafe_destinations() {
        let mut state = State {
            visible: true,
            ..Default::default()
        };
        let mut text = link(1);
        text.item_type = ItemType::Text;
        let mut local = link(2);
        local.content = "https://127.0.0.1/secret".into();
        state.enqueue_links(&[text, local], true);
        assert!(state.take_link_batch().is_none());
    }

    #[test]
    fn link_queue_keeps_distinct_history_rows_for_the_same_url_across_pages() {
        let mut state = State {
            visible: true,
            ..Default::default()
        };
        let first = link(1);
        let mut second = link(2);
        second.content = format!(
            "{}||||||Saved title|||default-icon|||2000-01-01",
            first.content
        );
        state.enqueue_links(&[first.clone()], false);
        assert_eq!(state.take_link_batch().unwrap().records[0].id, 1);
        state.enqueue_links(&[first, second.clone()], false);
        let next = state
            .take_link_batch()
            .expect("a distinct history row must enter the queue");
        assert_eq!(next.records.len(), 1);
        assert_eq!(next.records[0].id, 2);
        state.enqueue_links(&[second], false);
        assert!(state.take_link_batch().is_none());
    }

    #[test]
    fn link_preview_cooldown_retries_once_without_blocking_ready_cards() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let now = Instant::now();
        let retry_at = now + Duration::from_secs(60);
        let epoch = service.epoch();
        let query = crate::history_views::HistoryQuery {
            keywords: "".into(),
            label: "".into(),
        };
        service.select_history_link_view(epoch, 1, query.clone());
        let first = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(1)], false);
            state.take_link_batch_at(now).unwrap()
        };
        service.defer_rate_limited_link(&first, first.records[0].clone(), retry_at);

        service.select_history_link_view(epoch, 2, query);
        let retried = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(1), link(2)], false);
            let other = state.take_link_batch_at(now).unwrap();
            assert_eq!(other.records[0].id, 2);
            assert!(state.take_link_batch_at(now).is_none());
            let retried = state.take_link_batch_at(retry_at).unwrap();
            assert_eq!(retried.records[0].id, 1);
            retried
        };
        service.defer_rate_limited_link(&retried, retried.records[0].clone(), retry_at);
        assert!(service
            .0
            .state
            .lock()
            .unwrap()
            .take_link_batch_at(retry_at)
            .is_none());
    }

    #[test]
    fn link_preview_cooldown_work_cannot_escape_an_old_view() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let now = Instant::now();
        let first = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(1)], false);
            state.take_link_batch_at(now).unwrap()
        };
        service.defer_rate_limited_link(&first, first.records[0].clone(), now);
        service.set_visible(false);
        service.set_visible(true);
        service.defer_rate_limited_link(&first, first.records[0].clone(), now);
        assert!(service
            .0
            .state
            .lock()
            .unwrap()
            .take_link_batch_at(now)
            .is_none());
    }

    #[tokio::test]
    async fn link_preview_cooldown_wakes_without_a_new_view_request() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(1)], false);
        }
        let first = service.next_links().await;
        let retry_at = Instant::now() + Duration::from_millis(100);
        service.defer_rate_limited_link(&first, first.records[0].clone(), retry_at);
        let retried = tokio::time::timeout(Duration::from_secs(5), service.next_links())
            .await
            .expect("cooldown expiry should wake the background worker");
        assert!(Instant::now() >= retry_at);
        assert_eq!(retried.records[0].id, 1);
    }

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

    #[tokio::test]
    async fn link_progress_can_refresh_while_the_batch_is_still_in_flight() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let batch = {
            let mut state = service.0.state.lock().unwrap();
            state.enqueue_links(&[link(1), link(2)], true);
            state.take_link_batch().unwrap()
        };
        service.link_record_updated("https://example.com/1");
        let epoch = tokio::time::timeout(Duration::from_secs(5), service.next_link_update())
            .await
            .expect("a finished first record must not wait for the later batch records");
        assert_eq!(epoch, batch.epoch);
        assert!(service.link_current(&batch));
    }

    #[test]
    fn link_progress_coalesces_updates_and_rejects_superseded_search_notifications() {
        let mut state = State {
            visible: true,
            epoch: 7,
            ..Default::default()
        };
        state.enqueue_links(&[link(1), link(2)], true);
        assert!(state.mark_link_update("https://example.com/1"));
        assert!(state.mark_link_update("https://example.com/2"));
        assert_eq!(state.take_link_update(), Some(7));
        assert_eq!(state.take_link_update(), None);
        assert!(state.mark_link_update("https://example.com/1"));
        state.enqueue_links(&[link(3)], true);
        assert_eq!(state.take_link_update(), None);
        assert!(!state.mark_link_update("https://example.com/1"));
        assert!(state.mark_link_update("https://example.com/3"));
        assert_eq!(state.take_link_update(), Some(7));
    }

    #[test]
    fn late_link_completion_only_notifies_a_current_visible_view_of_that_url() {
        let service = BackgroundResources::default();
        service.set_visible(true);
        let old_epoch = service.epoch();
        service
            .0
            .state
            .lock()
            .unwrap()
            .enqueue_links(&[link(1)], true);
        service.link_record_updated("https://example.com/1");
        service.set_visible(false);
        service.link_record_updated("https://example.com/1");
        assert_eq!(service.0.state.lock().unwrap().take_link_update(), None);
        service.set_visible(true);
        service
            .0
            .state
            .lock()
            .unwrap()
            .enqueue_links(&[link(2)], true);
        service.link_record_updated("https://example.com/1");
        assert_eq!(service.0.state.lock().unwrap().take_link_update(), None);
        service
            .0
            .state
            .lock()
            .unwrap()
            .enqueue_links(&[link(1)], true);
        service.link_record_updated("https://example.com/1");
        let epoch = service.0.state.lock().unwrap().take_link_update().unwrap();
        assert_eq!(epoch, service.epoch());
        assert_ne!(epoch, old_epoch);
    }
}
