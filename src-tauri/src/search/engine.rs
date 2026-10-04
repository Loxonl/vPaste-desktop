use std::fs;
use std::path::PathBuf;
use std::str::Chars;
use std::sync::{Mutex, MutexGuard};

use lazy_static::lazy_static;
use log::error;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{PhraseQuery, Query, TermQuery};
use tantivy::schema::*;
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use tantivy::{DocId, Index, IndexWriter, Searcher, SegmentReader, TantivyDocument};

use crate::app_runtime_dir;

const INDEX_READY_MARKER: &str = ".vpaste-search-v2";

lazy_static! {
    static ref ENGINE_LOCK: Mutex<()> = Mutex::new(());
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
    _guard: MutexGuard<'static, ()>,
    searcher: Searcher,
    query: Box<dyn Query>,
}

fn index_dir() -> PathBuf {
    PathBuf::from(app_runtime_dir(&["search"]))
}

pub fn is_ready() -> bool {
    index_dir().join(INDEX_READY_MARKER).is_file()
}

pub fn invalidate() {
    let _ = fs::remove_file(index_dir().join(INDEX_READY_MARKER));
}

fn get_or_create_index() -> Result<Index, String> {
    let path = index_dir();
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    let directory = MmapDirectory::open(&path).map_err(|err| err.to_string())?;
    let index = Index::open_or_create(directory, SCHEMA.clone()).map_err(|err| err.to_string())?;
    index.tokenizers().register("chars", CharTokenizer {});
    Ok(index)
}

pub fn insert(search_content: &str, hash: &str, id: &u64, time: u64) {
    if let Err(err) = insert_inner(search_content, hash, id, time) {
        invalidate();
        error!("failed to update clipboard search index: {err}");
    }
}

fn insert_inner(search_content: &str, hash: &str, id: &u64, time: u64) -> Result<(), String> {
    let _guard = ENGINE_LOCK
        .lock()
        .map_err(|_| "search index lock is poisoned".to_string())?;
    if !is_ready() {
        return Ok(());
    }
    let index = get_or_create_index()?;
    let mut index_writer: IndexWriter<TantivyDocument> =
        index.writer(50_000_000).map_err(|err| err.to_string())?;
    index_writer.delete_term(Term::from_field_text(*HASH_FIELD, hash));
    index_writer
        .add_document(doc!(
            *SEARCH_CONTENT_FIELD => search_content.to_lowercase(),
            *ID_FIELD => *id,
            *TIME_FIELD => time,
            *HASH_FIELD => hash
        ))
        .map_err(|err| err.to_string())?;
    index_writer.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn delete(hash: &str) {
    if let Err(err) = delete_inner(hash) {
        invalidate();
        error!("failed to delete clipboard search index entry: {err}");
    }
}

pub fn delete_many(hashes: &[&str]) {
    if hashes.is_empty() {
        return;
    }
    if let Err(err) = delete_many_inner(hashes) {
        invalidate();
        error!("failed to delete clipboard search index entries: {err}");
    }
}

fn delete_many_inner(hashes: &[&str]) -> Result<(), String> {
    let _guard = ENGINE_LOCK
        .lock()
        .map_err(|_| "search index lock is poisoned".to_string())?;
    if !is_ready() {
        return Ok(());
    }
    let index = get_or_create_index()?;
    let mut index_writer: IndexWriter<TantivyDocument> =
        index.writer(50_000_000).map_err(|err| err.to_string())?;
    for hash in hashes {
        index_writer.delete_term(Term::from_field_text(*HASH_FIELD, hash));
    }
    index_writer.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn delete_inner(hash: &str) -> Result<(), String> {
    let _guard = ENGINE_LOCK
        .lock()
        .map_err(|_| "search index lock is poisoned".to_string())?;
    if !is_ready() {
        return Ok(());
    }
    let index = get_or_create_index()?;
    let mut index_writer: IndexWriter<TantivyDocument> =
        index.writer(50_000_000).map_err(|err| err.to_string())?;
    index_writer.delete_term(Term::from_field_text(*HASH_FIELD, hash));
    index_writer.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn rebuild(documents: Vec<(u64, u64, String, String)>) -> Result<(), String> {
    let _guard = ENGINE_LOCK
        .lock()
        .map_err(|_| "search index lock is poisoned".to_string())?;
    let path = index_dir();
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
    }
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    let index = get_or_create_index()?;
    let mut index_writer: IndexWriter<TantivyDocument> =
        index.writer(50_000_000).map_err(|err| err.to_string())?;
    for (id, time, content, hash) in documents {
        index_writer
            .add_document(doc!(
                *SEARCH_CONTENT_FIELD => content.to_lowercase(),
                *ID_FIELD => id,
                *TIME_FIELD => time,
                *HASH_FIELD => hash
            ))
            .map_err(|err| err.to_string())?;
    }
    index_writer.commit().map_err(|err| err.to_string())?;
    fs::write(path.join(INDEX_READY_MARKER), b"1").map_err(|err| err.to_string())?;
    Ok(())
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
    let guard = ENGINE_LOCK
        .lock()
        .map_err(|_| "search index lock is poisoned".to_string())?;
    if !is_ready() {
        return Err("clipboard search index is not ready".to_string());
    }
    let index = get_or_create_index()?;
    let reader = index.reader().map_err(|err| err.to_string())?;
    let searcher = reader.searcher();
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
        _guard: guard,
        searcher,
        query,
    })
}

impl SearchSession {
    pub fn search_page(&self, offset: usize, limit: usize) -> Result<SearchPage, String> {
        if limit == 0 || self.searcher.num_docs() == 0 {
            return Ok(SearchPage {
                hashes: Vec::new(),
                has_more: false,
            });
        }
        let top_docs = TopDocs::with_limit(limit.saturating_add(1))
            .and_offset(offset)
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
        let mut matches = self
            .searcher
            .search(self.query.as_ref(), &top_docs)
            .map_err(|err| err.to_string())?;
        let has_more = matches.len() > limit;
        matches.truncate(limit);
        let hashes = matches
            .into_iter()
            .map(|(_, address)| {
                let document = self
                    .searcher
                    .doc::<TantivyDocument>(address)
                    .map_err(|err| err.to_string())?;
                document
                    .get_first(*HASH_FIELD)
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| "search index document is missing its hash".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SearchPage { hashes, has_more })
    }
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
