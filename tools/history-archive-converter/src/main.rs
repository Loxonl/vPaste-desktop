use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305};
use rusqlite::{params, Connection};
use serde_json::Value;

const MAGIC: &[u8] = b"VPASTE-HISTORY";
const V2: u32 = 2;
const V3: u32 = 3;
const TEXT_PREFIX: &str = "vpaste-secure:v2:";
const FILE_MAGIC: &[u8] = b"VPASTESEC2";
const MAX_METADATA: u64 = 1024 * 1024;
const MAX_PATH: u32 = 4096;

fn read_u32(reader: &mut File) -> Result<u32, String> {
    let mut bytes = [0; 4];
    reader
        .read_exact(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut File) -> Result<u64, String> {
    let mut bytes = [0; 8];
    reader
        .read_exact(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok(u64::from_le_bytes(bytes))
}

fn write_u32(writer: &mut File, value: u32) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|err| err.to_string())
}

fn write_u64(writer: &mut File, value: u64) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|err| err.to_string())
}

fn safe_entry(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('\\') {
        return Err(format!("unsafe archive path: {name}"));
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("unsafe archive path: {name}"));
    }
    if name != "vpaste.db"
        && name != "custom_tabs.json"
        && !name.starts_with("data/")
        && !name.starts_with("rich_formats/")
    {
        return Err(format!("unsupported archive entry: {name}"));
    }
    Ok(())
}

fn read_header(reader: &mut File, expected_version: u32) -> Result<(Value, u64), String> {
    let mut magic = vec![0; MAGIC.len()];
    reader
        .read_exact(&mut magic)
        .map_err(|_| "not a vPaste history archive".to_string())?;
    if magic != MAGIC {
        return Err("not a vPaste history archive".to_string());
    }
    let version = read_u32(reader)?;
    if version != expected_version {
        return Err(format!(
            "expected archive version {expected_version}, found {version}"
        ));
    }
    let metadata_len = read_u64(reader)?;
    if metadata_len == 0 || metadata_len > MAX_METADATA {
        return Err("invalid archive metadata length".to_string());
    }
    let mut bytes = vec![0; metadata_len as usize];
    reader
        .read_exact(&mut bytes)
        .map_err(|err| err.to_string())?;
    let metadata: Value = serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
    if metadata.get("format").and_then(Value::as_str) != Some("vpaste-history") {
        return Err("invalid archive metadata format".to_string());
    }
    Ok((metadata, read_u64(reader)?))
}

fn read_entry_header(reader: &mut File) -> Result<(String, u64), String> {
    let len = read_u32(reader)?;
    if len == 0 || len > MAX_PATH {
        return Err("invalid archive path length".to_string());
    }
    let mut bytes = vec![0; len as usize];
    reader
        .read_exact(&mut bytes)
        .map_err(|err| err.to_string())?;
    let name = String::from_utf8(bytes).map_err(|err| err.to_string())?;
    Ok((name, read_u64(reader)?))
}

fn extract_v2(input: &Path, root: &Path) -> Result<(Value, [u8; 32]), String> {
    println!("[1/4] Scanning v2 archive");
    let mut reader = File::open(input).map_err(|err| err.to_string())?;
    let (metadata, entries) = read_header(&mut reader, V2)?;
    let algorithm = metadata
        .pointer("/encryption/algorithm")
        .and_then(Value::as_str);
    if algorithm != Some("xchacha20-poly1305") {
        return Err("unsupported or missing encryption algorithm".to_string());
    }
    let encoded_key = metadata
        .pointer("/encryption/key")
        .and_then(Value::as_str)
        .ok_or_else(|| "archive encryption key is missing".to_string())?;
    let decoded = general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|err| err.to_string())?;
    if decoded.len() != 32 {
        return Err("archive encryption key must be 32 bytes".to_string());
    }
    let mut key = [0; 32];
    key.copy_from_slice(&decoded);

    let mut names = HashSet::new();
    let mut has_db = false;
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    for _ in 0..entries {
        let (name, size) = read_entry_header(&mut reader)?;
        safe_entry(&name)?;
        if !names.insert(name.clone()) {
            return Err(format!("duplicate archive path: {name}"));
        }
        has_db |= name == "vpaste.db";
        let output = root.join(&name);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut file = File::create(output).map_err(|err| err.to_string())?;
        let copied = io::copy(&mut Read::by_ref(&mut reader).take(size), &mut file)
            .map_err(|err| err.to_string())?;
        if copied != size {
            return Err(format!("truncated archive entry: {name}"));
        }
    }
    if !has_db {
        return Err("archive does not contain vpaste.db".to_string());
    }
    if reader.stream_position().map_err(|err| err.to_string())?
        != reader.metadata().map_err(|err| err.to_string())?.len()
    {
        return Err("archive contains trailing data".to_string());
    }
    Ok((metadata, key))
}

fn decrypt_bytes(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if data.len() < 24 {
        return Err("encrypted payload is truncated".to_string());
    }
    let (nonce, ciphertext) = data.split_at(24);
    XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(nonce.into(), ciphertext)
        .map_err(|_| "encrypted payload authentication failed".to_string())
}

fn decrypt_text(value: String, key: &[u8; 32]) -> Result<String, String> {
    let Some(payload) = value.strip_prefix(TEXT_PREFIX) else {
        return Ok(value);
    };
    let encrypted = general_purpose::STANDARD
        .decode(payload)
        .map_err(|err| err.to_string())?;
    String::from_utf8(decrypt_bytes(&encrypted, key)?).map_err(|err| err.to_string())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "select count(*) from sqlite_master where type='table' and name=?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(|err| err.to_string())
}

fn decrypt_table(conn: &mut Connection, table: &str, key: &[u8; 32]) -> Result<u64, String> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }
    let rows = {
        let mut statement = conn
            .prepare(&format!(
                "select rowid, content, preview_content, source from {table}"
            ))
            .map_err(|err| err.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    let count = rows.len() as u64;
    let transaction = conn.transaction().map_err(|err| err.to_string())?;
    for (rowid, content, preview, source) in rows {
        transaction
            .execute(
                &format!(
                    "update {table} set content=?1, preview_content=?2, source=?3 where rowid=?4"
                ),
                params![
                    decrypt_text(content, key)?,
                    decrypt_text(preview, key)?,
                    decrypt_text(source, key)?,
                    rowid
                ],
            )
            .map_err(|err| err.to_string())?;
    }
    transaction.commit().map_err(|err| err.to_string())?;
    Ok(count)
}

fn visit_files(
    path: &Path,
    callback: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
            visit_files(&entry.map_err(|err| err.to_string())?.path(), callback)?;
        }
    } else {
        callback(path)?;
    }
    Ok(())
}

fn decrypt_payload(root: &Path, key: &[u8; 32]) -> Result<(u64, u64), String> {
    println!("[2/4] Decrypting database and files");
    let mut conn = Connection::open(root.join("vpaste.db")).map_err(|err| err.to_string())?;
    let rows =
        decrypt_table(&mut conn, "clipboard", key)? + decrypt_table(&mut conn, "paste_queue", key)?;
    drop(conn);
    let mut files = 0;
    for name in ["custom_tabs.json", "data", "rich_formats"] {
        visit_files(&root.join(name), &mut |path| {
            let bytes = fs::read(path).map_err(|err| err.to_string())?;
            if let Some(payload) = bytes.strip_prefix(FILE_MAGIC) {
                fs::write(path, decrypt_bytes(payload, key)?).map_err(|err| err.to_string())?;
            }
            files += 1;
            Ok(())
        })?;
    }
    Ok((rows, files))
}

fn collect_entries(
    root: &Path,
    path: &Path,
    entries: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
            collect_entries(root, &entry.map_err(|err| err.to_string())?.path(), entries)?;
        }
    } else {
        let name = path
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        safe_entry(&name)?;
        entries.push((name, path.to_path_buf()));
    }
    Ok(())
}

fn write_v3(root: &Path, output: &Path, mut metadata: Value) -> Result<(), String> {
    println!("[3/4] Writing plaintext v3 archive");
    let object = metadata
        .as_object_mut()
        .ok_or_else(|| "metadata is not an object".to_string())?;
    object.insert("version".to_string(), Value::from(V3));
    object.remove("encryption");
    let metadata_bytes = serde_json::to_vec(&metadata).map_err(|err| err.to_string())?;
    let mut entries = Vec::new();
    for name in ["vpaste.db", "custom_tabs.json", "data", "rich_formats"] {
        collect_entries(root, &root.join(name), &mut entries)?;
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut writer = File::create(output).map_err(|err| err.to_string())?;
    writer.write_all(MAGIC).map_err(|err| err.to_string())?;
    write_u32(&mut writer, V3)?;
    write_u64(&mut writer, metadata_bytes.len() as u64)?;
    writer
        .write_all(&metadata_bytes)
        .map_err(|err| err.to_string())?;
    write_u64(&mut writer, entries.len() as u64)?;
    for (name, path) in entries {
        let size = fs::metadata(&path).map_err(|err| err.to_string())?.len();
        write_u32(&mut writer, name.len() as u32)?;
        writer
            .write_all(name.as_bytes())
            .map_err(|err| err.to_string())?;
        write_u64(&mut writer, size)?;
        io::copy(
            &mut File::open(path).map_err(|err| err.to_string())?,
            &mut writer,
        )
        .map_err(|err| err.to_string())?;
    }
    writer.flush().map_err(|err| err.to_string())
}

fn validate_v3(output: &Path, expected_rows: u64) -> Result<(), String> {
    println!("[4/4] Validating v3 archive");
    let temp = tempfile::tempdir().map_err(|err| err.to_string())?;
    let mut reader = File::open(output).map_err(|err| err.to_string())?;
    let (metadata, entries) = read_header(&mut reader, V3)?;
    if metadata.get("encryption").is_some() {
        return Err("v3 metadata still contains encryption".to_string());
    }
    let mut names = HashSet::new();
    for _ in 0..entries {
        let (name, size) = read_entry_header(&mut reader)?;
        safe_entry(&name)?;
        if !names.insert(name.clone()) {
            return Err(format!("duplicate v3 path: {name}"));
        }
        let path = temp.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let copied = io::copy(
            &mut Read::by_ref(&mut reader).take(size),
            &mut File::create(path).map_err(|err| err.to_string())?,
        )
        .map_err(|err| err.to_string())?;
        if copied != size {
            return Err("truncated v3 archive".to_string());
        }
    }
    if reader.stream_position().map_err(|err| err.to_string())?
        != reader.metadata().map_err(|err| err.to_string())?.len()
    {
        return Err("v3 archive has trailing data".to_string());
    }
    let conn = Connection::open(temp.path().join("vpaste.db")).map_err(|err| err.to_string())?;
    let mut rows = 0_u64;
    for table in ["clipboard", "paste_queue"] {
        if table_exists(&conn, table)? {
            let count: i64 = conn
                .query_row(&format!("select count(*) from {table}"), [], |row| {
                    row.get(0)
                })
                .map_err(|err| err.to_string())?;
            let legacy: i64 = conn.query_row(&format!("select count(*) from {table} where content like ?1 or preview_content like ?1 or source like ?1"), [format!("{TEXT_PREFIX}%")], |row| row.get(0)).map_err(|err| err.to_string())?;
            if legacy != 0 {
                return Err(format!("legacy text remains in {table}"));
            }
            rows += count as u64;
        }
    }
    if rows != expected_rows {
        return Err(format!(
            "row count changed: expected {expected_rows}, found {rows}"
        ));
    }
    drop(conn);
    for name in ["custom_tabs.json", "data", "rich_formats"] {
        visit_files(&temp.path().join(name), &mut |path| {
            if fs::read(path)
                .map_err(|err| err.to_string())?
                .starts_with(FILE_MAGIC)
            {
                return Err(format!("legacy file remains: {}", path.display()));
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn default_output(input: &Path) -> Result<PathBuf, String> {
    let stem = input
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or_else(|| "input filename is invalid".to_string())?;
    Ok(input.with_file_name(format!("{stem}.v3.vphistory")))
}

fn convert(input: &Path, output: &Path) -> Result<(), String> {
    let input = input.canonicalize().map_err(|err| err.to_string())?;
    if output.exists() {
        return Err(format!("output already exists: {}", output.display()));
    }
    let output_parent = output.parent().unwrap_or_else(|| Path::new("."));
    let output_parent = output_parent
        .canonicalize()
        .map_err(|err| err.to_string())?;
    let output = output_parent.join(
        output
            .file_name()
            .ok_or_else(|| "output filename is missing".to_string())?,
    );
    if input == output {
        return Err("input and output paths must differ".to_string());
    }
    let workspace = tempfile::tempdir().map_err(|err| err.to_string())?;
    let (metadata, key) = extract_v2(&input, workspace.path())?;
    let (rows, _) = decrypt_payload(workspace.path(), &key)?;
    let pending = tempfile::Builder::new()
        .prefix(".vpaste-v3-")
        .tempfile_in(&output_parent)
        .map_err(|err| err.to_string())?;
    let pending_path = pending.path().to_path_buf();
    drop(pending);
    let result = write_v3(workspace.path(), &pending_path, metadata)
        .and_then(|_| validate_v3(&pending_path, rows))
        .and_then(|_| fs::rename(&pending_path, &output).map_err(|err| err.to_string()));
    if let Err(err) = result {
        let _ = fs::remove_file(&pending_path);
        return Err(err);
    }
    println!("Converted archive: {}", output.display());
    Ok(())
}

fn arguments() -> Result<(PathBuf, PathBuf), String> {
    let mut args = env::args_os().skip(1);
    let input = args.next().map(PathBuf::from).ok_or_else(|| {
        "usage: vpaste-history-converter <input.vphistory> [--output <path>]".to_string()
    })?;
    let output = match args.next() {
        None => default_output(&input)?,
        Some(flag) if flag == "--output" => args
            .next()
            .map(PathBuf::from)
            .ok_or_else(|| "--output requires a path".to_string())?,
        Some(_) => {
            return Err(
                "usage: vpaste-history-converter <input.vphistory> [--output <path>]".to_string(),
            )
        }
    };
    if args.next().is_some() {
        return Err("too many arguments".to_string());
    }
    Ok((input, output))
}

fn main() {
    if let Err(err) = arguments().and_then(|(input, output)| convert(&input, &output)) {
        eprintln!("Conversion failed: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chacha20poly1305::aead::{AeadCore, OsRng};

    fn encrypt(data: &[u8], key: &[u8; 32]) -> Vec<u8> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let mut bytes = nonce.to_vec();
        bytes.extend_from_slice(&cipher.encrypt(&nonce, data).unwrap());
        bytes
    }

    fn encrypted_text(value: &str, key: &[u8; 32]) -> String {
        format!(
            "{TEXT_PREFIX}{}",
            general_purpose::STANDARD.encode(encrypt(value.as_bytes(), key))
        )
    }

    fn write_v2_fixture(path: &Path, key: &[u8; 32], corrupt_file: bool) {
        let workspace = tempfile::tempdir().unwrap();
        let db = workspace.path().join("vpaste.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("create table clipboard(id integer primary key, hash text, time integer, content text, preview_content text, source text); create table paste_queue(hash text primary key, content text, preview_content text, source text); create table tags(id integer primary key, name text);").unwrap();
        conn.execute(
            "insert into clipboard values(1,'hash',10,?1,'plain',?2)",
            params![encrypted_text("body", key), encrypted_text("source", key)],
        )
        .unwrap();
        conn.execute(
            "insert into paste_queue values('hash',?1,'',?2)",
            params![
                encrypted_text("queued", key),
                encrypted_text("queue-source", key)
            ],
        )
        .unwrap();
        conn.execute("insert into tags values(9,'kept')", [])
            .unwrap();
        drop(conn);
        let attachment_payload = if corrupt_file {
            b"broken".to_vec()
        } else {
            encrypt(b"file bytes", key)
        };
        let mut attachment = FILE_MAGIC.to_vec();
        attachment.extend_from_slice(&attachment_payload);
        fs::write(workspace.path().join("item.bin"), attachment).unwrap();
        let metadata = serde_json::json!({"format":"vpaste-history","version":2,"source_dir":"/old","encryption":{"algorithm":"xchacha20-poly1305","key":general_purpose::STANDARD.encode(key)}});
        let metadata = serde_json::to_vec(&metadata).unwrap();
        let entries = [
            ("vpaste.db", db),
            ("data/item.bin", workspace.path().join("item.bin")),
        ];
        let mut writer = File::create(path).unwrap();
        writer.write_all(MAGIC).unwrap();
        write_u32(&mut writer, V2).unwrap();
        write_u64(&mut writer, metadata.len() as u64).unwrap();
        writer.write_all(&metadata).unwrap();
        write_u64(&mut writer, entries.len() as u64).unwrap();
        for (name, source) in entries {
            let bytes = fs::read(source).unwrap();
            write_u32(&mut writer, name.len() as u32).unwrap();
            writer.write_all(name.as_bytes()).unwrap();
            write_u64(&mut writer, bytes.len() as u64).unwrap();
            writer.write_all(&bytes).unwrap();
        }
    }

    #[test]
    fn converts_database_queue_and_attachment_without_touching_input() {
        let workspace = tempfile::tempdir().unwrap();
        let input = workspace.path().join("old.vphistory");
        let output = workspace.path().join("new.vphistory");
        let key = [7_u8; 32];
        write_v2_fixture(&input, &key, false);
        let original = fs::read(&input).unwrap();
        convert(&input, &output).unwrap();
        assert_eq!(fs::read(input).unwrap(), original);
        let extracted = tempfile::tempdir().unwrap();
        let mut reader = File::open(&output).unwrap();
        let (metadata, entries) = read_header(&mut reader, V3).unwrap();
        assert!(metadata.get("encryption").is_none());
        for _ in 0..entries {
            let (name, size) = read_entry_header(&mut reader).unwrap();
            let path = extracted.path().join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            let mut bytes = vec![0; size as usize];
            reader.read_exact(&mut bytes).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let conn = Connection::open(extracted.path().join("vpaste.db")).unwrap();
        let clipboard: (String, String, String, i64) = conn
            .query_row(
                "select content, preview_content, source, time from clipboard where hash='hash'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let queue: (String, String) = conn
            .query_row(
                "select content, source from paste_queue where hash='hash'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let tag: String = conn
            .query_row("select name from tags where id=9", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            clipboard,
            ("body".into(), "plain".into(), "source".into(), 10)
        );
        assert_eq!(queue, ("queued".into(), "queue-source".into()));
        assert_eq!(tag, "kept");
        assert_eq!(
            fs::read(extracted.path().join("data/item.bin")).unwrap(),
            b"file bytes"
        );
    }

    #[test]
    fn authentication_failure_leaves_no_output() {
        let workspace = tempfile::tempdir().unwrap();
        let input = workspace.path().join("old.vphistory");
        let output = workspace.path().join("new.vphistory");
        write_v2_fixture(&input, &[9_u8; 32], true);
        assert!(convert(&input, &output).is_err());
        assert!(!output.exists());
    }

    #[test]
    fn refuses_to_overwrite_existing_output() {
        let workspace = tempfile::tempdir().unwrap();
        let input = workspace.path().join("old.vphistory");
        let output = workspace.path().join("new.vphistory");
        write_v2_fixture(&input, &[3_u8; 32], false);
        fs::write(&output, b"keep").unwrap();
        assert!(convert(&input, &output).is_err());
        assert_eq!(fs::read(output).unwrap(), b"keep");
    }
}
