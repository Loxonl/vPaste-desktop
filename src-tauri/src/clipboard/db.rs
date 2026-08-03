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
use crate::search::engine;
use crate::secure_store;

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
    rebuild_hash_unique_index(conn)?;
    Ok(())
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
    let conn = db();
    conn.execute("DELETE FROM clipboard_tags", [])?;
    conn.execute("DELETE FROM clipboard", [])
}

pub fn clear_images() -> Result<usize> {
    let conn = db();
    let mut statement = conn.prepare("SELECT id, hash, item_type, content FROM clipboard")?;
    let image_items = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, _, item_type, content)| {
            let content = secure_store::decrypt_text(content);
            item_type == "Image" || (item_type == "File" && is_single_image_file(&content))
        })
        .collect::<Vec<_>>();

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

    conn.execute(
        format!(
            "DELETE FROM clipboard_tags WHERE clipboard_id IN ({})",
            ids.join(",")
        )
        .as_str(),
        [],
    )?;

    conn.execute(
        format!("DELETE FROM clipboard WHERE id IN ({})", ids.join(",")).as_str(),
        [],
    )
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
    use super::setup_pool;
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
}
