use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, LazyLock, Mutex,
};

use crate::clipboard::item::{Item, ItemTag, ItemType};
use crate::rich_card_assets::RichRenderPayload;
use serde::{Deserialize, Serialize};

const PAGE_SIZE: usize = 36;
const PAGE_LIMIT: usize = 6;
const ANCHOR_LIMIT: usize = 4096;
const CACHE_BYTES: usize = 7 * 1024 * 1024; // reserve the remaining MiB for bounded anchors/indices
static NEXT_VIEW: AtomicU64 = AtomicU64::new(1);
static OPEN_REQUEST: AtomicU64 = AtomicU64::new(0);
static VIEWS: LazyLock<Mutex<HashMap<String, Arc<View>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct HistoryQuery {
    pub(crate) keywords: String,
    pub(crate) label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryRef {
    pub(crate) id: usize,
    pub(crate) hash: String,
    pub(crate) item_type: ItemType,
    pub(crate) time: u64,
    pub(crate) label: u64,
    pub(crate) tags: Vec<ItemTag>,
    pub(crate) app_source: String,
    pub(crate) app_icon_path: String,
    pub(crate) title_color: String,
}

impl HistoryRef {
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.hash.capacity()
            + self.app_source.capacity()
            + self.app_icon_path.capacity()
            + self.title_color.capacity()
            + self.tags.capacity() * std::mem::size_of::<ItemTag>()
            + self
                .tags
                .iter()
                .map(|tag| tag.name.capacity())
                .sum::<usize>()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewToken {
    pub(crate) view_id: String,
    pub(crate) revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryViewPage {
    pub(crate) token: ViewToken,
    pub(crate) page_index: usize,
    pub(crate) start_index: usize,
    pub(crate) items: Vec<HistoryRef>,
    pub(crate) known_count: usize,
    pub(crate) has_more: bool,
    pub(crate) resource_epoch: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryCardPayload {
    pub(crate) item: Item,
    pub(crate) rich_render: Option<RichRenderPayload>,
    pub(crate) mime_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardResponse {
    pub(crate) token: ViewToken,
    pub(crate) resource_epoch: u64,
    pub(crate) cards: Vec<HistoryCardPayload>,
}

struct CachedPage {
    items: Vec<HistoryRef>,
    has_more: bool,
    bytes: usize,
}
struct Cache {
    pages: BTreeMap<usize, CachedPage>,
    order: VecDeque<usize>,
    anchors: BTreeMap<usize, (u64, u64)>,
    known_count: usize,
    terminal: Option<usize>,
    bytes: usize,
}
struct View {
    token: ViewToken,
    query: HistoryQuery,
    epoch: u64,
    closed: AtomicBool,
    cache: Mutex<Cache>,
}

fn view(id: &str, revision: u64) -> Result<Arc<View>, String> {
    VIEWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .filter(|view| view.token.revision == revision && !view.closed.load(Ordering::Acquire))
        .cloned()
        .ok_or_else(|| "history view expired".into())
}

pub(crate) fn reserve_open() -> u64 {
    OPEN_REQUEST.fetch_add(1, Ordering::AcqRel) + 1
}

pub(crate) fn open(
    query: HistoryQuery,
    epoch: u64,
    request: u64,
) -> Result<HistoryViewPage, String> {
    let id = NEXT_VIEW.fetch_add(1, Ordering::Relaxed).to_string();
    let token = ViewToken {
        view_id: id.clone(),
        revision: 1,
    };
    let created = Arc::new(View {
        token,
        query,
        epoch,
        closed: AtomicBool::new(false),
        cache: Mutex::new(Cache {
            pages: BTreeMap::new(),
            order: VecDeque::new(),
            anchors: BTreeMap::from([(0, (0, 0))]),
            known_count: 0,
            terminal: None,
            bytes: 0,
        }),
    });
    {
        let mut views = VIEWS.lock().unwrap_or_else(|e| e.into_inner());
        if OPEN_REQUEST.load(Ordering::Acquire) != request {
            return Err("history view expired".into());
        }
        for old in views.values() {
            old.closed.store(true, Ordering::Release);
        }
        views.clear(); // main history has one owner; no unbounded native result sessions
        views.insert(id.clone(), created);
    }
    read_page(&id, 1, 0)
}

pub(crate) fn set_viewport(
    id: &str,
    revision: u64,
    start: usize,
    end: usize,
) -> Result<(), String> {
    let view = view(id, revision)?;
    let mut cache = view.cache.lock().unwrap_or_else(|e| e.into_inner());
    let first = (start / PAGE_SIZE).saturating_sub(1);
    let last = end.saturating_sub(1) / PAGE_SIZE + 1;
    let stale: Vec<_> = cache
        .pages
        .keys()
        .copied()
        .filter(|index| *index < first || *index > last)
        .collect();
    for index in stale {
        if let Some(page) = cache.pages.remove(&index) {
            cache.bytes -= page.bytes;
        }
        cache.order.retain(|page| *page != index);
    }
    Ok(())
}

pub(crate) fn close(id: &str) {
    if let Some(view) = VIEWS.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
        view.closed.store(true, Ordering::Release);
    }
}

pub(crate) fn read_page(id: &str, revision: u64, index: usize) -> Result<HistoryViewPage, String> {
    let view = view(id, revision)?;
    let mut cache = view.cache.lock().unwrap_or_else(|e| e.into_inner());
    let current = || !view.closed.load(Ordering::Acquire);
    if !current() {
        return Err("history view expired".into());
    }
    if !cache.pages.contains_key(&index)
        && cache
            .terminal
            .is_none_or(|count| index.saturating_mul(PAGE_SIZE) < count)
    {
        let (&mut_index, &mut_cursor) = cache.anchors.range(..=index).next_back().unwrap();
        let mut scan_index = mut_index;
        let mut cursor = mut_cursor;
        while scan_index <= index {
            let page = crate::clipboard::history_ref_page(
                &view.query.keywords,
                cursor.0,
                cursor.1,
                PAGE_SIZE,
                &view.query.label,
                current,
            )?
            .ok_or_else(|| "history view expired".to_string())?;
            if !current() {
                return Err("history view expired".into());
            }
            let start = scan_index.saturating_mul(PAGE_SIZE);
            cache.known_count = cache.known_count.max(start.saturating_add(page.list.len()));
            if !page.has_more {
                cache.terminal = Some(start.saturating_add(page.list.len()));
            }
            cursor = (page.next_id, page.next_time);
            if page.has_more {
                cache.anchors.insert(scan_index + 1, cursor);
                while cache.anchors.len() > ANCHOR_LIMIT {
                    let remove = *cache
                        .anchors
                        .keys()
                        .find(|&&key| key != 0 && key != scan_index + 1)
                        .unwrap();
                    cache.anchors.remove(&remove);
                }
            }
            let bytes = page.list.iter().map(HistoryRef::bytes).sum::<usize>();
            if bytes <= CACHE_BYTES {
                if let Some(old) = cache.pages.remove(&scan_index) {
                    cache.bytes -= old.bytes;
                }
                cache.order.retain(|&page| page != scan_index);
                while cache.pages.len() >= PAGE_LIMIT
                    || cache.bytes.saturating_add(bytes) > CACHE_BYTES
                {
                    let Some(remove) = cache.order.pop_front() else {
                        break;
                    };
                    if let Some(old) = cache.pages.remove(&remove) {
                        cache.bytes -= old.bytes;
                    }
                }
                cache.bytes += bytes;
                cache.order.push_back(scan_index);
                cache.pages.insert(
                    scan_index,
                    CachedPage {
                        items: page.list,
                        has_more: page.has_more,
                        bytes,
                    },
                );
            } else if scan_index == index {
                return Ok(HistoryViewPage {
                    token: view.token.clone(),
                    page_index: index,
                    start_index: start,
                    items: page.list,
                    known_count: cache.known_count,
                    has_more: page.has_more,
                    resource_epoch: view.epoch,
                });
            }
            if !page.has_more {
                break;
            }
            scan_index += 1;
        }
    }
    if !current() {
        return Err("history view expired".into());
    }
    let page = cache.pages.get(&index);
    let result = HistoryViewPage {
        token: view.token.clone(),
        page_index: index,
        start_index: index.saturating_mul(PAGE_SIZE),
        items: page.map(|page| page.items.clone()).unwrap_or_default(),
        known_count: cache.known_count,
        has_more: page.is_some_and(|page| page.has_more),
        resource_epoch: view.epoch,
    };
    cache.order.retain(|&page| page != index);
    if cache.pages.contains_key(&index) {
        cache.order.push_back(index);
    }
    Ok(result)
}

pub(crate) fn read_cards(
    id: &str,
    revision: u64,
    hashes: Vec<String>,
) -> Result<CardResponse, String> {
    if hashes.len() > 64 {
        return Err("too many history card payloads".into());
    }
    let view = view(id, revision)?;
    let mut cards = Vec::new();
    for hash in hashes {
        if view.closed.load(Ordering::Acquire) {
            return Err("history view expired".into());
        }
        if let Ok(card) = crate::clipboard::history_card_payload(&hash, true) {
            cards.push(card);
        }
    }
    if view.closed.load(Ordering::Acquire) {
        return Err("history view expired".into());
    }
    Ok(CardResponse {
        token: view.token.clone(),
        resource_epoch: view.epoch,
        cards,
    })
}

pub(crate) fn cache_bytes() -> usize {
    VIEWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|view| {
            view.cache
                .try_lock()
                .map(|cache| cache.bytes + cache.anchors.len() * 128)
                .unwrap_or(CACHE_BYTES)
        })
        .sum()
}
