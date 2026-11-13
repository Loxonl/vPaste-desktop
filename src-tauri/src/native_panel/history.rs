//! Rust-owned native browsing state; AppKit can release its window independently.
use super::{current, deliver, PanelTab};
use crate::{
    clipboard,
    history_views::{self, HistoryQuery, HistoryRef, ViewToken},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    hash::Hasher,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        LazyLock, Mutex,
    },
};
use tauri::{AppHandle, Listener};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Checkpoint {
    pub tab_id: String,
    pub keywords: String,
    pub anchor_hash: String,
    pub anchor_index: usize,
    pub offset: f64,
    pub selected_hash: String,
    pub start: usize,
    pub end: usize,
    pub viewport_revision: u64,
    pub view_revision: u64,
    #[serde(skip)]
    cursor: Option<history_views::HistoryAnchor>,
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            tab_id: "all".into(),
            keywords: String::new(),
            anchor_hash: String::new(),
            anchor_index: 0,
            offset: 0.0,
            selected_hash: String::new(),
            start: 0,
            end: 12,
            viewport_revision: 0,
            view_revision: 1,
            cursor: None,
        }
    }
}
impl Checkpoint {
    fn for_show(&self, search: bool, tab: bool, position: bool) -> Self {
        let mut next = self.clone();
        if !search {
            next.keywords.clear();
        }
        if !tab {
            next.tab_id = "all".into();
        }
        if !position || next.keywords != self.keywords || next.tab_id != self.tab_id {
            next.reset_position();
        }
        next.viewport_revision = 0;
        next
    }
    fn attach_cursor(&mut self, previous: &Self, revision: u64, sent: &[SentRef]) {
        // A closing window may still display the old revision. Keep its sort
        // key even if that record has since moved to the head of the query.
        self.cursor =
            if self.view_revision < revision && self.anchor_hash == previous.anchor_hash {
                previous.cursor.clone()
            } else {
                None
            }
            .or_else(|| {
                sent.iter()
                    .find(|item| item.anchor.hash == self.anchor_hash)
                    .map(|item| item.anchor.clone())
            });
    }
    fn at_head(&self) -> bool {
        self.anchor_index == 0 && self.offset < 0.01
    }
    fn reset_position(&mut self) {
        self.anchor_hash.clear();
        self.cursor = None;
        self.anchor_index = 0;
        self.offset = 0.0;
        self.selected_hash.clear();
        self.start = 0;
        self.end = 12;
    }
}
#[derive(Clone)]
struct SentRef {
    anchor: history_views::HistoryAnchor,
    fingerprint: u64,
}
fn fingerprint(item: &HistoryRef) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    hash.write(&serde_json::to_vec(item).unwrap_or_default());
    hash.finish()
}
fn summarize(items: &[HistoryRef]) -> Vec<SentRef> {
    items
        .iter()
        .map(|item| SentRef {
            anchor: history_views::HistoryAnchor {
                hash: item.hash.clone(),
                id: item.id,
                time: item.time,
            },
            fingerprint: fingerprint(item),
        })
        .collect()
}
struct State {
    token: Option<ViewToken>,
    query: HistoryQuery,
    checkpoint: Checkpoint,
    sent: Vec<SentRef>,
    applied: u64,
    resources: u64,
    resets: u64,
    deadline: Option<u64>,
}
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        token: None,
        query: HistoryQuery {
            keywords: String::new(),
            label: String::new(),
        },
        checkpoint: Checkpoint::default(),
        sent: Vec::new(),
        applied: 0,
        resources: 0,
        resets: 0,
        deadline: None,
    })
});
// Database work is serialized off the AppKit thread; checkpoints never wait on it.
static OPERATIONS: Mutex<()> = Mutex::new(());
static CHANGES: AtomicU64 = AtomicU64::new(0);
static RESOURCES: AtomicU64 = AtomicU64::new(0);
static SCHEDULED: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
static RESETS: AtomicU64 = AtomicU64::new(0);
static DEADLINE_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub(super) fn watch(app: &AppHandle) {
    if WATCHING.swap(true, Ordering::AcqRel) {
        return;
    }
    for name in [
        "listen_new_clipboard",
        "clipboard-item-edited",
        "clipboard-resources-updated",
        "item-tags-changed",
        "image-ocr-updated",
        "history-reset",
    ] {
        // Resource updates may target the clipboard WebView, including native-only mode.
        app.listen_any(name, move |_| {
            CHANGES.fetch_add(1, Ordering::AcqRel);
            if name == "history-reset" {
                RESETS.fetch_add(1, Ordering::AcqRel);
            }
            if matches!(
                name,
                "clipboard-item-edited" | "clipboard-resources-updated" | "history-reset"
            ) {
                RESOURCES.fetch_add(1, Ordering::AcqRel);
            }
            schedule();
        });
    }
    tauri::async_runtime::spawn(async {
        loop {
            let wake = DEADLINE_WAKE.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let deadline = if current(super::SESSION.load(Ordering::Acquire)) {
                STATE.lock().unwrap_or_else(|err| err.into_inner()).deadline
            } else {
                None
            };
            if let Some(at) = deadline {
                let delay = std::time::Duration::from_millis(
                    at.saturating_sub(clipboard::current_timestamp_millis()),
                );
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {
                        schedule();
                        // One notification suffices while AppKit defers updates
                        // for a drag/menu. The next snapshot arms a new deadline.
                        wake.await;
                    }
                    _ = &mut wake => {}
                }
            } else {
                wake.await;
            }
        }
    });
}

// Hidden windows retain a sequence number, never a growing event queue.
pub(super) fn schedule() {
    let session = super::SESSION.load(Ordering::Acquire);
    if !current(session) || SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        if current(session) {
            // Ask AppKit for the latest viewport/known refs before computing the
            // patch, so scrolling cannot race an unsolicited stale-position patch.
            deliver(session, json!({"event":"history-dirty"}));
        }
        SCHEDULED.store(false, Ordering::Release);
        if super::SESSION.load(Ordering::Acquire) != session {
            schedule();
        }
    });
}

pub(super) fn checkpoint(token: &str, mut checkpoint: Checkpoint) {
    if !checkpoint.offset.is_finite()
        || !(0.0..=1.0).contains(&checkpoint.offset)
        || checkpoint.end < checkpoint.start
        || checkpoint.end.saturating_sub(checkpoint.start) > 256
        || (checkpoint.anchor_index > 0 && checkpoint.anchor_hash.is_empty())
    {
        return;
    }
    let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
    if state
        .token
        .as_ref()
        .is_some_and(|view| view.view_id == token)
        && checkpoint.viewport_revision >= state.checkpoint.viewport_revision
    {
        let revision = state.token.as_ref().unwrap().revision;
        if checkpoint.view_revision == 0 || checkpoint.view_revision > revision {
            return;
        }
        checkpoint.attach_cursor(&state.checkpoint, revision, &state.sent);
        state.checkpoint = checkpoint;
    }
}

pub(super) fn suspend() {
    history_views::reserve_native_open();
    DEADLINE_WAKE.notify_one();
    // The view contains refs/cursors only, already capped by history_views.
    // Swift releases the card payloads, media, observers and window on close.
}

pub(super) fn open(query: HistoryQuery, tab_id: String, request: u64) -> Result<Value, String> {
    let _operation = OPERATIONS.lock().unwrap_or_else(|err| err.into_inner());
    let seq = CHANGES.load(Ordering::Acquire);
    let page = history_views::open_for_owner(
        query.clone(),
        0,
        request,
        history_views::ViewOwner::NativeExperiment,
    )?;
    let sent = summarize(&page.items);
    let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
    state.query = query.clone();
    state.token = Some(page.token.clone());
    state.checkpoint = Checkpoint {
        tab_id,
        keywords: query.keywords,
        ..Default::default()
    };
    state.sent = sent;
    state.applied = seq;
    state.resources = RESOURCES.load(Ordering::Acquire);
    state.resets = RESETS.load(Ordering::Acquire);
    state.deadline =
        clipboard::history_filter_deadline(&query.label, page.items.iter().map(|item| item.time));
    log::debug!("native history open view={} revision=1", page.token.view_id);
    drop(state);
    DEADLINE_WAKE.notify_one();
    serde_json::to_value(page).map_err(|err| err.to_string())
}

pub(super) fn resume(tabs: Vec<PanelTab>, request: u64, preserve: bool) -> Result<Value, String> {
    let _operation = OPERATIONS.lock().unwrap_or_else(|err| err.into_inner());
    let config = crate::config::get();
    let mut saved = STATE
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .checkpoint
        .for_show(
            preserve || config.retain_search_history,
            preserve || config.retain_tab_position,
            preserve || config.retain_last_position,
        );
    let label = match saved.tab_id.as_str() {
        "all" => String::new(),
        "favorite" => "__favorite".into(),
        id => match tabs.iter().find(|tab| tab.id == id) {
            Some(tab) => tab.label.clone(),
            None => {
                saved.tab_id = "all".into();
                saved.reset_position();
                String::new()
            }
        },
    };
    let query = HistoryQuery {
        keywords: saved.keywords.clone(),
        label: label.clone(),
    };
    let existing = {
        let state = STATE.lock().unwrap_or_else(|err| err.into_inner());
        if state.query != query {
            saved.reset_position();
        }
        (state.query == query)
            .then(|| state.token.clone())
            .flatten()
    };
    let existing = existing
        .filter(|token| history_views::validate_native(&token.view_id, token.revision).is_ok());
    let retained = existing.is_some();
    if let Some(token) = existing {
        let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
        state.token = Some(token);
        state.checkpoint = saved.clone();
    } else {
        let seq = CHANGES.load(Ordering::Acquire);
        let page = history_views::open_for_owner(
            query.clone(),
            0,
            request,
            history_views::ViewOwner::NativeExperiment,
        )?;
        let sent = summarize(&page.items);
        saved.view_revision = page.token.revision;
        let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
        state.token = Some(page.token);
        state.query = query;
        state.checkpoint = saved.clone();
        state.sent = sent;
        state.applied = seq;
        state.resources = RESOURCES.load(Ordering::Acquire);
        state.resets = RESETS.load(Ordering::Acquire);
        state.deadline = clipboard::history_filter_deadline(
            &state.query.label,
            state.sent.iter().map(|item| item.anchor.time),
        );
    }
    log::debug!(
        "native history resume retained={} tab={}",
        retained,
        saved.tab_id
    );
    let patch = snapshot(0, &[], true)?;
    Ok(
        json!({"tabs":tabs,"tabId":saved.tab_id,"keywords":saved.keywords,"label":label,"delta":patch}),
    )
}

pub(super) fn synchronize(view_id: &str, revision: u64, known: &[String]) -> Result<Value, String> {
    let _operation = OPERATIONS.lock().unwrap_or_else(|err| err.into_inner());
    let token = STATE
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .token
        .clone()
        .ok_or("Native history is not open")?;
    if token.view_id != view_id {
        return Err("history view expired".into());
    }
    snapshot(revision, known, revision != token.revision)
}

fn changed_refs(old: &[SentRef], next: &[HistoryRef]) -> Vec<HistoryRef> {
    let old = old
        .iter()
        .map(|item| (&item.anchor.hash, item.fingerprint))
        .collect::<std::collections::HashMap<_, _>>();
    next.iter()
        .filter(|item| {
            old.get(&item.hash)
                .is_none_or(|previous| *previous != fingerprint(item))
        })
        .cloned()
        .collect()
}

fn rebase_session(
    previous: &ViewToken,
    anchor: Option<&history_views::HistoryAnchor>,
    checkpoint: &Checkpoint,
) -> Result<(ViewToken, usize), String> {
    let (token, position) =
        history_views::refresh_native(&previous.view_id, previous.revision, anchor)?;
    let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
    if !state.token.as_ref().is_some_and(|current| {
        current.view_id == previous.view_id && current.revision == previous.revision
    }) {
        return Err("history view expired".into());
    }
    // Publish before reading any page: a failed read must leave a valid token
    // for retry. Applied change watermarks advance only after a full snapshot.
    state.token = Some(token.clone());
    if state.checkpoint.viewport_revision == checkpoint.viewport_revision {
        state.checkpoint.anchor_index = position;
        state.checkpoint.start = position.saturating_sub(
            checkpoint
                .anchor_index
                .saturating_sub(checkpoint.start)
                .min(2),
        );
        state.checkpoint.end = position.saturating_add(
            checkpoint
                .end
                .saturating_sub(checkpoint.anchor_index)
                .clamp(1, 128),
        );
    }
    Ok((token, position))
}

fn snapshot(base: u64, known: &[String], full: bool) -> Result<Value, String> {
    let seq = CHANGES.load(Ordering::Acquire);
    let resources = RESOURCES.load(Ordering::Acquire);
    let resets = RESETS.load(Ordering::Acquire);
    let (mut token, query, checkpoint, sent, applied, resource_seq, reset_seq, deadline) = {
        let state = STATE.lock().unwrap_or_else(|err| err.into_inner());
        (
            state.token.clone().ok_or("Native history is not open")?,
            state.query.clone(),
            state.checkpoint.clone(),
            state.sent.clone(),
            state.applied,
            state.resources,
            state.resets,
            state.deadline,
        )
    };
    let reset = resets != reset_seq;
    let anchor = if checkpoint.at_head() || reset {
        None
    } else {
        checkpoint.cursor.clone().or_else(|| {
            sent.iter()
                .find(|item| item.anchor.hash == checkpoint.anchor_hash)
                .map(|item| item.anchor.clone())
        })
    };
    let changed =
        applied != seq || deadline.is_some_and(|at| at <= clipboard::current_timestamp_millis());
    // A missed viewport revision needs an anchored window, not another query.
    let rebase =
        changed || reset || checkpoint.view_revision != token.revision || (full && base != 0);
    let mut anchor_index = checkpoint.anchor_index;
    if rebase {
        let result = rebase_session(&token, anchor.as_ref(), &checkpoint)?;
        token = result.0;
        anchor_index = result.1;
    }
    let left = checkpoint
        .anchor_index
        .saturating_sub(checkpoint.start)
        .min(2);
    let right = checkpoint
        .end
        .saturating_sub(checkpoint.anchor_index)
        .clamp(1, 128);
    let start = anchor_index.saturating_sub(left);
    let end = anchor_index.saturating_add(right);
    let first = (start / 36).saturating_sub(1);
    let last = (end.saturating_sub(1) / 36 + 1).min(first + 5);
    let mut pages = Vec::new();
    for index in first..=last {
        let page = history_views::read_page(&token.view_id, token.revision, index)?;
        let more = page.has_more;
        pages.push(page);
        if !more {
            break;
        }
    }
    let refs = pages
        .iter()
        .flat_map(|page| page.items.iter().cloned())
        .collect::<Vec<_>>();
    let known = known.iter().collect::<HashSet<_>>();
    let previous = if full {
        Vec::new()
    } else {
        sent.into_iter()
            .filter(|item| known.contains(&item.anchor.hash))
            .collect()
    };
    let changed_items = changed_refs(&previous, &refs);
    let invalidated = if resources != resource_seq {
        refs.iter()
            .map(|item| item.hash.clone())
            .collect::<Vec<_>>()
    } else {
        changed_items.iter().map(|item| item.hash.clone()).collect()
    };
    let known_count = pages.iter().map(|page| page.known_count).max().unwrap_or(0);
    let terminal = pages
        .iter()
        .find(|page| !page.has_more)
        .map(|page| page.known_count);
    let count = terminal.unwrap_or(known_count);
    let selected = pages
        .iter()
        .flat_map(|page| {
            page.items
                .iter()
                .enumerate()
                .map(move |(slot, item)| (page.start_index + slot, item))
        })
        .find(|(_, item)| item.hash == checkpoint.selected_hash)
        .map(|(index, _)| index)
        .unwrap_or(anchor_index.min(count.saturating_sub(1)));
    let result = json!({"token":token,"baseRevision":base,"full":full,
        "pages":pages.iter().map(|page| json!({"pageIndex":page.page_index,"hashes":page.items.iter().map(|item| &item.hash).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "refs":changed_items,"knownCount":count,"hasMore":terminal.is_none(),
        "anchorIndex":anchor_index.min(count.saturating_sub(1)),"offset":checkpoint.offset,
        "selectedIndex":selected,"viewportRevision":checkpoint.viewport_revision,
        "invalidated":invalidated,"resourcesChanged":resources != resource_seq});
    let sent = summarize(&refs);
    let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
    if !state
        .token
        .as_ref()
        .is_some_and(|current| current.view_id == token.view_id)
    {
        return Err("history view expired".into());
    }
    state.token = Some(token);
    state.sent = sent;
    state.applied = seq;
    state.resources = resources;
    state.resets = resets;
    state.deadline = clipboard::history_filter_deadline(
        &query.label,
        state.sent.iter().map(|item| item.anchor.time),
    );
    if state.checkpoint.viewport_revision == checkpoint.viewport_revision {
        state.checkpoint.anchor_index = anchor_index;
    }
    log::debug!(
        "native history patch view={} revision={} refs={} pages={} checkpoint={} full={}",
        result["token"]["viewId"],
        result["token"]["revision"],
        changed_items.len(),
        pages.len(),
        checkpoint.viewport_revision,
        full
    );
    drop(state);
    DEADLINE_WAKE.notify_one();
    if CHANGES.load(Ordering::Acquire) != seq {
        schedule();
    }
    Ok(result)
}

pub(super) fn page_sent(page: &history_views::HistoryViewPage) {
    let Ok(refs) = history_views::native_cached_refs(&page.token.view_id, page.token.revision)
    else {
        return;
    };
    let sent = summarize(&refs);
    let mut state = STATE.lock().unwrap_or_else(|err| err.into_inner());
    if state.token.as_ref().is_some_and(|token| {
        token.view_id == page.token.view_id && token.revision == page.token.revision
    }) {
        state.sent = sent;
        state.deadline = clipboard::history_filter_deadline(
            &state.query.label,
            state.sent.iter().map(|item| item.anchor.time),
        );
        DEADLINE_WAKE.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_preferences_are_independent_and_reset_position_when_query_changes() {
        let saved = Checkpoint {
            tab_id: "record:7".into(),
            keywords: "needle".into(),
            anchor_hash: "visible".into(),
            anchor_index: 80,
            offset: 0.3,
            selected_hash: "selected".into(),
            start: 78,
            end: 88,
            viewport_revision: 9,
            ..Default::default()
        };
        let kept = saved.for_show(true, true, true);
        assert_eq!(kept.tab_id, "record:7");
        assert_eq!(kept.anchor_hash, "visible");
        assert_eq!(kept.anchor_index, 80);
        let no_tab = saved.for_show(true, false, true);
        assert_eq!(no_tab.tab_id, "all");
        assert!(no_tab.anchor_hash.is_empty());
        assert_eq!(no_tab.keywords, "needle");
        let no_search = saved.for_show(false, true, true);
        assert!(no_search.keywords.is_empty());
        assert_eq!(no_search.tab_id, "record:7");
        assert_eq!(no_search.anchor_index, 0);
        let no_position = saved.for_show(true, true, false);
        assert_eq!(no_position.tab_id, "record:7");
        assert_eq!(no_position.keywords, "needle");
        assert!(no_position.selected_hash.is_empty());
        assert_eq!(no_position.start, 0);
    }

    #[test]
    fn a_new_head_item_is_the_only_ref_payload_and_existing_hashes_are_not_duplicated() {
        let old = vec![reference("b", 2), reference("a", 1)];
        let next = vec![reference("c", 3), reference("b", 2), reference("a", 1)];
        let refs = changed_refs(&summarize(&old), &next);
        assert_eq!(
            refs.iter()
                .map(|item| item.hash.as_str())
                .collect::<Vec<_>>(),
            ["c"]
        );
        let moved = vec![reference("a", 4), reference("b", 2)];
        let refs = changed_refs(&summarize(&old), &moved);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].hash, "a");
    }

    #[test]
    fn head_follows_new_items_but_scrolled_first_page_keeps_its_record_anchor() {
        let mut checkpoint = Checkpoint::default();
        assert!(checkpoint.at_head());
        checkpoint.offset = 0.6;
        assert!(!checkpoint.at_head());
        checkpoint.offset = 0.0;
        checkpoint.anchor_index = 1;
        assert!(!checkpoint.at_head());
    }

    #[test]
    fn retained_query_applies_head_moves_and_deep_deletion_without_reopening_or_cross_page_duplicates(
    ) {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().into());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().into(),
            retain_last_position: true,
            retain_tab_position: true,
            retain_search_history: true,
            ..Default::default()
        });
        clipboard::db::init();
        let conn = clipboard::db::db();
        for index in 0..160_u64 {
            conn.execute("insert into clipboard(hash,time,content,preview_content,item_type,search_index,source,app_source,app_icon_path,title_color,icon,label) values(?1,?2,'body','body','Text',1,'','','','','',0)",
                rusqlite::params![format!("h{index}"), 1000 - index]).unwrap();
        }
        conn.execute("insert into clipboard(hash,time,content,preview_content,item_type,search_index,source,app_source,app_icon_path,title_color,icon,label) values('invisible',4000,'　 ','','Text',1,'','','','','',0)", []).unwrap();
        conn.execute("insert into clipboard(hash,time,content,preview_content,item_type,search_index,source,app_source,app_icon_path,title_color,icon,label) values('legacy-null',5000,NULL,NULL,'Text',1,NULL,'','','','',0)", []).unwrap();
        conn.execute("update clipboard set source=NULL where hash='h20'", [])
            .unwrap();
        let opened = open(
            HistoryQuery {
                keywords: String::new(),
                label: String::new(),
            },
            "all".into(),
            history_views::reserve_native_open(),
        )
        .unwrap();
        let id = opened["token"]["viewId"].as_str().unwrap().to_string();
        let resumed = resume(vec![], history_views::reserve_native_open(), false).unwrap();
        assert_eq!(resumed["delta"]["token"]["viewId"], id);
        assert_eq!(resumed["delta"]["token"]["revision"], 1);
        let known = resumed["delta"]["refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["hash"].as_str().unwrap().into())
            .collect::<Vec<String>>();
        let before_failure = STATE.lock().unwrap().token.clone().unwrap();
        let checkpoint_before_failure = STATE.lock().unwrap().checkpoint.clone();
        let (rebased, _) =
            rebase_session(&before_failure, None, &checkpoint_before_failure).unwrap();
        // Simulate failure/closure before any rebased page could be read or delivered.
        assert_eq!(
            STATE.lock().unwrap().token.as_ref().unwrap().revision,
            rebased.revision
        );
        let recovered = synchronize(&id, before_failure.revision, &known).unwrap();
        assert_eq!(recovered["full"], true);
        assert_eq!(recovered["token"]["viewId"], id);
        let initial_revision = recovered["token"]["revision"].as_u64().unwrap();
        checkpoint(
            &id,
            Checkpoint {
                anchor_hash: "h0".into(),
                selected_hash: "h0".into(),
                viewport_revision: 1,
                ..Default::default()
            },
        );
        conn.execute("insert into clipboard(hash,time,content,preview_content,item_type,search_index,source,app_source,app_icon_path,title_color,icon,label) values('new',2000,'new','new','Text',1,'','','','','',0)", []).unwrap();
        CHANGES.fetch_add(1, Ordering::AcqRel);
        let inserted = synchronize(&id, initial_revision, &known).unwrap();
        assert_eq!(inserted["token"]["viewId"], id);
        assert_eq!(inserted["anchorIndex"], 0);
        assert_eq!(inserted["selectedIndex"], 1);
        assert_eq!(inserted["refs"].as_array().unwrap().len(), 1);
        assert_eq!(inserted["refs"][0]["hash"], "new");
        let revision = inserted["token"]["revision"].as_u64().unwrap();
        let page = history_views::read_page(&id, revision, 2).unwrap();
        page_sent(&page);
        checkpoint(
            &id,
            Checkpoint {
                anchor_hash: "h71".into(),
                anchor_index: 72,
                offset: 0.3,
                selected_hash: "h71".into(),
                start: 70,
                end: 82,
                viewport_revision: 2,
                ..Default::default()
            },
        );
        conn.execute("update clipboard set time=3000 where hash='h150'", [])
            .unwrap();
        CHANGES.fetch_add(1, Ordering::AcqRel);
        let moved = synchronize(&id, revision, &known).unwrap();
        assert_eq!(moved["anchorIndex"], 73);
        assert_eq!(moved["offset"], 0.3);
        let revision = moved["token"]["revision"].as_u64().unwrap();
        checkpoint(
            &id,
            Checkpoint {
                anchor_hash: "h71".into(),
                anchor_index: 73,
                offset: 0.3,
                selected_hash: "h71".into(),
                start: 71,
                end: 83,
                viewport_revision: 3,
                ..Default::default()
            },
        );
        conn.execute("delete from clipboard where hash='h71'", [])
            .unwrap();
        CHANGES.fetch_add(1, Ordering::AcqRel);
        let deleted = synchronize(&id, revision, &known).unwrap();
        let hashes = deleted["pages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|page| page["hashes"].as_array().unwrap().iter())
            .map(|hash| hash.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(!hashes.contains(&"h71"));
        assert_eq!(hashes.len(), hashes.iter().collect::<HashSet<_>>().len());
        assert_eq!(deleted["token"]["viewId"], id);
        assert!(deleted["pages"].as_array().unwrap().len() <= 6);
        // Membership changes use the same retained query, including an empty result.
        let favorites = open(
            HistoryQuery {
                keywords: String::new(),
                label: "__favorite".into(),
            },
            "favorite".into(),
            history_views::reserve_native_open(),
        )
        .unwrap();
        let favorite_id = favorites["token"]["viewId"].as_str().unwrap();
        assert_eq!(favorites["items"].as_array().unwrap().len(), 0);
        clipboard::set_favorite("h5", true).unwrap();
        CHANGES.fetch_add(1, Ordering::AcqRel);
        let added = synchronize(favorite_id, 1, &[]).unwrap();
        assert_eq!(added["refs"][0]["hash"], "h5");
        assert_eq!(added["knownCount"], 1);
        clipboard::set_favorite("h5", false).unwrap();
        CHANGES.fetch_add(1, Ordering::AcqRel);
        let removed = synchronize(
            favorite_id,
            added["token"]["revision"].as_u64().unwrap(),
            &["h5".into()],
        )
        .unwrap();
        assert_eq!(removed["knownCount"], 0);
        assert_eq!(removed["pages"][0]["hashes"].as_array().unwrap().len(), 0);
        history_views::close(favorite_id);
        history_views::close(&id);
        let mut state = STATE.lock().unwrap();
        state.token = None;
        state.sent.clear();
        state.checkpoint = Checkpoint::default();
        drop(state);
        crate::search::engine::shutdown_runtime_for_tests();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn developer_appearance_rebuild_keeps_the_viewport_even_when_normal_reopen_does_not() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().into());
        crate::config::save(crate::config::Config {
            storage_dir: root.path().to_string_lossy().into(),
            retain_last_position: false,
            retain_tab_position: false,
            retain_search_history: false,
            ..Default::default()
        });
        clipboard::db::init();
        let conn = clipboard::db::db();
        for index in 0..4_u64 {
            conn.execute("insert into clipboard(hash,time,content,preview_content,item_type,search_index,source,app_source,app_icon_path,title_color,icon,label) values(?1,?2,'body','body','Text',1,'','','','','',0)",
                rusqlite::params![format!("dev-{index}"), 1000 - index]).unwrap();
        }
        let opened = open(
            HistoryQuery {
                keywords: String::new(),
                label: String::new(),
            },
            "all".into(),
            history_views::reserve_native_open(),
        )
        .unwrap();
        let id = opened["token"]["viewId"].as_str().unwrap().to_string();
        checkpoint(
            &id,
            Checkpoint {
                anchor_hash: "dev-2".into(),
                anchor_index: 2,
                offset: 0.3,
                selected_hash: "dev-2".into(),
                viewport_revision: 1,
                view_revision: 1,
                ..Default::default()
            },
        );
        suspend();
        let preview = resume(vec![], history_views::reserve_native_open(), true).unwrap();
        assert_eq!(preview["delta"]["token"]["viewId"], id);
        assert_eq!(preview["delta"]["anchorIndex"], 2);
        assert_eq!(preview["delta"]["offset"], 0.3);
        let normal = resume(vec![], history_views::reserve_native_open(), false).unwrap();
        assert_eq!(normal["delta"]["anchorIndex"], 0);
        assert_eq!(normal["delta"]["offset"], 0.0);
        history_views::close(&id);
        let mut state = STATE.lock().unwrap();
        state.token = None;
        state.sent.clear();
        state.checkpoint = Checkpoint::default();
        drop(state);
        crate::search::engine::shutdown_runtime_for_tests();
        crate::config::save(crate::config::Config::default());
    }

    #[test]
    fn late_window_checkpoint_keeps_the_confirmed_cursor_until_the_patch_is_applied() {
        let previous = Checkpoint {
            anchor_hash: "record".into(),
            view_revision: 1,
            cursor: Some(history_views::HistoryAnchor {
                hash: "record".into(),
                id: 7,
                time: 100,
            }),
            ..Default::default()
        };
        let latest = summarize(&[reference("record", 900)]);
        let mut closing = Checkpoint {
            anchor_hash: "record".into(),
            view_revision: 1,
            ..Default::default()
        };
        closing.attach_cursor(&previous, 2, &latest);
        assert_eq!(closing.cursor.as_ref().unwrap().time, 100);
        closing.view_revision = 2;
        closing.attach_cursor(&previous, 2, &latest);
        assert_eq!(closing.cursor.as_ref().unwrap().time, 900);
    }

    fn reference(hash: &str, time: u64) -> HistoryRef {
        HistoryRef {
            id: time as usize,
            hash: hash.into(),
            item_type: clipboard::item::ItemType::Text,
            time,
            label: 0,
            tags: vec![],
            app_source: String::new(),
            app_icon_path: String::new(),
            source_metadata: Default::default(),
            title_color: String::new(),
            preview_text: String::new(),
        }
    }
}
