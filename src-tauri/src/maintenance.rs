use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

const EXPORT_UNINSTALL_DATA_ARG: &str = "--export-uninstall-data=";
const REQUEST_INSTALLER_EXIT_ARG: &str = "--request-installer-exit";

pub fn installer_exit_requested_for_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|argument| argument.as_ref() == OsStr::new(REQUEST_INSTALLER_EXIT_ARG))
}

pub fn installer_exit_requested() -> bool {
    installer_exit_requested_for_args(std::env::args_os())
}

pub fn try_handle_maintenance_command() -> Result<bool, String> {
    let Some(output_path) = std::env::args_os().skip(1).find_map(|argument| {
        let value = argument.to_string_lossy();
        value
            .strip_prefix(EXPORT_UNINSTALL_DATA_ARG)
            .map(PathBuf::from)
    }) else {
        return Ok(false);
    };

    export_uninstall_data(&output_path)?;
    Ok(true)
}

fn export_uninstall_data(output_path: &Path) -> Result<(), String> {
    let app_data_dir = installed_app_data_dir()?;
    let config_path = app_data_dir.join("config.json");
    let storage_dir = fs::read_to_string(&config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| {
            value
                .get("storage_dir")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        });
    let custom_history_storage = storage_dir.is_some();
    let history_storage_dir = storage_dir.unwrap_or_else(|| app_data_dir.clone());
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let sanitize = |value: &Path| value.to_string_lossy().replace(['\r', '\n'], "");
    let payload = format!(
        "[Data]\r\nAppDataDir={}\r\nHistoryStorageDir={}\r\nCustomHistoryStorage={}\r\n",
        sanitize(&app_data_dir),
        sanitize(&history_storage_dir),
        if custom_history_storage { "1" } else { "0" },
    );
    fs::write(output_path, payload.as_bytes()).map_err(|err| err.to_string())
}

fn installed_app_data_dir() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    Ok(local_app_data.join("com.loxonl.vpaste"))
}

#[cfg(test)]
mod tests {
    use super::{
        installer_exit_requested_for_args, EXPORT_UNINSTALL_DATA_ARG, REQUEST_INSTALLER_EXIT_ARG,
    };

    #[test]
    fn maintenance_argument_is_explicit_and_namespaced() {
        assert_eq!(EXPORT_UNINSTALL_DATA_ARG, "--export-uninstall-data=");
    }

    #[test]
    fn installer_exit_argument_requires_an_exact_match() {
        assert!(installer_exit_requested_for_args([
            "vPaste.exe",
            REQUEST_INSTALLER_EXIT_ARG,
        ]));
        assert!(!installer_exit_requested_for_args(["vPaste.exe"]));
        assert!(!installer_exit_requested_for_args([
            "vPaste.exe",
            "--request-installer-exit-now",
        ]));
    }
}
