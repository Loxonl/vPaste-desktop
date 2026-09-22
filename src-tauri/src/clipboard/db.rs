use infer::MatcherType;
use lazy_static::lazy_static;
use log::{error, warn};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, Result};
use std::path::Path;
use std::sync::RwLock;
use std::time::Duration;

use crate::history_storage_dir;
use crate::history_store;
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

pub fn db() -> PooledConnection<SqliteConnectionManager> {
    let db_path = current_db_path();
    {
        let pool = POOL.read().unwrap();
        if let Some((cached_path, pool)) = pool.as_ref() {
            if cached_path == &db_path {
                return pool.get().unwrap();
            }
        }
    }

    let mut pool = POOL.write().unwrap();
    if let Some((cached_path, cached_pool)) = pool.as_ref() {
        if cached_path == &db_path {
            return cached_pool.get().unwrap();
        }
    }
    let next_pool = setup_pool(&db_path).unwrap();
    let conn = next_pool.get().unwrap();
    *pool = Some((db_path, next_pool));
    conn
}

pub fn init() {
    let conn = db();
    if let Err(err) = init_schema(&conn) {
        error!("failed to initialize clipboard database schema: {}", err);
    }
}

pub fn init_schema(conn: &Connection) -> Result<()> {
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

    ";
    conn.execute_batch(sql)?;
    let has_app_source = conn
        .prepare("pragma table_info(clipboard)")
        .and_then(|mut statement| {
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>>>()?;
            Ok(columns.iter().any(|column| column == "app_source"))
        })
        .unwrap_or(false);
    if !has_app_source {
        conn.execute(
            "alter table clipboard add column app_source text default '' not null",
            [],
        )?;
    }
    let has_app_icon_path = conn
        .prepare("pragma table_info(clipboard)")
        .and_then(|mut statement| {
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>>>()?;
            Ok(columns.iter().any(|column| column == "app_icon_path"))
        })
        .unwrap_or(false);
    if !has_app_icon_path {
        conn.execute(
            "alter table clipboard add column app_icon_path text default '' not null",
            [],
        )?;
    }
    if table_columns(conn, "clipboard")?
        .iter()
        .any(|column| column == "history_visible")
    {
        conn.execute("alter table clipboard drop column history_visible", [])?;
    }
    migrate_legacy_paste_queue_schema(conn)?;
    rebuild_hash_unique_index(conn)?;
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare(&format!("pragma table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>>>()?;
    Ok(columns)
}

fn migrate_legacy_paste_queue_schema(conn: &Connection) -> Result<()> {
    let columns = table_columns(conn, "paste_queue")?;
    let required_columns = [
        "hash",
        "position",
        "queued_at",
        "time",
        "content",
        "preview_content",
        "item_type",
        "search_index",
        "source",
        "app_source",
        "app_icon_path",
        "title_color",
        "label",
    ];
    let foreign_key_count = conn.query_row(
        "SELECT count(*) FROM pragma_foreign_key_list('paste_queue')",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let has_full_payload = required_columns
        .iter()
        .all(|required| columns.iter().any(|column| column == required));
    if foreign_key_count == 0 && has_full_payload {
        return Ok(());
    }

    let foreign_keys_enabled = conn.query_row("PRAGMA foreign_keys", [], |row| {
        Ok(row.get::<_, i64>(0)? != 0)
    })?;
    if foreign_keys_enabled {
        conn.pragma_update(None, "foreign_keys", "OFF")?;
    }

    let payload_select = if has_full_payload {
        "SELECT q.hash,
                row_number() OVER (ORDER BY q.position ASC) - 1,
                q.queued_at, q.time, q.content, q.preview_content, q.item_type,
                q.search_index, q.source, q.app_source, q.app_icon_path,
                q.title_color, q.label
         FROM paste_queue q
         ORDER BY q.position ASC"
    } else {
        "SELECT q.hash,
                row_number() OVER (ORDER BY q.position ASC) - 1,
                q.queued_at, c.time, coalesce(c.content, ''),
                coalesce(c.preview_content, ''), coalesce(c.item_type, 'Text'),
                coalesce(c.search_index, 1), coalesce(c.source, ''),
                coalesce(c.app_source, ''), coalesce(c.app_icon_path, ''),
                coalesce(c.title_color, ''), coalesce(c.label, 0)
         FROM paste_queue q
         JOIN clipboard c ON c.hash = q.hash
         ORDER BY q.position ASC"
    };
    let migration_sql = format!(
        "BEGIN IMMEDIATE;
         DROP TABLE IF EXISTS paste_queue_v3;
         CREATE TABLE paste_queue_v3(
             hash TEXT NOT NULL PRIMARY KEY,
             position INTEGER NOT NULL,
             queued_at INTEGER NOT NULL,
             time INTEGER NOT NULL,
             content TEXT DEFAULT '' NOT NULL,
             preview_content TEXT DEFAULT '' NOT NULL,
             item_type TEXT NOT NULL,
             search_index INTEGER DEFAULT 1 NOT NULL,
             source TEXT DEFAULT '' NOT NULL,
             app_source TEXT DEFAULT '' NOT NULL,
             app_icon_path TEXT DEFAULT '' NOT NULL,
             title_color TEXT DEFAULT '' NOT NULL,
             label INTEGER DEFAULT 0 NOT NULL
         ) STRICT;
         INSERT INTO paste_queue_v3(
             hash, position, queued_at, time, content, preview_content, item_type,
             search_index, source, app_source, app_icon_path, title_color, label
         ) {payload_select};
         DROP TABLE paste_queue;
         ALTER TABLE paste_queue_v3 RENAME TO paste_queue;
         CREATE UNIQUE INDEX paste_queue_position ON paste_queue(position);
         COMMIT;"
    );
    let migration = conn.execute_batch(&migration_sql);
    if migration.is_err() {
        let _ = conn.execute_batch("ROLLBACK;");
    }
    let restore_foreign_keys = if foreign_keys_enabled {
        conn.pragma_update(None, "foreign_keys", "ON")
    } else {
        Ok(())
    };
    migration?;
    restore_foreign_keys
}

fn rebuild_hash_unique_index(conn: &Connection) -> Result<()> {
    conn.execute("drop index if exists hash", [])?;
    remove_duplicate_hashes(conn)?;
    conn.execute("create unique index hash on clipboard (hash)", [])?;
    Ok(())
}

fn remove_duplicate_hashes(conn: &Connection) -> Result<usize> {
    conn.execute(
        "delete from clipboard
         where id not in (
             select id from (
                 select id, hash from clipboard order by cast(time as integer) desc, id desc
             )
             group by hash
         )",
        [],
    )
}

pub fn clear_all() -> Result<usize> {
    let mut conn = db();
    let transaction = conn.transaction()?;
    transaction.execute("DELETE FROM clipboard_tags", [])?;
    let affected = transaction.execute("DELETE FROM clipboard", [])?;
    transaction.commit()?;
    Ok(affected)
}

pub fn clear_legacy_payload() -> Result<()> {
    let mut conn = db();
    clear_legacy_payload_with_conn(&mut conn)
}

fn clear_legacy_payload_with_conn(conn: &mut Connection) -> Result<()> {
    let transaction = conn.transaction()?;
    transaction.execute("DELETE FROM clipboard_tags", [])?;
    transaction.execute("DELETE FROM clipboard", [])?;
    let has_paste_queue = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paste_queue'
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if has_paste_queue {
        transaction.execute("DELETE FROM paste_queue", [])?;
    }
    transaction.commit()
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
    use super::{clear_legacy_payload_with_conn, init_schema, setup_pool};
    use rusqlite::Connection;
    use std::time::Duration;

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

    #[test]
    fn legacy_clear_preserves_tag_definitions() {
        let mut connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection
            .execute(
                "insert into tags(name, created_at, updated_at) values('kept', 1, 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into clipboard(hash, time, content) values('old', 1, 'cipher')",
                [],
            )
            .unwrap();
        connection.execute("insert into paste_queue(hash, position, queued_at, time, content, item_type) values('old', 0, 1, 1, 'cipher', 'Text')", []).unwrap();

        clear_legacy_payload_with_conn(&mut connection).unwrap();

        let tags: i64 = connection
            .query_row("select count(*) from tags where name='kept'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let clipboard: i64 = connection
            .query_row("select count(*) from clipboard", [], |row| row.get(0))
            .unwrap();
        let queue: i64 = connection
            .query_row("select count(*) from paste_queue", [], |row| row.get(0))
            .unwrap();
        assert_eq!((tags, clipboard, queue), (1, 0, 0));
    }

    #[test]
    fn legacy_clear_accepts_databases_created_before_paste_queue_existed() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "create table clipboard(id integer primary key, content text);
                 create table clipboard_tags(clipboard_id integer, tag_id integer);
                 insert into clipboard(content) values('vpaste-secure:v2:cipher');
                 insert into clipboard_tags values(1, 1);",
            )
            .unwrap();

        clear_legacy_payload_with_conn(&mut connection)
            .expect("legacy databases without paste_queue must still be clearable");

        let clipboard: i64 = connection
            .query_row("select count(*) from clipboard", [], |row| row.get(0))
            .unwrap();
        let clipboard_tags: i64 = connection
            .query_row("select count(*) from clipboard_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!((clipboard, clipboard_tags), (0, 0));
    }

    #[test]
    fn legacy_queue_migration_drops_orphans_and_normalizes_positions() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO clipboard(
                    hash, time, content, preview_content, item_type, search_index
                 ) VALUES('kept', 1, 'payload', 'preview', 'Text', 1)",
                [],
            )
            .unwrap();
        connection
            .execute_batch(
                "DROP TABLE paste_queue;
                 CREATE TABLE paste_queue(
                     hash TEXT NOT NULL PRIMARY KEY,
                     position INTEGER NOT NULL,
                     queued_at INTEGER NOT NULL
                 ) STRICT;
                 CREATE UNIQUE INDEX paste_queue_position ON paste_queue(position);
                 INSERT INTO paste_queue(hash, position, queued_at)
                    VALUES('missing', 0, 100), ('kept', 1, 200);",
            )
            .unwrap();

        init_schema(&connection).unwrap();

        let mut statement = connection
            .prepare("SELECT hash, position FROM paste_queue ORDER BY position")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows, vec![("kept".to_string(), 0)]);
    }

    #[test]
    fn legacy_paste_queue_foreign_key_is_removed_without_losing_queue() {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO clipboard(
                    hash, time, content, preview_content, item_type, search_index
                 ) VALUES('saved', 1, 'payload', 'preview', 'Text', 1)",
                [],
            )
            .unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE paste_queue;
                 DROP INDEX hash;
                 CREATE TABLE paste_queue(
                     hash TEXT NOT NULL PRIMARY KEY,
                     position INTEGER NOT NULL,
                     queued_at INTEGER NOT NULL,
                     FOREIGN KEY(hash) REFERENCES clipboard(hash) ON DELETE CASCADE
                 ) STRICT;
                 CREATE UNIQUE INDEX paste_queue_position ON paste_queue(position);
                 INSERT INTO paste_queue(hash, position, queued_at) VALUES('saved', 0, 123);
                 PRAGMA foreign_keys = ON;",
            )
            .unwrap();

        init_schema(&connection).unwrap();

        let foreign_key_count = connection
            .query_row(
                "SELECT count(*) FROM pragma_foreign_key_list('paste_queue')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let foreign_keys_enabled = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap();
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
        assert_eq!(foreign_key_count, 0);
        assert_eq!(foreign_keys_enabled, 1);
        assert_eq!(saved, ("saved".to_string(), 0, 123, "payload".to_string()));
    }

    #[test]
    fn rejected_history_visibility_column_is_removed_without_losing_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE clipboard(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hash TEXT NOT NULL,
                    time INTEGER NOT NULL,
                    content TEXT,
                    preview_content TEXT,
                    item_type TEXT,
                    search_index INTEGER,
                    source TEXT,
                    app_source TEXT DEFAULT '' NOT NULL,
                    app_icon_path TEXT DEFAULT '' NOT NULL,
                    title_color TEXT,
                    icon TEXT,
                    label INTEGER DEFAULT 0 NOT NULL,
                    history_visible INTEGER DEFAULT 1 NOT NULL
                ) STRICT;
                INSERT INTO clipboard(hash, time) VALUES('existing', 1);",
            )
            .unwrap();

        init_schema(&connection).unwrap();

        let columns = super::table_columns(&connection, "clipboard").unwrap();
        let rows = connection
            .query_row("SELECT count(*) FROM clipboard", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert!(!columns.iter().any(|column| column == "history_visible"));
        assert_eq!(rows, 1);
    }
}
