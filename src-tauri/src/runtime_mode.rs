use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const PORTABLE_MARKER: &str = "portable.flag";
const PORTABLE_DATA_DIR: &str = "data";
#[cfg(target_os = "windows")]
const PORTABLE_WEBVIEW_DATA_DIR: &str = "webview2";
#[cfg(target_os = "windows")]
const WEBVIEW2_USER_DATA_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";

static PORTABLE_MODE: AtomicBool = AtomicBool::new(false);

pub fn initialize(default_data_dir: PathBuf) -> Result<PathBuf, String> {
    let Some(portable_data_dir) = portable_data_directory()? else {
        PORTABLE_MODE.store(false, Ordering::SeqCst);
        return Ok(default_data_dir);
    };

    ensure_writable_directory(&portable_data_dir)?;
    PORTABLE_MODE.store(true, Ordering::SeqCst);
    Ok(portable_data_dir)
}

#[cfg(target_os = "windows")]
pub fn configure_webview_data_directory() -> Result<(), String> {
    let Some(portable_data_dir) = portable_data_directory()? else {
        return Ok(());
    };
    let webview_data_dir = portable_data_dir.join(PORTABLE_WEBVIEW_DATA_DIR);
    ensure_writable_directory(&webview_data_dir)?;
    std::env::set_var(WEBVIEW2_USER_DATA_ENV, webview_data_dir);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn configure_webview_data_directory() -> Result<(), String> {
    Ok(())
}

pub fn is_portable() -> bool {
    PORTABLE_MODE.load(Ordering::SeqCst)
}

fn portable_data_directory() -> Result<Option<PathBuf>, String> {
    let executable = std::env::current_exe()
        .map_err(|err| format!("failed to locate the vPaste executable: {err}"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to locate the vPaste executable directory".to_string())?;
    Ok(portable_data_directory_for(executable_dir))
}

fn portable_data_directory_for(executable_dir: &Path) -> Option<PathBuf> {
    executable_dir
        .join(PORTABLE_MARKER)
        .is_file()
        .then(|| executable_dir.join(PORTABLE_DATA_DIR))
}

fn ensure_writable_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| {
        format!(
            "portable data directory cannot be created at {}: {err}",
            path.display()
        )
    })?;

    let probe_path = path.join(format!(".vpaste-write-test-{}", std::process::id()));
    fs::write(&probe_path, b"vpaste").map_err(|err| {
        format!(
            "portable data directory is not writable at {}: {err}",
            path.display()
        )
    })?;
    fs::remove_file(&probe_path).map_err(|err| {
        format!(
            "portable data directory write test could not be cleaned up at {}: {err}",
            path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ensure_writable_directory, portable_data_directory_for};

    #[test]
    fn creates_and_validates_a_writable_portable_data_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let data_dir = workspace.path().join("data");

        ensure_writable_directory(&data_dir).unwrap();

        assert!(data_dir.is_dir());
        assert_eq!(data_dir.read_dir().unwrap().count(), 0);
    }

    #[test]
    fn portable_data_directory_requires_the_marker_file() {
        let workspace = tempfile::tempdir().unwrap();
        assert_eq!(portable_data_directory_for(workspace.path()), None);

        std::fs::write(workspace.path().join("portable.flag"), b"portable").unwrap();

        assert_eq!(
            portable_data_directory_for(workspace.path()),
            Some(workspace.path().join("data"))
        );
    }
}
