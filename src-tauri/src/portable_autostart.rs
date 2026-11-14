use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupSyncAction {
    Register(String),
    UpdateCommand(String),
    Unregister,
    Unchanged,
}

fn startup_command(executable: &Path, arguments: &[&str]) -> String {
    let mut command = format!(r#""{}""#, executable.display());
    if !arguments.is_empty() {
        command.push(' ');
        command.push_str(&arguments.join(" "));
    }
    command
}

fn registered_command_matches(registered_command: Option<&str>, executable: &Path) -> bool {
    // Ownership follows the executable; reconciliation separately compares args.
    let quoted_path = startup_command(executable, &[]);
    registered_command
        .and_then(|command| command.trim_end().strip_prefix(&quoted_path))
        .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(char::is_whitespace))
}

#[cfg(any(target_os = "windows", test))]
fn startup_enabled_in_config(data_dir: &Path) -> Result<bool, String> {
    let contents = match std::fs::read(data_dir.join("config.json")) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("failed to read portable startup setting: {err}")),
    };
    let config: crate::config::Config = serde_json::from_slice(&contents)
        .map_err(|err| format!("failed to parse portable startup setting: {err}"))?;
    Ok(config.startup)
}

pub(crate) fn startup_sync_action(
    startup: bool,
    registered_command: Option<&str>,
    executable: &Path,
    arguments: &[&str],
) -> StartupSyncAction {
    if !startup {
        return if registered_command_matches(registered_command, executable) {
            StartupSyncAction::Unregister
        } else {
            StartupSyncAction::Unchanged
        };
    }

    let command = startup_command(executable, arguments);
    // auto-launch appends a space after the path even when there are no arguments.
    if registered_command.map(str::trim_end) == Some(command.as_str()) {
        StartupSyncAction::Unchanged
    } else if registered_command_matches(registered_command, executable) {
        StartupSyncAction::UpdateCommand(command)
    } else {
        StartupSyncAction::Register(command)
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{
        registered_command_matches, startup_command, startup_sync_action, StartupSyncAction,
    };
    use auto_launch::AutoLaunch;
    use std::io::ErrorKind;
    use std::path::Path;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const ENTRY_NAME: &str = "vPaste Portable";
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn launcher(executable: &Path, arguments: &[&str]) -> AutoLaunch {
        let quoted_path = startup_command(executable, &[]);
        AutoLaunch::new(ENTRY_NAME, &quoted_path, arguments)
    }

    fn registered_command() -> Result<Option<String>, String> {
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ)
        {
            Ok(key) => key,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("failed to read portable startup key: {err}")),
        };
        match key.get_value::<String, _>(ENTRY_NAME) {
            Ok(command) => Ok(Some(command)),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("failed to read portable startup entry: {err}")),
        }
    }

    pub(super) fn is_enabled(executable: &Path) -> Result<bool, String> {
        if !registered_command_matches(registered_command()?.as_deref(), executable) {
            return Ok(false);
        }
        launcher(executable, &crate::main_panel_mode::autostart_arguments())
            .is_enabled()
            .map_err(|err| format!("failed to check portable startup status: {err}"))
    }

    pub(super) fn set_enabled(executable: &Path, enabled: bool) -> Result<bool, String> {
        let launcher = launcher(executable, &crate::main_panel_mode::autostart_arguments());
        if enabled {
            ensure_run_key()?;
            launcher
                .enable()
                .map_err(|err| format!("failed to enable portable startup: {err}"))?;
        } else if registered_command_matches(registered_command()?.as_deref(), executable) {
            launcher
                .disable()
                .map_err(|err| format!("failed to disable portable startup: {err}"))?;
        }
        is_enabled(executable)
    }

    pub(super) fn reconcile(executable: &Path, startup: bool) -> Result<(), String> {
        let existing = registered_command()?;
        let arguments = crate::main_panel_mode::autostart_arguments();
        let launcher = launcher(executable, &arguments);
        match startup_sync_action(startup, existing.as_deref(), executable, &arguments) {
            StartupSyncAction::Register(_) => {
                ensure_run_key()?;
                launcher
                    .enable()
                    .map_err(|err| format!("failed to update portable startup path: {err}"))?
            }
            StartupSyncAction::UpdateCommand(command) => {
                // Changing the backend must not undo a Task Manager startup
                // disable. AutoLaunch::enable would reset StartupApproved.
                RegKey::predef(HKEY_CURRENT_USER)
                    .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
                    .and_then(|key| key.set_value(ENTRY_NAME, &command))
                    .map_err(|err| format!("failed to update portable startup arguments: {err}"))?;
            }
            StartupSyncAction::Unregister => launcher
                .disable()
                .map_err(|err| format!("failed to remove portable startup entry: {err}"))?,
            StartupSyncAction::Unchanged => {}
        }
        Ok(())
    }

    pub(super) fn reconcile_before_single_instance(executable: &Path) -> Result<(), String> {
        // A secondary launch only restores the running panel. Do not let its
        // default arguments overwrite the primary session's chosen backend.
        if registered_command_matches(registered_command()?.as_deref(), executable) {
            return Ok(());
        }
        reconcile(executable, true)
    }

    fn ensure_run_key() -> Result<(), String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(RUN_KEY)
            .map(|_| ())
            .map_err(|err| format!("failed to create portable startup key: {err}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn launcher_keeps_the_quoted_path_separate_from_backend_arguments() {
            let executable = Path::new(r"C:\Users\Ada Lovelace\vPaste\vPaste.exe");
            let arguments = ["--dev-mode", "--main-ui=winui"];
            let launcher = launcher(executable, &arguments);
            assert_eq!(
                launcher.get_app_path(),
                r#""C:\Users\Ada Lovelace\vPaste\vPaste.exe""#
            );
            assert_eq!(launcher.get_args(), arguments);
            assert_eq!(
                format!(
                    "{} {}",
                    launcher.get_app_path(),
                    launcher.get_args().join(" ")
                ),
                startup_command(executable, &arguments)
            );
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn is_enabled() -> Result<bool, String> {
    windows::is_enabled(&current_executable()?)
}

#[cfg(target_os = "windows")]
pub(crate) fn set_enabled(enabled: bool) -> Result<bool, String> {
    windows::set_enabled(&current_executable()?, enabled)
}

#[cfg(target_os = "windows")]
pub(crate) fn reconcile(startup: bool) -> Result<(), String> {
    windows::reconcile(&current_executable()?, startup)
}

#[cfg(target_os = "windows")]
pub(crate) fn reconcile_before_single_instance() -> Result<(), String> {
    let Some(data_dir) = crate::runtime_mode::portable_data_directory()? else {
        return Ok(());
    };
    if startup_enabled_in_config(&data_dir)? {
        crate::runtime_mode::ensure_writable_directory(&data_dir)?;
        windows::reconcile_before_single_instance(&current_executable()?)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn current_executable() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|err| format!("failed to locate portable executable: {err}"))
}

#[cfg(test)]
mod tests {
    use super::{
        registered_command_matches, startup_enabled_in_config, startup_sync_action,
        StartupSyncAction,
    };
    use std::path::Path;

    #[test]
    fn portable_startup_registers_the_current_executable_with_quoted_spaces() {
        let executable = Path::new(r"C:\Users\Ada Lovelace\vPaste\vPaste.exe");

        assert_eq!(
            startup_sync_action(true, None, executable, &[]),
            StartupSyncAction::Register(r#""C:\Users\Ada Lovelace\vPaste\vPaste.exe""#.to_string())
        );
    }

    #[test]
    fn portable_startup_refreshes_a_moved_executable() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");

        assert_eq!(
            startup_sync_action(
                true,
                Some(r#""C:\Tools\vPaste\vPaste.exe""#),
                executable,
                &[]
            ),
            StartupSyncAction::Register(r#""D:\Tools\vPaste\vPaste.exe""#.to_string())
        );
    }

    #[test]
    fn portable_startup_leaves_the_current_entry_unchanged() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");

        assert_eq!(
            startup_sync_action(
                true,
                Some(r#""D:\Tools\vPaste\vPaste.exe""#),
                executable,
                &[]
            ),
            StartupSyncAction::Unchanged
        );
    }

    #[test]
    fn portable_startup_accepts_the_launch_librarys_trailing_space() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");

        assert_eq!(
            startup_sync_action(
                true,
                Some("\"D:\\Tools\\vPaste\\vPaste.exe\" "),
                executable,
                &[]
            ),
            StartupSyncAction::Unchanged
        );
    }

    #[test]
    fn an_unconfigured_portable_copy_does_not_remove_another_copys_entry() {
        let executable = Path::new(r"D:\Other Copy\vPaste.exe");

        assert_eq!(
            startup_sync_action(
                false,
                Some(r#""C:\Tools\vPaste\vPaste.exe""#),
                executable,
                &[]
            ),
            StartupSyncAction::Unchanged
        );
        assert_eq!(
            startup_sync_action(false, None, executable, &[]),
            StartupSyncAction::Unchanged
        );
    }

    #[test]
    fn an_opted_out_copy_removes_its_own_entry_on_launch() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");

        assert_eq!(
            startup_sync_action(
                false,
                Some(r#""D:\Tools\vPaste\vPaste.exe""#),
                executable,
                &[]
            ),
            StartupSyncAction::Unregister
        );
    }

    #[test]
    fn disabling_a_copy_only_owns_its_matching_registry_entry() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");

        assert!(registered_command_matches(
            Some("\"D:\\Tools\\vPaste\\vPaste.exe\" "),
            executable
        ));
        assert!(!registered_command_matches(
            Some(r#""C:\Tools\vPaste\vPaste.exe""#),
            executable
        ));
    }

    #[test]
    fn disabling_a_native_portable_copy_recognizes_its_backend_arguments() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");
        assert_eq!(
            startup_sync_action(
                false,
                Some(r#""D:\Tools\vPaste\vPaste.exe" --main-ui=winui"#),
                executable,
                &[],
            ),
            StartupSyncAction::Unregister
        );
        assert!(registered_command_matches(
            Some(r#""D:\Tools\vPaste\vPaste.exe" --dev-mode --main-ui=winui"#),
            executable
        ));
    }

    #[test]
    fn native_arguments_do_not_make_a_different_executable_our_entry() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");
        for command in [
            r#""D:\Other Copy\vPaste.exe" --main-ui=winui"#,
            r#""D:\Tools\vPaste\vPaste.exe.backup" --main-ui=winui"#,
            r#""D:\Tools\vPaste\vPaste.exe"unexpected"#,
        ] {
            assert!(!registered_command_matches(Some(command), executable));
        }
    }

    #[test]
    fn portable_startup_updates_the_backend_without_changing_the_executable() {
        let executable = Path::new(r"D:\Tools\vPaste\vPaste.exe");
        let webview = r#""D:\Tools\vPaste\vPaste.exe""#;
        let native = r#""D:\Tools\vPaste\vPaste.exe" --main-ui=winui"#;
        assert_eq!(
            startup_sync_action(true, Some(webview), executable, &["--main-ui=winui"]),
            StartupSyncAction::UpdateCommand(native.into())
        );
        assert_eq!(
            startup_sync_action(true, Some(native), executable, &["--main-ui=winui"]),
            StartupSyncAction::Unchanged
        );
        assert_eq!(
            startup_sync_action(true, Some(native), executable, &[]),
            StartupSyncAction::UpdateCommand(webview.into())
        );
    }

    #[test]
    fn moved_native_copy_keeps_the_requested_mode_and_debug_data_isolation() {
        let executable = Path::new(r"E:\Moved Folder\vPaste.exe");
        assert_eq!(
            startup_sync_action(
                true,
                Some(r#""D:\Old Folder\vPaste.exe" --main-ui=winui"#),
                executable,
                &["--dev-mode", "--main-ui=winui"],
            ),
            StartupSyncAction::Register(
                r#""E:\Moved Folder\vPaste.exe" --dev-mode --main-ui=winui"#.into()
            )
        );
    }

    #[test]
    fn preflight_reads_opted_in_portable_config_before_single_instance_setup() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(!startup_enabled_in_config(workspace.path()).unwrap());

        std::fs::write(workspace.path().join("config.json"), r#"{"startup":true}"#).unwrap();
        assert!(startup_enabled_in_config(workspace.path()).is_err());

        let mut enabled_config = crate::config::Config::for_runtime(true);
        enabled_config.startup = true;
        std::fs::write(
            workspace.path().join("config.json"),
            serde_json::to_vec(&enabled_config).unwrap(),
        )
        .unwrap();
        assert!(startup_enabled_in_config(workspace.path()).unwrap());

        enabled_config.startup = false;
        std::fs::write(
            workspace.path().join("config.json"),
            serde_json::to_vec(&enabled_config).unwrap(),
        )
        .unwrap();
        assert!(!startup_enabled_in_config(workspace.path()).unwrap());
    }
}
