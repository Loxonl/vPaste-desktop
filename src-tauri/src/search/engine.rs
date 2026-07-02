use std::collections::Bound;
use std::fs;
use std::path::PathBuf;
use std::str::Chars;

#[cfg(test)]
use crate::clipboard::current_timestamp_millis;
use lazy_static::lazy_static;
use log::info;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, FastFieldRangeWeight, PhraseQuery, QueryClone, TermQuery};
use tantivy::schema::*;
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use tantivy::{Index, IndexWriter, Order, TantivyDocument};

use crate::app_runtime_dir;

lazy_static! {
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
        schema_builder.add_text_field("hash", STRING | STORED);
        schema_builder.build()
    };
    static ref SEARCH_CONTENT_FIELD: Field = SCHEMA.get_field("search_content").unwrap();
    static ref ID_FIELD: Field = SCHEMA.get_field("id").unwrap();
    static ref HASH_FIELD: Field = SCHEMA.get_field("hash").unwrap();
}
// 在程序启动或需要时调用
fn get_or_create_index() -> Index {
    let data_dir = app_runtime_dir(&["search"]);
    let path = data_dir;
    let pathbuf = PathBuf::from(&path);
    if !pathbuf.exists() {
        match fs::create_dir_all(&pathbuf) {
            Ok(_) => info!("search 索引目录已成功创建: {:?}", pathbuf),
            Err(e) => info!("创建 search 索引目录时出错: {} {:?}", &path, e),
        }
    }
    let index = Index::open_or_create(
        MmapDirectory::open(&path).expect("open path path error"),
        SCHEMA.clone(),
    )
    .unwrap();
    index.tokenizers().register("chars", CharTokenizer {});
    index
}

pub fn insert(search_content: &str, hash: &str, id: &u64) {
    let _ = (search_content, hash, id);
    return;
    #[allow(unreachable_code)]
    {
        let index = get_or_create_index();
        let mut index_writer: IndexWriter<TantivyDocument> = index
            .writer(50_000_000)
            .expect("Failed to create index writer");
        let _ = index_writer.add_document(doc!(
            *SEARCH_CONTENT_FIELD => search_content.to_lowercase(),
            *ID_FIELD =>*id,
            *HASH_FIELD=>hash
        ));
        let _ = index_writer.commit();
    }
}

#[allow(dead_code)]
pub fn delete(hash: &str) {
    let index = get_or_create_index();
    let mut index_writer: IndexWriter<TantivyDocument> = index
        .writer(50_000_000)
        .expect("Failed to create index writer");
    index_writer.delete_term(Term::from_field_text(*HASH_FIELD, hash));
    let _ = index_writer.commit();
}

pub fn rebuild(documents: Vec<(u64, String, String)>) -> Result<(), String> {
    let _ = documents;
    let path = PathBuf::from(app_runtime_dir(&["search"]));
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
    }
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    return Ok(());
    #[allow(unreachable_code)]
    {
        let index = get_or_create_index();
        let mut index_writer: IndexWriter<TantivyDocument> =
            index.writer(50_000_000).map_err(|err| err.to_string())?;
        for (id, content, hash) in documents {
            let _ = index_writer.add_document(doc!(
                *SEARCH_CONTENT_FIELD => content.to_lowercase(),
                *ID_FIELD => id,
                *HASH_FIELD => hash
            ));
        }
        index_writer.commit().map_err(|err| err.to_string())?;
        Ok(())
    }
}

#[allow(dead_code)]
pub fn search(keywords: &str, last_id: u64, limit: usize, _label: &str) -> Vec<String> {
    let _ = (keywords, last_id, limit, _label);
    return Vec::new();
    #[allow(unreachable_code)]
    {
        let mut querys: Vec<_> = Vec::new();
        querys.push(
            FastFieldRangeWeight::new("id".to_string(), Bound::Unbounded, Bound::Included(last_id))
                .box_clone(),
        );
        let terms: Vec<Term> = keywords
            .chars()
            .map(|keyword| {
                Term::from_field_text(
                    *SEARCH_CONTENT_FIELD,
                    keyword.to_lowercase().to_string().as_str(),
                )
            })
            .collect();
        if terms.len() > 1 {
            querys.push(PhraseQuery::new(terms).box_clone());
        } else {
            querys.push(
                TermQuery::new(
                    Term::from_field_text(*SEARCH_CONTENT_FIELD, keywords),
                    IndexRecordOption::Basic,
                )
                .box_clone(),
            );
        }
        let query = BooleanQuery::intersection(querys);
        let top_docs = TopDocs::with_limit(limit).order_by_u64_field("id", Order::Desc);
        let index = get_or_create_index();
        let reader = index.reader().unwrap();
        let searcher = reader.searcher();
        let result = searcher.search(&query, &top_docs).unwrap();
        let result = result
            .iter()
            .map(|r| {
                let retrieved_doc = searcher.doc::<TantivyDocument>(r.1).unwrap();
                info!(
                    "SEARCH_CONTENT_FIELD: {:?}",
                    retrieved_doc
                        .get_first(*SEARCH_CONTENT_FIELD)
                        .and_then(|v| v.as_str())
                );
                let hash = retrieved_doc
                    .get_first(*HASH_FIELD)
                    .and_then(|value| value.as_str())
                    .unwrap()
                    .to_string();
                hash
            })
            .collect();
        info!(
            "search engine {} {} {} {:?}",
            keywords, last_id, limit, result
        );
        result
    }
}

#[test]
fn test_search() {
    let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let temp_dir = tempfile::tempdir().unwrap();
    *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
        Some(temp_dir.path().to_string_lossy().to_string());

    insert("调莒斡缺蟲螑恽咆峈疬铐拭吩床糊丷勎勶伭鎓呃胰饁嗹褐齊脛悚疳攱艆政变秳绪语瀍旀豐纶槢害掜試殅藔餣鯞甗杦", "1", &current_timestamp_millis());
    info!(
        "search result: {:?}",
        search("调莒", current_timestamp_millis(), 100, "")
    );
    info!(
        "index num_docs: {}",
        get_or_create_index()
            .reader()
            .unwrap()
            .searcher()
            .num_docs()
    )
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
