//! Process-local UI choice; never persists a backend into user configuration.
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MainUi {
    #[default]
    Webview,
    Native,
    WinUi,
}

impl MainUi {
    fn keeps_background_alive(self, exit_code: Option<i32>) -> bool {
        matches!(self, Self::Native | Self::WinUi) && exit_code.is_none()
    }
}

static MODE: OnceLock<MainUi> = OnceLock::new();

fn parse(
    args: &[String],
    macos: bool,
    windows: bool,
    debug: bool,
    winui_feature: bool,
) -> Result<MainUi, String> {
    let mut choice = None;
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        let value = if argument == "--main-ui" {
            Some(arguments.next().map(String::as_str).unwrap_or(""))
        } else {
            argument.strip_prefix("--main-ui=")
        };
        let Some(value) = value else { continue };
        if choice.is_some() {
            return Err("Specify --main-ui only once".into());
        }
        choice = Some(match value {
            "native" => MainUi::Native,
            "webview" => MainUi::Webview,
            "winui" => MainUi::WinUi,
            _ => return Err("--main-ui must be native, winui, or webview".into()),
        });
    }
    let mode = choice.unwrap_or_default();
    if mode == MainUi::Native
        && !(macos && debug && args.iter().any(|argument| argument == "--dev-mode"))
    {
        return Err("--main-ui=native requires a macOS Debug build with --dev-mode".into());
    }
    if mode == MainUi::WinUi && !(windows && winui_feature) {
        return Err("--main-ui=winui requires a Windows build with the winui feature".into());
    }
    Ok(mode)
}

pub fn configure() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let mode = parse(
        &arguments,
        cfg!(target_os = "macos"),
        cfg!(target_os = "windows"),
        cfg!(debug_assertions),
        cfg!(feature = "winui"),
    )?;
    MODE.set(mode)
        .map_err(|_| "Main interface was already selected".into())
}

pub fn native() -> bool {
    MODE.get().copied().unwrap_or_default() == MainUi::Native
}

pub fn winui() -> bool {
    MODE.get().copied().unwrap_or_default() == MainUi::WinUi
}

fn autostart_arguments_for(mode: MainUi, windows: bool, developer_mode: bool) -> Vec<&'static str> {
    if !windows || mode != MainUi::WinUi {
        return Vec::new();
    }
    if developer_mode {
        vec!["--dev-mode", "--main-ui=winui"]
    } else {
        vec!["--main-ui=winui"]
    }
}

pub(crate) fn autostart_arguments() -> Vec<&'static str> {
    autostart_arguments_for(
        MODE.get().copied().unwrap_or_default(),
        cfg!(target_os = "windows"),
        crate::get_developer_mode(),
    )
}

pub fn keeps_background_alive(exit_code: Option<i32>) -> bool {
    MODE.get()
        .copied()
        .unwrap_or_default()
        .keeps_background_alive(exit_code)
}

#[cfg(test)]
mod tests {
    use super::{autostart_arguments_for, parse, MainUi};
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn absent_and_explicit_webview_preserve_the_existing_backend() {
        assert_eq!(
            parse(&args(&["vpaste", "--dev-mode"]), true, false, true, false).unwrap(),
            MainUi::Webview
        );
        assert_eq!(
            parse(
                &args(&["vpaste", "--main-ui=webview"]),
                false,
                true,
                false,
                false
            )
            .unwrap(),
            MainUi::Webview
        );
    }
    #[test]
    fn native_accepts_both_forms_only_on_macos_dev() {
        for argument in [
            args(&["--dev-mode", "--main-ui=native"]),
            args(&["--dev-mode", "--main-ui", "native"]),
        ] {
            assert_eq!(
                parse(&argument, true, false, true, false).unwrap(),
                MainUi::Native
            );
            assert!(parse(&argument, false, true, true, false).is_err());
            assert!(parse(&argument, true, false, false, false).is_err());
        }
        assert!(parse(&args(&["--main-ui=native"]), true, false, true, false).is_err());
    }
    #[test]
    fn closing_the_last_auxiliary_window_keeps_native_background_services_alive() {
        assert!(MainUi::Native.keeps_background_alive(None));
        assert!(!MainUi::Native.keeps_background_alive(Some(0)));
        assert!(!MainUi::Native.keeps_background_alive(Some(1)));
        assert!(!MainUi::Webview.keeps_background_alive(None));
        assert!(MainUi::WinUi.keeps_background_alive(None));
        assert!(!MainUi::WinUi.keeps_background_alive(Some(0)));
    }

    #[test]
    fn winui_is_opt_in_on_windows_in_debug_and_release() {
        for arguments in [
            args(&["--dev-mode", "--main-ui=winui"]),
            args(&["--dev-mode", "--main-ui", "winui"]),
            args(&["--main-ui=winui"]),
        ] {
            for debug in [true, false] {
                assert_eq!(
                    parse(&arguments, false, true, debug, true).unwrap(),
                    MainUi::WinUi
                );
            }
        }
        let arguments = args(&["--dev-mode", "--main-ui=winui"]);
        assert!(parse(&arguments, true, false, true, true).is_err());
        assert!(parse(&arguments, false, true, true, false).is_err());
        assert!(parse(&arguments, false, true, false, false).is_err());
        assert_eq!(
            parse(&args(&[]), false, true, false, true).unwrap(),
            MainUi::Webview
        );
    }

    #[test]
    fn invalid_missing_and_duplicate_choices_are_rejected() {
        for argument in [
            args(&["--main-ui"]),
            args(&["--main-ui="]),
            args(&["--main-ui=other"]),
            args(&["--main-ui=webview", "--main-ui=native"]),
        ] {
            assert!(parse(&argument, true, false, true, false).is_err());
        }
    }

    #[test]
    fn winui_autostart_replays_the_backend_and_preserves_developer_isolation() {
        for developer_mode in [false, true] {
            let arguments = autostart_arguments_for(MainUi::WinUi, true, developer_mode);
            assert_eq!(arguments.contains(&"--dev-mode"), developer_mode);
            assert_eq!(arguments.len(), if developer_mode { 2 } else { 1 });
            assert_eq!(
                parse(&args(&arguments), false, true, developer_mode, true).unwrap(),
                MainUi::WinUi
            );
        }
    }

    #[test]
    fn other_backends_and_platforms_keep_the_existing_autostart_arguments() {
        for developer_mode in [false, true] {
            assert!(autostart_arguments_for(MainUi::Webview, true, developer_mode).is_empty());
            assert!(autostart_arguments_for(MainUi::Native, false, developer_mode).is_empty());
            assert!(autostart_arguments_for(MainUi::WinUi, false, developer_mode).is_empty());
        }
    }
}
