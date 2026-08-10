use std::fs;
use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::aead::{Aead, AeadCore, OsRng};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305};

const TEXT_PREFIX: &str = "vpaste-secure:v2:";
const FILE_MAGIC: &[u8] = b"VPASTESEC2";
pub type SecureKey = [u8; 32];

const KEY_BYTES: SecureKey = *b"vPaste-XChaCha20-Poly1305-key-32";

pub fn init_key() {}

fn cipher_with_key(key: &SecureKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(Key::from_slice(key.as_slice()))
}

fn encrypt_bytes_with_key(data: &[u8], key: &SecureKey) -> Result<Vec<u8>, String> {
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let encrypted = cipher_with_key(key)
        .encrypt(&nonce, data)
        .map_err(|err| format!("encrypt failed: {err}"))?;
    let mut output = Vec::with_capacity(nonce.len() + encrypted.len());
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&encrypted);
    Ok(output)
}

fn decrypt_bytes_with_key(data: &[u8], key: &SecureKey) -> Result<Vec<u8>, String> {
    if data.len() < 24 {
        return Err("encrypted payload is truncated".to_string());
    }
    let (nonce, ciphertext) = data.split_at(24);
    cipher_with_key(key)
        .decrypt(nonce.into(), ciphertext)
        .map_err(|err| format!("decrypt failed: {err}"))
}

pub fn export_key_base64() -> String {
    general_purpose::STANDARD.encode(KEY_BYTES.as_slice())
}

pub fn key_from_base64(value: &str) -> Result<SecureKey, String> {
    let decoded = general_purpose::STANDARD
        .decode(value.as_bytes())
        .map_err(|err| err.to_string())?;
    if decoded.len() != 32 {
        return Err("invalid history key length".to_string());
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&decoded);
    Ok(key)
}

pub fn is_encrypted_text(value: &str) -> bool {
    value.starts_with(TEXT_PREFIX)
}

pub fn encrypt_text(value: &str) -> String {
    encrypt_text_with_key(value, &KEY_BYTES)
}

pub fn encrypt_text_with_key(value: &str, key: &SecureKey) -> String {
    if value.is_empty() || is_encrypted_text(value) {
        return value.to_string();
    }
    match encrypt_bytes_with_key(value.as_bytes(), key) {
        Ok(bytes) => format!("{}{}", TEXT_PREFIX, general_purpose::STANDARD.encode(bytes)),
        Err(_) => value.to_string(),
    }
}

pub fn decrypt_text(value: &str) -> String {
    decrypt_text_with_key(value, &KEY_BYTES)
}

pub fn decrypt_text_with_key(value: &str, key: &SecureKey) -> String {
    let Some(payload) = value.strip_prefix(TEXT_PREFIX) else {
        return value.to_string();
    };
    general_purpose::STANDARD
        .decode(payload)
        .ok()
        .and_then(|bytes| decrypt_bytes_with_key(&bytes, key).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| "[内容解密失败 / Decryption Failed]".to_string())
}

pub fn is_encrypted_file_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(FILE_MAGIC)
}

pub fn is_encrypted_file(path: impl AsRef<Path>) -> Result<bool, String> {
    let mut file = fs::File::open(path.as_ref()).map_err(|err| err.to_string())?;
    let mut magic = vec![0_u8; FILE_MAGIC.len()];
    let read = file.read(&mut magic).map_err(|err| err.to_string())?;
    Ok(read == FILE_MAGIC.len() && magic.as_slice() == FILE_MAGIC)
}

pub fn read_file(path: impl AsRef<Path>) -> Result<Vec<u8>, String> {
    read_file_with_key(path, &KEY_BYTES)
}

pub fn file_plaintext_len(path: impl AsRef<Path>) -> Result<u64, String> {
    let path = path.as_ref();
    let metadata = fs::metadata(path).map_err(|err| err.to_string())?;
    if !is_encrypted_file(path)? {
        return Ok(metadata.len());
    }
    const NONCE_BYTES: u64 = 24;
    const AUTH_TAG_BYTES: u64 = 16;
    Ok(metadata
        .len()
        .saturating_sub(FILE_MAGIC.len() as u64 + NONCE_BYTES + AUTH_TAG_BYTES))
}

pub fn read_file_with_key(path: impl AsRef<Path>, key: &SecureKey) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path.as_ref()).map_err(|err| err.to_string())?;
    if let Some(payload) = bytes.strip_prefix(FILE_MAGIC) {
        decrypt_bytes_with_key(payload, key)
    } else {
        Ok(bytes)
    }
}

pub fn encrypt_file_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    let encrypted = encrypt_bytes_with_key(data, &KEY_BYTES)?;
    let mut output = Vec::with_capacity(FILE_MAGIC.len() + encrypted.len());
    output.extend_from_slice(FILE_MAGIC);
    output.extend_from_slice(&encrypted);
    Ok(output)
}

pub fn write_file(path: impl AsRef<Path>, data: &[u8]) -> Result<(), String> {
    write_file_with_key(path, data, &KEY_BYTES)
}

pub fn write_file_with_key(
    path: impl AsRef<Path>,
    data: &[u8],
    key: &SecureKey,
) -> Result<(), String> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let output = if key == &KEY_BYTES {
        encrypt_file_bytes(data)?
    } else {
        let encrypted = encrypt_bytes_with_key(data, key)?;
        let mut output = Vec::with_capacity(FILE_MAGIC.len() + encrypted.len());
        output.extend_from_slice(FILE_MAGIC);
        output.extend_from_slice(&encrypted);
        output
    };
    fs::write(path, output).map_err(|err| err.to_string())
}

pub fn ensure_file_encrypted(path: impl AsRef<Path>) -> Result<bool, String> {
    let path = path.as_ref();
    if !path.is_file() {
        return Ok(false);
    }
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    if is_encrypted_file_bytes(&bytes) {
        return Ok(false);
    }
    write_file(path, &bytes)?;
    Ok(true)
}
