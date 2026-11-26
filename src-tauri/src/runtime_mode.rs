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

pub(crate) fn portable_data_directory() -> Result<Option<PathBuf>, String> {
    let executable = std::env::current_exe()
        .map_err(|err| format!("failed to locate the vPaste executable: {err}"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to locate the vPaste executable directory".to_string())?;

    #[cfg(all(target_os = "windows", feature = "winui-rc"))]
    {
        internal_rc_data_directory(executable_dir, crate::APP_VERSION).map(Some)
    }
    #[cfg(not(all(target_os = "windows", feature = "winui-rc")))]
    {
        Ok(portable_data_directory_for(executable_dir))
    }
}

#[cfg(all(target_os = "windows", feature = "winui-rc"))]
fn internal_rc_data_directory(executable_dir: &Path, version: &str) -> Result<PathBuf, String> {
    use std::os::windows::fs::MetadataExt;

    const REPARSE_POINT: u32 = 0x400;
    let marker = executable_dir.join("internal-rc.flag");
    let marker_error = "Extract the entire internal RC ZIP to a dedicated writable folder. A matching internal-rc.flag is required.";
    let meta = fs::symlink_metadata(&marker).map_err(|_| marker_error.to_string())?;
    if !meta.is_file()
        || meta.file_attributes() & REPARSE_POINT != 0
        || !fs::read_to_string(&marker).is_ok_and(|content| content.trim() == version)
    {
        return Err(marker_error.into());
    }

    let profile = executable_dir.join("internal-rc-data");
    for path in [
        executable_dir,
        &profile,
        &profile.join(PORTABLE_WEBVIEW_DATA_DIR),
    ] {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() && meta.file_attributes() & REPARSE_POINT == 0 => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                return Err(format!(
                    "The internal RC requires a regular directory at {}.",
                    path.display()
                ))
            }
        }
    }
    Ok(profile)
}

#[cfg(any(test, not(all(target_os = "windows", feature = "winui-rc"))))]
pub(crate) fn portable_data_directory_for(executable_dir: &Path) -> Option<PathBuf> {
    executable_dir
        .join(PORTABLE_MARKER)
        .is_file()
        .then(|| executable_dir.join(PORTABLE_DATA_DIR))
}

pub(crate) fn ensure_writable_directory(path: &Path) -> Result<(), String> {
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
