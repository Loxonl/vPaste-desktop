use std::fs;
use std::path::Path;

pub fn read_file(path: impl AsRef<Path>) -> Result<Vec<u8>, String> {
    fs::read(path.as_ref()).map_err(|err| err.to_string())
}

pub fn file_len(path: impl AsRef<Path>) -> Result<u64, String> {
    fs::metadata(path.as_ref())
        .map(|metadata| metadata.len())
        .map_err(|err| err.to_string())
}

pub fn write_file(path: impl AsRef<Path>, data: &[u8]) -> Result<(), String> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, data).map_err(|err| err.to_string())
}
