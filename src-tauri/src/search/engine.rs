use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::str::Chars;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use lazy_static::lazy_static;
use log::error;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{PhraseQuery, Query, TermQuery};
use tantivy::schema::*;
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use tantivy::{DocId, Index, IndexReader, IndexWriter, Searcher, SegmentReader, TantivyDocument};

use crate::app_runtime_dir;

const INDEX_READY_MARKER: &str = ".vpaste-search-v2";
const INDEX_BATCH_DELAY: Duration = Duration::from_millis(120);
const INDEX_BATCH_SIZE: usize = 32;
const MAX_PENDING_TEXT_BYTES: usize = 8 * 1024 * 1024;

lazy_static! {
    static ref ENGINE_LOCK: Mutex<()> = Mutex::new(());
    static ref RUNTIME: Mutex<Option<IndexRuntime>> = Mutex::new(None);
    static ref TEXT_OPTIONS: TextOptions = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("chars")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions)
            .set_fieldnorms(true)
    );
    pub static ref SCHEMA: Schema = {
        let mut schema_builder = Schema::builder();
        schema_builder.add_text_field("search_content", TEXT_OPTIONS.clone());
        schema_builder.add_u64_field("id", INDEXED | FAST);
        schema_builder.add_u64_field("time", FAST);
        schema_builder.add_text_field("hash", STRING | STORED);
        schema_builder.build()
    };
    static ref SEARCH_CONTENT_FIELD: Field = SCHEMA.get_field("search_content").unwrap();
    static ref ID_FIELD: Field = SCHEMA.get_field("id").unwrap();
    static ref TIME_FIELD: Field = SCHEMA.get_field("time").unwrap();
    static ref HASH_FIELD: Field = SCHEMA.get_field("hash").unwrap();
}

pub struct SearchPage {
    pub hashes: Vec<String>,
    pub has_more: bool,
}

pub struct SearchSession {
    searcher: Searcher,
    query: Box<dyn Query>,
    pending_matches: Vec<((u64, u64), String)>,
    pending_hashes: HashSet<String>,
}

struct SearchDocument {
    content: String,
    hash: String,
    id: u64,
    time: u64,
}

#[derive(Clone)]
struct PendingUpdate {
    revision: u64,
    deleted: bool,
    document: Option<Arc<SearchDocument>>,
}

#[derive(Default)]
struct PendingUpdates {
    entries: Mutex<HashMap<String, PendingUpdate>>,
    revision: AtomicU64,
    wake_queued: AtomicBool,
}

enum IndexCommand {
    Update,
    Rebuild(
        Vec<(u64, u64, String, String)>,
        mpsc::Sender<Result<(), String>>,
    ),
}

struct IndexRuntime {
    path: PathBuf,
    history_path: PathBuf,
    reader: IndexReader,
    pending: Arc<PendingUpdates>,
    sender: Option<mpsc::Sender<IndexCommand>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for IndexRuntime {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn index_dir() -> PathBuf {
    PathBuf::from(app_runtime_dir(&["search"]))
}

pub fn is_ready() -> bool {
    let path = index_dir();
    let history_path = PathBuf::from(crate::history_storage_dir()).join("vpaste.db");
    let mut runtime = RUNTIME.lock().unwrap();
    if runtime
        .as_ref()
        .is_some_and(|runtime| runtime.path != path || runtime.history_path != history_path)
    {
        runtime.take();
    }
    path.join(INDEX_READY_MARKER).is_file()
}

pub fn invalidate() {
    let _ = fs::remove_file(index_dir().join(INDEX_READY_MARKER));
}

#[cfg(test)]
pub(crate) fn shutdown_runtime_for_tests() {
    RUNTIME.lock().unwrap().take();
}

fn get_or_create_index(path: &PathBuf) -> Result<Index, String> {
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    let directory = MmapDirectory::open(&path).map_err(|err| err.to_string())?;
    let index = Index::open_or_create(directory, SCHEMA.clone()).map_err(|err| err.to_string())?;
    index.tokenizers().register("chars", CharTokenizer {});
    Ok(index)
}

fn with_runtime<T>(
    operation: impl FnOnce(&IndexRuntime) -> Result<T, String>,
) -> Result<T, String> {
    let path = index_dir();
    let history_path = PathBuf::from(crate::history_storage_dir()).join("vpaste.db");
    let mut runtime = RUNTIME
        .lock()
        .map_err(|_| "search runtime lock is poisoned".to_string())?;
    if runtime
        .as_ref()
        .is_some_and(|runtime| runtime.path != path || runtime.history_path != history_path)
    {
        runtime.take();
    }
    if runtime.is_none() {
        let index = get_or_create_index(&path)?;
        let writer = index.writer(50_000_000).map_err(|err| err.to_string())?;
        let reader = index.reader().map_err(|err| err.to_string())?;
        let pending = Arc::new(PendingUpdates::default());
        let (sender, receiver) = mpsc::channel();
        let worker_pending = pending.clone();
        let worker_reader = reader.clone();
        let worker_path = path.clone();
        let worker_history = history_path.clone();
        let worker = thread::spawn(move || {
            index_worker(
                writer,
                receiver,
                worker_pending,
                worker_reader,
                worker_path,
                worker_history,
            );
        });
        *runtime = Some(IndexRuntime {
            path,
            history_path,
            reader,
            pending,
            sender: Some(sender),
            worker: Some(worker),
        });
    }
    operation(runtime.as_ref().unwrap())
}

fn queue_update(
    runtime: &IndexRuntime,
    hash: &str,
    deleted: bool,
    document: Option<SearchDocument>,
) -> Result<(), String> {
    let mut entries = runtime.pending.entries.lock().unwrap();
    let retained_bytes: usize = entries
        .values()
        .filter_map(|update| update.document.as_ref())
        .map(|document| document.content.len())
        .sum();
    let document = document
        .filter(|document| {
            retained_bytes.saturating_add(document.content.len()) <= MAX_PENDING_TEXT_BYTES
        })
        .map(Arc::new);
    let revision = runtime.pending.revision.fetch_add(1, Ordering::SeqCst) + 1;
    entries.insert(
        hash.to_string(),
        PendingUpdate {
            revision,
            deleted,
            document,
        },
    );
    drop(entries);
    if !runtime.pending.wake_queued.swap(true, Ordering::SeqCst) {
        runtime
            .sender
            .as_ref()
            .unwrap()
            .send(IndexCommand::Update)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn insert(search_content: &str, hash: &str, id: &u64, time: u64) {
    if !is_ready() {
        return;
    }
    let result = with_runtime(|runtime| {
        let document = (search_content.len() <= MAX_PENDING_TEXT_BYTES).then(|| SearchDocument {
            content: search_content.to_string(),
            hash: hash.to_string(),
            id: *id,
            time,
        });
        queue_update(runtime, hash, false, document)
    });
    if let Err(err) = result {
        invalidate();
        error!("failed to queue clipboard search index update: {err}");
    }
}

pub fn delete(hash: &str) {
    delete_many(&[hash]);
}

pub fn delete_many(hashes: &[&str]) {
    if hashes.is_empty() || !is_ready() {
        return;
    }
    if let Err(err) = with_runtime(|runtime| {
        for hash in hashes {
            queue_update(runtime, hash, true, None)?;
        }
        Ok(())
    }) {
        invalidate();
        error!("failed to queue clipboard search index deletion: {err}");
    }
}

pub fn resume_pending_updates() -> Result<(), String> {
    use rusqlite::OpenFlags;
    with_runtime(|runtime| {
        let connection = rusqlite::Connection::open_with_flags(
            &runtime.history_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|err| err.to_string())?;
        let mut statement = connection
            .prepare("SELECT hash FROM clipboard WHERE search_index = 0")
            .map_err(|err| err.to_string())?;
        let hashes = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for hash in hashes {
            let hash = hash.map_err(|err| err.to_string())?;
            if !runtime.pending.entries.lock().unwrap().contains_key(&hash) {
                queue_update(runtime, &hash, false, None)?;
            }
        }
        Ok(())
    })
}

pub fn rebuild(documents: Vec<(u64, u64, String, String)>) -> Result<(), String> {
    {
        let path = index_dir();
        let mut runtime = RUNTIME.lock().unwrap();
        if runtime.as_ref().is_none_or(|runtime| runtime.path != path) {
            runtime.take();
            if path.exists() && get_or_create_index(&path).is_err() {
                fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
            }
        }
    }
    with_runtime(|runtime| {
        let (sender, receiver) = mpsc::channel();
        runtime
            .sender
            .as_ref()
            .unwrap()
            .send(IndexCommand::Rebuild(documents, sender))
            .map_err(|err| err.to_string())?;
        receiver.recv().map_err(|err| err.to_string())?
    })
}

fn add_document(
    writer: &IndexWriter<TantivyDocument>,
    document: &SearchDocument,
) -> Result<(), String> {
    writer.delete_term(Term::from_field_text(*HASH_FIELD, &document.hash));
    writer
        .add_document(doc!(
            *SEARCH_CONTENT_FIELD => document.content.to_lowercase(),
            *ID_FIELD => document.id,
            *TIME_FIELD => document.time,
            *HASH_FIELD => document.hash.clone()
        ))
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn stored_document(
    history_path: &PathBuf,
    hash: &str,
) -> Result<Option<crate::clipboard::StoredItem>, String> {
    use rusqlite::{OpenFlags, OptionalExtension};
    let connection =
        rusqlite::Connection::open_with_flags(history_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|err| err.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    connection
        .query_row(
            "SELECT * FROM clipboard WHERE hash = ?1",
            [hash],
            crate::clipboard::read_stored_item,
        )
        .optional()
        .map_err(|err| err.to_string())
}

fn document_from_stored(stored: &crate::clipboard::StoredItem) -> SearchDocument {
    SearchDocument {
        content: crate::clipboard::stored_item_search_content(stored),
        hash: stored.hash.clone(),
        id: stored.id as u64,
        time: stored.time,
    }
}

fn index_worker(
    mut writer: IndexWriter<TantivyDocument>,
    receiver: mpsc::Receiver<IndexCommand>,
    pending: Arc<PendingUpdates>,
    reader: IndexReader,
    path: PathBuf,
    history_path: PathBuf,
) {
    while let Ok(command) = receiver.recv() {
        if let IndexCommand::Rebuild(documents, reply) = command {
            let result = (|| {
                let _guard = ENGINE_LOCK.lock().unwrap();
                writer
                    .delete_all_documents()
                    .map_err(|err| err.to_string())?;
                for (id, time, content, hash) in documents {
                    add_document(
                        &writer,
                        &SearchDocument {
                            content,
                            hash,
                            id,
                            time,
                        },
                    )?;
                }
                writer.commit().map_err(|err| err.to_string())?;
                reader.reload().map_err(|err| err.to_string())?;
                fs::write(path.join(INDEX_READY_MARKER), b"1").map_err(|err| err.to_string())
            })();
            let _ = reply.send(result);
            continue;
        }
        thread::sleep(INDEX_BATCH_DELAY);
        pending.wake_queued.store(false, Ordering::SeqCst);
        loop {
            let batch = pending
                .entries
                .lock()
                .unwrap()
                .iter()
                .take(INDEX_BATCH_SIZE)
                .map(|(hash, update)| (hash.clone(), update.clone()))
                .collect::<Vec<_>>();
            if batch.is_empty() {
                break;
            }
            let started = Instant::now();
            let result = (|| {
                let _guard = ENGINE_LOCK.lock().unwrap();
                let mut retained = Vec::new();
                for (hash, update) in &batch {
                    writer.delete_term(Term::from_field_text(*HASH_FIELD, hash));
                    if !update.deleted {
                        if let Some(stored) = stored_document(&history_path, hash)? {
                            add_document(&writer, &document_from_stored(&stored))?;
                            retained.push(stored);
                        }
                    }
                }
                writer.commit().map_err(|err| err.to_string())?;
                reader.reload().map_err(|err| err.to_string())?;
                if !retained.is_empty() {
                    let connection = rusqlite::Connection::open_with_flags(
                        &history_path,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
                    )
                    .map_err(|err| err.to_string())?;
                    connection
                        .busy_timeout(Duration::from_secs(5))
                        .map_err(|err| err.to_string())?;
                    for stored in retained {
                        if !batch
                            .iter()
                            .find(|(hash, _)| hash == &stored.hash)
                            .is_some_and(|(hash, update)| {
                                pending
                                    .entries
                                    .lock()
                                    .unwrap()
                                    .get(hash)
                                    .is_some_and(|current| current.revision == update.revision)
                            })
                        {
                            continue;
                        }
                        // A capture may replace the row during commit; only acknowledge
                        // the durable version that was actually indexed, without holding
                        // the pending lock across a potentially busy SQLite write.
                        connection.execute("UPDATE clipboard SET search_index = 1 WHERE hash = ?1 AND time = ?2 AND content = ?3 AND preview_content = ?4 AND source = ?5 AND app_source = ?6", rusqlite::params![stored.hash, stored.time, stored.content, stored.preview_content, stored.source, stored.app_source]).map_err(|err| err.to_string())?;
                    }
                }
                Ok::<_, String>(())
            })();
            if let Err(err) = result {
                let _ = fs::remove_file(path.join(INDEX_READY_MARKER));
                error!("failed to publish clipboard search index batch: {err}");
                break;
            }
            let mut entries = pending.entries.lock().unwrap();
            for (hash, update) in &batch {
                if entries
                    .get(hash)
                    .is_some_and(|current| current.revision == update.revision)
                {
                    entries.remove(hash);
                }
            }
            log::info!(
                "clipboard index batch items={} elapsed_ms={}",
                batch.len(),
                started.elapsed().as_millis()
            );
        }
    }
}

#[cfg(test)]
pub fn search_page(keywords: &str, offset: usize, limit: usize) -> Result<SearchPage, String> {
    let normalized = keywords.trim().to_lowercase();
    if normalized.is_empty() || limit == 0 {
        return Ok(SearchPage {
            hashes: Vec::new(),
            has_more: false,
        });
    }
    start_search(&normalized)?.search_page(offset, limit)
}

pub fn start_search(keywords: &str) -> Result<SearchSession, String> {
    let normalized = keywords.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("clipboard search query is empty".to_string());
    }
    if !is_ready() {
        return Err("clipboard search index is not ready".to_string());
    }
    let (searcher, pending, history_path) = with_runtime(|runtime| {
        // Pair the reader with its overlay before the worker can retire updates.
        let entries = runtime.pending.entries.lock().unwrap();
        Ok((
            runtime.reader.searcher(),
            entries.clone(),
            runtime.history_path.clone(),
        ))
    })?;
    let pending_hashes = pending.keys().cloned().collect();
    let mut pending_matches = Vec::new();
    for (hash, update) in pending {
        if update.deleted {
            continue;
        }
        let document = match update.document {
            Some(document) => Some(document),
            None => stored_document(&history_path, &hash)?
                .map(|stored| Arc::new(document_from_stored(&stored))),
        };
        if let Some(document) = document {
            if document.content.to_lowercase().contains(&normalized) {
                pending_matches.push(((document.time, document.id), hash));
            }
        }
    }
    let terms = normalized
        .chars()
        .map(|character| Term::from_field_text(*SEARCH_CONTENT_FIELD, &character.to_string()))
        .collect::<Vec<_>>();
    let query: Box<dyn Query> = if terms.len() > 1 {
        Box::new(PhraseQuery::new(terms))
    } else {
        Box::new(TermQuery::new(terms[0].clone(), IndexRecordOption::Basic))
    };
    Ok(SearchSession {
        searcher,
        query,
        pending_matches,
        pending_hashes,
    })
}

impl SearchSession {
    pub fn search_page(&self, offset: usize, limit: usize) -> Result<SearchPage, String> {
        if limit == 0 {
            return Ok(SearchPage {
                hashes: Vec::new(),
                has_more: false,
            });
        }
        let index_offset = if self.pending_hashes.is_empty() {
            offset
        } else {
            0
        };
        let page_offset = offset - index_offset;
        let top_docs = TopDocs::with_limit(
            page_offset
                .saturating_add(limit)
                .saturating_add(self.pending_hashes.len())
                .saturating_add(1),
        )
        .and_offset(index_offset)
        .custom_score(|segment_reader: &SegmentReader| {
            let time_reader = segment_reader
                .fast_fields()
                .u64("time")
                .expect("time fast field should exist")
                .first_or_default_col(0);
            let id_reader = segment_reader
                .fast_fields()
                .u64("id")
                .expect("id fast field should exist")
                .first_or_default_col(0);
            move |doc: DocId| (time_reader.get_val(doc), id_reader.get_val(doc))
        });
        let matches = self
            .searcher
            .search(self.query.as_ref(), &top_docs)
            .map_err(|err| err.to_string())?;
        let mut matches = matches
            .into_iter()
            .map(|(score, address)| {
                let document = self
                    .searcher
                    .doc::<TantivyDocument>(address)
                    .map_err(|err| err.to_string())?;
                document
                    .get_first(*HASH_FIELD)
                    .and_then(|value| value.as_str())
                    .map(|hash| (score, hash.to_string()))
                    .ok_or_else(|| "search index document is missing its hash".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        matches.retain(|(_, hash)| !self.pending_hashes.contains(hash));
        matches.extend(self.pending_matches.iter().cloned());
        matches.sort_by(|left, right| right.0.cmp(&left.0));
        let has_more = matches.len() > page_offset.saturating_add(limit);
        let hashes = matches
            .into_iter()
            .skip(page_offset)
            .take(limit)
            .map(|(_, hash)| hash)
            .collect();
        Ok(SearchPage { hashes, has_more })
    }
}

#[test]
fn clipboard_capture_does_not_wait_for_search_index_work() {
    use std::sync::mpsc;
    use std::time::Duration;

    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().to_string());
    crate::config::save(crate::config::Config::default());
    crate::clipboard::db::init();
    crate::paste_queue::set_active(true);
    rebuild(Vec::new()).unwrap();

    let index_work = ENGINE_LOCK.lock().unwrap();
    let (sender, receiver) = mpsc::channel();
    let capture = std::thread::spawn(move || {
        let hashes = (0..12)
            .map(|index| {
                crate::clipboard::capture_text_from_app(
                    format!("queued capture {index}"),
                    "Browser",
                    "",
                    true,
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        sender.send(hashes).unwrap();
    });
    let captured_while_index_busy = receiver.recv_timeout(Duration::from_millis(500));
    drop(index_work);
    capture.join().unwrap();
    let queued = crate::paste_queue::ordered_hashes().unwrap();
    crate::paste_queue::set_active(false);
    RUNTIME.lock().unwrap().take();

    let expected = captured_while_index_busy
        .expect("clipboard capture must not wait for the search index writer");
    assert_eq!(queued, expected);
}

#[test]
fn rebuild_recovers_a_corrupted_index() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().to_string());
    RUNTIME.lock().unwrap().take();
    let path = index_dir();
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("meta.json"), b"corrupted index metadata").unwrap();

    rebuild(vec![(
        1,
        1,
        "recovered needle".to_string(),
        "recovered".to_string(),
    )])
    .unwrap();
    assert_eq!(
        search_page("needle", 0, 10).unwrap().hashes,
        vec!["recovered"]
    );
    RUNTIME.lock().unwrap().take();
}

#[test]
fn background_indexing_uses_the_current_durable_record() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().to_string());
    crate::config::save(crate::config::Config::default());
    crate::clipboard::db::init();
    rebuild(Vec::new()).unwrap();
    let index_work = ENGINE_LOCK.lock().unwrap();
    let hash =
        crate::clipboard::capture_text_from_app("old needle".to_string(), "Browser", "", false)
            .unwrap();
    crate::clipboard::db::db().execute("UPDATE clipboard SET content = 'current needle', preview_content = 'current needle' WHERE hash = ?1", [&hash]).unwrap();
    drop(index_work);
    RUNTIME.lock().unwrap().take();

    assert_eq!(
        search_page("current needle", 0, 10).unwrap().hashes,
        vec![hash]
    );
    assert!(search_page("old needle", 0, 10).unwrap().hashes.is_empty());
    RUNTIME.lock().unwrap().take();
}

#[test]
fn pending_captures_are_searchable_without_waiting_for_the_writer() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().to_string());
    crate::config::save(crate::config::Config::default());
    crate::clipboard::db::init();
    rebuild(Vec::new()).unwrap();

    let index_work = ENGINE_LOCK.lock().unwrap();
    let hashes = (0..5)
        .map(|index| {
            crate::clipboard::capture_text_from_app(
                format!("即时 searchable {index}"),
                "Browser",
                "",
                false,
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let session = start_search("即时 searchable").unwrap();
    let first = session.search_page(0, 2).unwrap();
    let second = session.search_page(2, 2).unwrap();
    let last = session.search_page(4, 2).unwrap();
    let expected = hashes.into_iter().rev().collect::<Vec<_>>();
    assert_eq!(first.hashes, expected[..2]);
    assert_eq!(second.hashes, expected[2..4]);
    assert_eq!(last.hashes, expected[4..]);
    assert!(first.has_more && second.has_more && !last.has_more);
    drop(index_work);
    RUNTIME.lock().unwrap().take();
}

#[test]
fn pending_updates_resume_from_history_after_runtime_restart() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().to_string());
    crate::config::save(crate::config::Config::default());
    crate::clipboard::db::init();
    rebuild(Vec::new()).unwrap();
    RUNTIME.lock().unwrap().take();
    let connection = crate::clipboard::db::db();
    connection.execute("INSERT INTO clipboard(hash,time,content,preview_content,item_type,source,app_source,app_icon_path,title_color,search_index,label) VALUES('pending',1,'crash recovery needle','crash recovery needle','Text','','Browser','','',0,0)", []).unwrap();

    resume_pending_updates().unwrap();
    assert_eq!(
        search_page("recovery needle", 0, 10).unwrap().hashes,
        vec!["pending"]
    );
    RUNTIME.lock().unwrap().take();
    let indexed: u8 = connection
        .query_row(
            "SELECT search_index FROM clipboard WHERE hash = 'pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 1);
    assert_eq!(
        search_page("recovery needle", 0, 10).unwrap().hashes,
        vec!["pending"]
    );
    RUNTIME.lock().unwrap().take();
}

#[test]
fn pending_deletion_and_recopy_do_not_resurrect_stale_index_entries() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = Some(root.path().to_string_lossy().to_string());
    crate::config::save(crate::config::Config::default());
    crate::clipboard::db::init();
    rebuild(Vec::new()).unwrap();
    let hash =
        crate::clipboard::capture_text_from_app("copy needle".to_string(), "Browser", "", false)
            .unwrap();
    RUNTIME.lock().unwrap().take();
    let index_work = ENGINE_LOCK.lock().unwrap();
    delete(&hash);
    assert!(search_page("needle", 0, 10).unwrap().hashes.is_empty());
    assert_eq!(
        crate::clipboard::capture_text_from_app("copy needle".to_string(), "Browser", "", false),
        Some(hash.clone())
    );
    assert_eq!(search_page("needle", 0, 10).unwrap().hashes, vec![hash]);
    drop(index_work);
    RUNTIME.lock().unwrap().take();
}

#[test]
fn rebuilt_index_returns_unicode_phrase_matches() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let temp_dir = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
        Some(temp_dir.path().to_string_lossy().to_string());
    rebuild(vec![
        (1, 1, "普通内容".to_string(), "other".to_string()),
        (2, 2, "需要迁移的中文内容".to_string(), "match".to_string()),
    ])
    .unwrap();

    assert_eq!(
        search_page("迁移的中文", 0, 10).unwrap().hashes,
        vec!["match"]
    );
    shutdown_runtime_for_tests();
}

#[test]
fn bulk_delete_removes_selected_documents_and_keeps_other_search_results() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let temp_dir = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
        Some(temp_dir.path().to_string_lossy().to_string());
    rebuild(vec![
        (1, 1, "cleanup needle".to_string(), "remove-a".to_string()),
        (2, 2, "cleanup needle".to_string(), "remove-b".to_string()),
        (3, 3, "cleanup needle".to_string(), "keep".to_string()),
    ])
    .unwrap();

    delete_many(&["remove-a", "remove-b"]);

    assert_eq!(search_page("needle", 0, 10).unwrap().hashes, vec!["keep"]);
    shutdown_runtime_for_tests();
}

#[test]
fn paged_search_preserves_time_and_id_order() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let temp_dir = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
        Some(temp_dir.path().to_string_lossy().to_string());
    rebuild(vec![
        (
            1,
            30,
            "needle".to_string(),
            "same-time-older-id".to_string(),
        ),
        (3, 20, "needle".to_string(), "older-time".to_string()),
        (
            2,
            30,
            "needle".to_string(),
            "same-time-newer-id".to_string(),
        ),
    ])
    .unwrap();

    let first = search_page("needle", 0, 2).unwrap();
    let second = search_page("needle", 2, 2).unwrap();

    assert_eq!(
        first.hashes,
        vec!["same-time-newer-id", "same-time-older-id"]
    );
    assert!(first.has_more);
    assert_eq!(second.hashes, vec!["older-time"]);
    assert!(!second.has_more);
    shutdown_runtime_for_tests();
}

#[test]
fn paged_search_bounds_broad_match_candidates() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let temp_dir = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
        Some(temp_dir.path().to_string_lossy().to_string());
    rebuild(
        (0..5_000)
            .map(|index| {
                (
                    index as u64,
                    index as u64,
                    "common needle".to_string(),
                    format!("match-{index}"),
                )
            })
            .collect(),
    )
    .unwrap();

    let started = std::time::Instant::now();
    let page = search_page("needle", 0, 400).unwrap();
    println!(
        "bounded broad search returned {} candidates in {}ms",
        page.hashes.len(),
        started.elapsed().as_millis()
    );

    assert_eq!(page.hashes.len(), 400);
    assert!(page.has_more);
    shutdown_runtime_for_tests();
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CharTokenizer;

pub struct CharTokenStream<'a> {
    char_indices: Chars<'a>,
    token: Token,
    offset: usize,
}

impl Tokenizer for CharTokenizer {
    type TokenStream<'a> = CharTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> CharTokenStream<'a> {
        CharTokenStream {
            char_indices: text.chars(),
            token: Token {
                offset_from: 0,
                offset_to: 0,
                position: 0,
                text: "".to_string(),
                position_length: 1,
            },
            offset: 0,
        }
    }
}

impl<'a> TokenStream for CharTokenStream<'a> {
    fn advance(&mut self) -> bool {
        if let Some(ch) = self.char_indices.next() {
            self.token.offset_from = self.offset;
            self.token.offset_to = self.offset + 1;
            self.token.position = self.offset;
            self.token.text = ch.to_string();
            self.offset += 1;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.token
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}
