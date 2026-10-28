use infer::MatcherType;
use lazy_static::lazy_static;
use log::warn;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, Result};
use std::path::Path;
use std::sync::RwLock;
use std::time::Duration;

use crate::history_storage_dir;
use crate::search::engine;

lazy_static! {
    static ref POOL: RwLock<Option<(String, Pool<SqliteConnectionManager>)>> = RwLock::new(None);
}

fn current_db_path() -> String {
    Path::new(&history_storage_dir())
        .join("vpaste.db")
        .to_string_lossy()
        .to_string()
}

fn setup_pool(db_path: &str) -> Result<Pool<SqliteConnectionManager>> {
    let connection = Connection::open(db_path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    init_schema(&connection)?;
    if let Err(err) = connection.pragma_update(None, "journal_mode", "WAL") {
        warn!(
            "failed to enable WAL for clipboard database {}; continuing with the current journal mode: {}",
            db_path, err
        );
    }
    drop(connection);

    let manager = SqliteConnectionManager::file(db_path)
        .with_init(|connection| connection.busy_timeout(Duration::from_secs(5)));
    let pool = Pool::new(manager).unwrap();
    Ok(pool)
}

fn try_db() -> Result<PooledConnection<SqliteConnectionManager>> {
    let db_path = current_db_path();
    {
        let pool = POOL.read().unwrap();
        if let Some((cached, pool)) = pool.as_ref() {
            if cached == &db_path {
                return Ok(pool.get().unwrap());
            }
        }
    }
    let mut pool = POOL.write().unwrap();
    if let Some((cached, pool)) = pool.as_ref() {
        if cached == &db_path {
            return Ok(pool.get().unwrap());
        }
    }
    let next_pool = setup_pool(&db_path)?;
    let connection = next_pool.get().unwrap();
    *pool = Some((db_path, next_pool));
    Ok(connection)
}

pub fn try_init() -> Result<()> {
    try_db().map(drop)
}

pub fn db() -> PooledConnection<SqliteConnectionManager> {
    try_db().expect("open supported history database")
}

#[cfg(test)]
pub fn init() {
    try_init().expect("initialize supported history database");
}

const HISTORY_SCHEMA_VERSION: u32 = 1;

fn unsupported_database(detail: &str) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
        Some(format!(
            "Unsupported history database ({detail}). The supported baseline is plaintext v1.6.0; no data has been changed."
        )),
    )
}

pub fn validate_schema(conn: &Connection) -> Result<()> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > HISTORY_SCHEMA_VERSION {
        return Err(unsupported_database("format version"));
    }
    for query in [
        "SELECT id, hash, time, content, preview_content, item_type, search_index, source, app_source, app_icon_path, title_color, icon, label FROM clipboard LIMIT 0",
        "SELECT id, name, priority FROM label LIMIT 0",
        "SELECT id, name, created_at, updated_at FROM tags LIMIT 0",
        "SELECT clipboard_id, tag_id, created_at FROM clipboard_tags LIMIT 0",
        "SELECT hash, position, queued_at, time, content, preview_content, item_type, search_index, source, app_source, app_icon_path, title_color, label FROM paste_queue LIMIT 0",
    ] {
        conn.prepare(query).map_err(|_| unsupported_database("table layout"))?;
    }
    let queue_foreign_keys: i64 = conn.query_row(
        "SELECT count(*) FROM pragma_foreign_key_list('paste_queue')",
        [],
        |row| row.get(0),
    )?;
    let unique_hash: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_index_list('clipboard') WHERE name='hash' AND \"unique\"=1)", [], |row| row.get(0),
    )?;
    let hash_columns = conn
        .prepare("SELECT name FROM pragma_index_info('hash')")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>>>()?;
    if queue_foreign_keys != 0 || !unique_hash || hash_columns != ["hash"] {
        return Err(unsupported_database("index or queue layout"));
    }
    // Unmarked databases include all supported v1.6.x installations. Confirm
    // plaintext once; marked databases never scan history payloads on startup.
    if version == 0 {
        for table in ["clipboard", "paste_queue"] {
            let encrypted: bool = conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE content LIKE 'vpaste-secure:v2:%' OR preview_content LIKE 'vpaste-secure:v2:%' OR source LIKE 'vpaste-secure:v2:%')"),
                [], |row| row.get(0),
            )?;
            if encrypted {
                return Err(unsupported_database("payload format"));
            }
        }
    }
    Ok(())
}

pub fn validate_existing_database(path: &Path) -> Result<()> {
    if !path.exists() || path.metadata().is_ok_and(|metadata| metadata.len() == 0) {
        return Ok(());
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_schema(&conn)
}

pub fn init_schema(conn: &Connection) -> Result<()> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > HISTORY_SCHEMA_VERSION {
        return Err(unsupported_database("format version"));
    }
    let has_tables: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
        [], |row| row.get(0),
    )?;
    if has_tables {
        validate_schema(conn)?;
        if version == 0 {
            conn.pragma_update(None, "user_version", HISTORY_SCHEMA_VERSION)?;
        }
        return Ok(());
    }
    let sql = "
-- auto-generated definition
create table if not exists clipboard
(
    id              integer           not null
        constraint id
            primary key autoincrement,
    hash            text              not null,
    time            integer           not null,
    content         text,
    preview_content text,
    item_type       text,
    search_index    integer,
    source          text,
    app_source      text default '' not null,
    app_icon_path   text default '' not null,
    title_color     text,
    icon            text,
    label           integer default 0 not null
)
    strict;

create table if not exists label
(
    id       integer not null
        constraint id
            primary key autoincrement,
    name     text,
    priority integer
);

insert or ignore into label(id,name,priority)
values(0,'剪切板',0);
insert or ignore into label(id,name,priority)
values(1,'个人收藏',1);

create table if not exists tags
(
    id         integer not null
        constraint id
            primary key autoincrement,
    name       text    not null,
    created_at integer not null,
    updated_at integer not null
)
    strict;

create unique index if not exists tags_name_unique on tags(name collate nocase);

create table if not exists clipboard_tags
(
    clipboard_id integer not null,
    tag_id       integer not null,
    created_at   integer not null,
    primary key (clipboard_id, tag_id),
    foreign key (clipboard_id) references clipboard(id) on delete cascade,
    foreign key (tag_id) references tags(id) on delete cascade
)
    strict;

create index if not exists clipboard_tags_tag_id on clipboard_tags(tag_id);
create index if not exists clipboard_tags_clipboard_id on clipboard_tags(clipboard_id);

create table if not exists paste_queue
(
    hash            text    not null primary key,
    position        integer not null,
    queued_at       integer not null,
    time            integer not null,
    content         text    default '' not null,
    preview_content text    default '' not null,
    item_type       text    not null,
    search_index    integer default 1 not null,
    source          text    default '' not null,
    app_source      text    default '' not null,
    app_icon_path   text    default '' not null,
    title_color     text    default '' not null,
    label           integer default 0 not null
)
    strict;

create unique index if not exists paste_queue_position on paste_queue(position);
create unique index if not exists hash on clipboard(hash);

    ";
    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(sql)?;
    transaction.pragma_update(None, "user_version", HISTORY_SCHEMA_VERSION)?;
    transaction.commit()
}

pub fn clear_all() -> Result<usize> {
    let mut conn = db();
    let transaction = conn.transaction()?;
    transaction.execute("DELETE FROM clipboard_tags", [])?;
    let affected = transaction.execute("DELETE FROM clipboard", [])?;
    transaction.commit()?;
    Ok(affected)
}

pub fn clear_images() -> Result<usize> {
    let mut conn = db();
    let image_items = {
        let mut statement = conn.prepare("SELECT id, hash, item_type, content FROM clipboard")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>>>()?;
        rows.into_iter()
            .filter(|(_, _, item_type, content)| {
                let content = content.to_string();
                item_type == "Image" || (item_type == "File" && is_single_image_file(&content))
            })
            .collect::<Vec<_>>()
    };

    for (_, hash, _, _) in &image_items {
        engine::delete(&hash);
    }

    let ids = image_items
        .iter()
        .map(|(id, _, _, _)| id.to_string())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(0);
    }

    let transaction = conn.transaction()?;
    transaction.execute(
        format!(
            "DELETE FROM clipboard_tags WHERE clipboard_id IN ({})",
            ids.join(",")
        )
        .as_str(),
        [],
    )?;

    let affected = transaction.execute(
        format!("DELETE FROM clipboard WHERE id IN ({})", ids.join(",")).as_str(),
        [],
    )?;
    transaction.commit()?;
    Ok(affected)
}

fn is_single_image_file(content: &str) -> bool {
    let files: serde_json::Result<Vec<String>> = serde_json::from_str(content);
    let Ok(files) = files else {
        return false;
    };
    if files.len() != 1 {
        return false;
    }

    infer::get_from_path(&files[0])
        .ok()
        .flatten()
        .is_some_and(|mime_type| mime_type.matcher_type() == MatcherType::Image)
}

#[cfg(test)]
mod tests {
    use super::{init_schema, setup_pool};
    use rusqlite::Connection;
    use std::time::Duration;

    fn schema_sql(connection: &Connection) -> Vec<String> {
        connection
            .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn unmarked_supported_history_is_adopted_without_changing_schema_or_payloads() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO clipboard(hash,time,content) VALUES('kept',1,'body')",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 0).unwrap();
        let before = schema_sql(&connection);
        init_schema(&connection).unwrap();
        assert_eq!(schema_sql(&connection), before);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT content FROM clipboard", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "body"
        );
    }

    #[test]
    fn rejected_storage_path_does_not_replace_the_supported_pool_or_modify_the_file() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(root.path().to_string_lossy().into_owned());
        crate::config::save(crate::config::Config::default());
        super::try_init().unwrap();
        super::db()
            .execute(
                "INSERT INTO clipboard(hash,time,content) VALUES('kept',1,'body')",
                [],
            )
            .unwrap();
        let unsupported = root.path().join("unsupported");
        std::fs::create_dir(&unsupported).unwrap();
        let path = unsupported.join("vpaste.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE clipboard(content TEXT); INSERT INTO clipboard VALUES('untouched');",
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();
        crate::config::update(|config| {
            config.storage_dir = unsupported.to_string_lossy().into_owned()
        });
        assert!(super::try_init().is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
        crate::config::save(crate::config::Config::default());
        assert_eq!(
            super::db()
                .query_row("SELECT content FROM clipboard", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "body"
        );
    }

    #[test]
    fn unmarked_encrypted_payload_is_rejected_without_changing_the_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("vpaste.db");
        let connection = Connection::open(&path).unwrap();
        init_schema(&connection).unwrap();
        connection.execute("INSERT INTO clipboard(hash,time,content) VALUES('old',1,'vpaste-secure:v2:ciphertext')", []).unwrap();
        connection.pragma_update(None, "user_version", 0).unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();
        assert!(super::validate_existing_database(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn future_database_version_is_rejected_without_rewriting_its_marker() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        let before = schema_sql(&connection);
        assert!(init_schema(&connection).is_err());
        assert_eq!(schema_sql(&connection), before);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn marked_history_does_not_treat_copied_format_marker_text_as_a_migration() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection.execute("INSERT INTO clipboard(hash,time,content) VALUES('literal',1,'vpaste-secure:v2:example')", []).unwrap();
        init_schema(&connection).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM clipboard", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn supported_history_reopen_does_not_rebuild_schema_or_lose_payloads() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection.execute_batch(
            "INSERT INTO clipboard(hash,time,content,item_type,label) VALUES('kept',1,'body','Text',1);
             INSERT INTO tags(id,name,created_at,updated_at) VALUES(1,'kept tag',1,1);
             INSERT INTO clipboard_tags(clipboard_id,tag_id,created_at) VALUES(1,1,1);
             INSERT INTO paste_queue(hash,position,queued_at,time,content,item_type) VALUES('kept',0,1,1,'queued body','Text');"
        ).unwrap();
        let before: i64 = connection
            .pragma_query_value(None, "schema_version", |row| row.get(0))
            .unwrap();
        init_schema(&connection).unwrap();
        let after: i64 = connection
            .pragma_query_value(None, "schema_version", |row| row.get(0))
            .unwrap();
        assert_eq!(
            before, after,
            "opening supported history must not rebuild its indexes"
        );
        let saved: (String, i64, String, i64) = connection
            .query_row(
                "SELECT c.content, c.label, q.content, (SELECT count(*) FROM clipboard_tags)
             FROM clipboard c JOIN paste_queue q ON q.hash=c.hash",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(saved, ("body".into(), 1, "queued body".into(), 1));
    }

    #[test]
    fn unsupported_history_schema_is_rejected_without_mutation() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE clipboard(id INTEGER PRIMARY KEY, content TEXT);
             INSERT INTO clipboard VALUES(1,'untouched');",
            )
            .unwrap();
        let before = schema_sql(&connection);
        assert!(init_schema(&connection).is_err());
        assert_eq!(before, schema_sql(&connection));
        assert_eq!(
            connection
                .query_row("SELECT content FROM clipboard", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "untouched"
        );
    }

    #[test]
    fn unsupported_queue_is_rejected_instead_of_migrated() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection
            .execute_batch(
                "DROP TABLE paste_queue;
             CREATE TABLE paste_queue(hash TEXT PRIMARY KEY, position INTEGER, queued_at INTEGER);
             INSERT INTO paste_queue VALUES('untouched',0,1);",
            )
            .unwrap();
        let before = schema_sql(&connection);
        assert!(init_schema(&connection).is_err());
        assert_eq!(before, schema_sql(&connection));
        assert_eq!(
            connection
                .query_row("SELECT hash FROM paste_queue", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "untouched"
        );
    }

    #[test]
    fn invalid_hash_index_is_rejected_without_deleting_duplicate_history() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection.execute_batch(
            "DROP INDEX hash;
             INSERT INTO clipboard(hash,time,content) VALUES('same',1,'first'),('same',2,'second');"
        ).unwrap();
        assert!(init_schema(&connection).is_err());
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM clipboard", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn pooled_connections_allow_writes_while_a_reader_is_active() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("clipboard.db");
        let pool = setup_pool(database_path.to_str().unwrap()).unwrap();
        let reader = pool.get().unwrap();
        reader
            .execute_batch(
                "create table clipboard_test(id integer primary key, content text);
                 insert into clipboard_test(content) values('first');",
            )
            .unwrap();

        let mut statement = reader
            .prepare("select content from clipboard_test")
            .unwrap();
        let mut rows = statement.query([]).unwrap();
        assert!(rows.next().unwrap().is_some());

        let writer = pool.get().unwrap();
        writer.busy_timeout(Duration::from_millis(100)).unwrap();
        writer
            .execute("insert into clipboard_test(content) values('second')", [])
            .expect("an active history reader must not block clipboard writes");
    }

    #[test]
    fn paste_queue_schema_survives_database_reopen() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("queue.db");
        {
            let connection = Connection::open(&database_path).unwrap();
            init_schema(&connection).unwrap();
            connection
                .execute(
                    "INSERT INTO paste_queue(
                        hash, position, queued_at, time, content, preview_content, item_type
                     ) VALUES('saved', 0, 123, 456, 'payload', 'preview', 'Text')",
                    [],
                )
                .unwrap();
        }

        let connection = Connection::open(&database_path).unwrap();
        init_schema(&connection).unwrap();
        let saved = connection
            .query_row(
                "SELECT hash, position, queued_at, content FROM paste_queue",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, u64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(saved, ("saved".to_string(), 0, 123, "payload".to_string()));
    }
}
