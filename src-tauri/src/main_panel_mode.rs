//! Process-local UI choice; never persists a backend into user configuration.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MainUi {
    #[default]
    Webview,
    Native,
    WinUi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Selection {
    pub(crate) mode: MainUi,
    pub(crate) explicit: bool,
}

#[cfg(any(all(target_os = "windows", feature = "winui"), test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WinUiFailureDisposition {
    FallbackToWebview,
    FailExplicitRequest,
}

#[cfg(any(all(target_os = "windows", feature = "winui"), test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WinUiStartupOutcome {
    Webview,
    WinUiReady,
    FallbackToWebview { reason: String },
}

#[cfg(any(all(target_os = "windows", feature = "winui"), test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ModeState {
    selection: Selection,
    fallback_to_webview: bool,
}

#[cfg(any(all(target_os = "windows", feature = "winui"), test))]
impl ModeState {
    #[cfg(test)]
    pub(crate) fn from_selection(selection: Selection) -> Self {
        Self {
            selection,
            fallback_to_webview: false,
        }
    }

    pub(crate) fn effective_mode(&self) -> MainUi {
        if self.selection.mode == MainUi::WinUi && self.fallback_to_webview {
            MainUi::Webview
        } else {
            self.selection.mode
        }
    }

    #[cfg(test)]
    pub(crate) fn allows_main_webview(&self) -> bool {
        self.effective_mode().allows_main_webview()
    }

    #[cfg(test)]
    pub(crate) fn keeps_background_alive(&self, exit_code: Option<i32>) -> bool {
        self.effective_mode().keeps_background_alive(exit_code)
    }

    /// 生产启动与离线测试共用的 WinUI 初始化/回退协调状态机。
    pub(crate) fn coordinate_winui_startup<F>(
        &mut self,
        initialize_winui: F,
    ) -> Result<WinUiStartupOutcome, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        if self.effective_mode() != MainUi::WinUi {
            return Ok(WinUiStartupOutcome::Webview);
        }
        match initialize_winui() {
            Ok(()) => Ok(WinUiStartupOutcome::WinUiReady),
            Err(reason) => match winui_failure_disposition(self.selection) {
                WinUiFailureDisposition::FallbackToWebview => {
                    self.fallback_to_webview = true;
                    Ok(WinUiStartupOutcome::FallbackToWebview { reason })
                }
                WinUiFailureDisposition::FailExplicitRequest => Err(reason),
            },
        }
    }
}

impl MainUi {
    fn keeps_background_alive(self, exit_code: Option<i32>) -> bool {
        matches!(self, Self::Native | Self::WinUi) && exit_code.is_none()
    }

    fn allows_main_webview(self) -> bool {
        self == Self::Webview
    }
}

static SELECTION: OnceLock<Selection> = OnceLock::new();
static WINUI_FALLBACK_TO_WEBVIEW: AtomicBool = AtomicBool::new(false);
pub(crate) const WINDOWS_INTERNAL_RC: bool = cfg!(all(target_os = "windows", feature = "winui-rc"));

#[cfg(target_os = "windows")]
pub(crate) fn default_main_ui_name() -> &'static str {
    if cfg!(feature = "winui") {
        "winui"
    } else {
        "webview"
    }
}

fn parse_selection(
    args: &[String],
    macos: bool,
    windows: bool,
    winui_feature: bool,
) -> Result<Selection, String> {
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
    let explicit = choice.is_some();
    let mode = choice.unwrap_or(if macos {
        MainUi::Native
    } else if windows && winui_feature {
        MainUi::WinUi
    } else {
        MainUi::Webview
    });
    if mode == MainUi::Native && !macos {
        return Err("--main-ui=native requires macOS".into());
    }
    if mode == MainUi::WinUi && !(windows && winui_feature) {
        return Err("--main-ui=winui requires a Windows build with the winui feature".into());
    }
    Ok(Selection { mode, explicit })
}

#[cfg(test)]
fn parse(
    args: &[String],
    macos: bool,
    windows: bool,
    winui_feature: bool,
) -> Result<MainUi, String> {
    parse_selection(args, macos, windows, winui_feature).map(|selection| selection.mode)
}

#[cfg(any(all(target_os = "windows", feature = "winui"), test))]
pub(crate) fn winui_failure_disposition(selection: Selection) -> WinUiFailureDisposition {
    if selection.mode == MainUi::WinUi && !selection.explicit {
        WinUiFailureDisposition::FallbackToWebview
    } else {
        WinUiFailureDisposition::FailExplicitRequest
    }
}

fn effective_mode() -> MainUi {
    let mode = SELECTION
        .get()
        .map(|selection| selection.mode)
        .unwrap_or_default();
    if mode == MainUi::WinUi && WINUI_FALLBACK_TO_WEBVIEW.load(Ordering::Acquire) {
        MainUi::Webview
    } else {
        mode
    }
}

pub fn configure() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let selection = parse_selection(
        &arguments,
        cfg!(target_os = "macos"),
        cfg!(target_os = "windows"),
        cfg!(feature = "winui"),
    )?;
    SELECTION
        .set(selection)
        .map_err(|_| "Main interface was already selected".into())
}

pub fn native() -> bool {
    effective_mode() == MainUi::Native
}

pub fn winui() -> bool {
    effective_mode() == MainUi::WinUi
}

/// 仅当当前生效后端为 WebView 时允许创建 `clipboard` 主 WebView，
/// 防止 macOS Native 或 Windows WinUI 模式下误创建主 WebView。
pub fn allows_main_webview() -> bool {
    effective_mode().allows_main_webview()
}

/// 仅当本次启动是显式传入 `--main-ui=winui` 且仍处于 WinUI 模式时返回 true。
pub fn explicit_winui() -> bool {
    SELECTION
        .get()
        .is_some_and(|selection| selection.mode == MainUi::WinUi && selection.explicit)
        && winui()
}

/// 生产启动入口：直接复用 `ModeState::coordinate_winui_startup` 协调 WinUI 初始化与安全回退。
#[cfg(all(target_os = "windows", feature = "winui"))]
pub(crate) fn initialize_winui_or_fallback<F>(
    initialize_winui: F,
) -> Result<WinUiStartupOutcome, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let Some(selection) = SELECTION.get().copied() else {
        return Ok(WinUiStartupOutcome::Webview);
    };
    let mut state = ModeState {
        selection,
        fallback_to_webview: WINUI_FALLBACK_TO_WEBVIEW.load(Ordering::Acquire),
    };
    let outcome = state.coordinate_winui_startup(initialize_winui)?;
    if state.fallback_to_webview {
        WINUI_FALLBACK_TO_WEBVIEW.store(true, Ordering::Release);
    }
    Ok(outcome)
}

fn autostart_arguments_for(mode: MainUi, windows: bool, developer_mode: bool) -> Vec<&'static str> {
    // 正式 Windows 构建默认即为 WinUI（且缺 Runtime 可回退 WebView）；
    // 绝不把 `--main-ui=winui` 写入自启动注册表，以免锁死旧版 WebView-only 二进制或阻断回退。
    if !windows || !developer_mode || mode != MainUi::WinUi {
        return Vec::new();
    }
    vec!["--dev-mode"]
}

pub(crate) fn autostart_arguments() -> Vec<&'static str> {
    autostart_arguments_for(
        effective_mode(),
        cfg!(target_os = "windows"),
        crate::get_developer_mode(),
    )
}

pub fn keeps_background_alive(exit_code: Option<i32>) -> bool {
    effective_mode().keeps_background_alive(exit_code)
}

#[cfg(test)]
mod tests {
    use super::{
        autostart_arguments_for, parse, parse_selection, winui_failure_disposition, MainUi,
        ModeState, Selection, WinUiFailureDisposition, WinUiStartupOutcome,
    };
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn internal_rc_starts_winui_and_accepts_explicit_webview() {
        let select = |arguments: &[&str]| parse(&args(arguments), false, true, true).unwrap();
        assert_eq!(select(&[]), MainUi::WinUi);
        assert_eq!(select(&["--updated-from=2.0.0-rc.1"]), MainUi::WinUi);
        assert_eq!(select(&["--main-ui=webview"]), MainUi::Webview);
        assert_eq!(
            select(&["--updated-from=2.0.0-rc.1", "--main-ui", "webview"]),
            MainUi::Webview
        );
    }

    #[test]
    fn macos_defaults_to_native_and_non_winui_platforms_default_to_webview() {
        for (macos, windows, expected) in [
            (true, false, MainUi::Native),
            (false, true, MainUi::Webview),
            (false, false, MainUi::Webview),
        ] {
            for args in [args(&["vpaste"]), args(&["vpaste", "--dev-mode"])] {
                assert_eq!(parse(&args, macos, windows, false).unwrap(), expected);
            }
            assert_eq!(
                parse(&args(&["--main-ui=webview"]), macos, windows, false).unwrap(),
                MainUi::Webview
            );
        }
    }

    #[test]
    fn native_accepts_both_forms_on_macos_without_developer_mode() {
        for argument in [args(&["--main-ui=native"]), args(&["--main-ui", "native"])] {
            assert_eq!(
                parse(&argument, true, false, false).unwrap(),
                MainUi::Native
            );
            assert!(parse(&argument, false, true, false).is_err());
            assert!(parse(&argument, false, false, false).is_err());
        }
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
    fn winui_enabled_windows_builds_default_to_winui_and_preserve_webview_escape_hatch() {
        // 仅 Windows 且开启 winui feature 时默认选择 WinUI，且标记为非显式以允许安全回退。
        for arguments in [
            args(&[]),
            args(&["vPaste.exe"]),
            args(&["vPaste.exe", "--updated-from=1.6.0"]),
        ] {
            let selection = parse_selection(&arguments, false, true, true).unwrap();
            assert_eq!(
                selection,
                Selection {
                    mode: MainUi::WinUi,
                    explicit: false,
                }
            );
            assert_eq!(
                winui_failure_disposition(selection),
                WinUiFailureDisposition::FallbackToWebview
            );
        }

        // 显式 --main-ui=webview 始终作为可靠逃生口生效，不进入 WinUI。
        for arguments in [
            args(&["vPaste.exe", "--main-ui=webview"]),
            args(&["vPaste.exe", "--main-ui", "webview"]),
        ] {
            let selection = parse_selection(&arguments, false, true, true).unwrap();
            assert_eq!(
                selection,
                Selection {
                    mode: MainUi::Webview,
                    explicit: true,
                }
            );
        }

        // 显式 --main-ui=winui 标记为 explicit=true，不可静默回退。
        for arguments in [
            args(&["--dev-mode", "--main-ui=winui"]),
            args(&["--dev-mode", "--main-ui", "winui"]),
            args(&["--main-ui=winui"]),
        ] {
            let selection = parse_selection(&arguments, false, true, true).unwrap();
            assert_eq!(
                selection,
                Selection {
                    mode: MainUi::WinUi,
                    explicit: true,
                }
            );
            assert_eq!(
                winui_failure_disposition(selection),
                WinUiFailureDisposition::FailExplicitRequest
            );
        }
        // 非 Windows 或未开启 winui feature 的构建不受影响。
        assert_eq!(
            parse(&args(&[]), true, false, true).unwrap(),
            MainUi::Native
        );
        assert_eq!(
            parse(&args(&[]), false, false, true).unwrap(),
            MainUi::Webview
        );
        assert_eq!(
            parse(&args(&[]), false, true, false).unwrap(),
            MainUi::Webview
        );
        assert!(parse(&args(&["--main-ui=winui"]), true, false, true).is_err());
        assert!(parse(&args(&["--main-ui=winui"]), false, true, false).is_err());
        assert!(parse(&args(&["--main-ui=winui"]), false, false, true).is_err());
    }

    #[test]
    fn invalid_missing_and_duplicate_choices_are_rejected() {
        for argument in [
            args(&["--main-ui"]),
            args(&["--main-ui="]),
            args(&["--main-ui=other"]),
            args(&["--main-ui=webview", "--main-ui=native"]),
            args(&["--main-ui=winui", "--main-ui=webview"]),
        ] {
            assert!(parse(&argument, true, false, false).is_err());
            assert!(parse(&argument, false, true, true).is_err());
        }
    }

    #[test]
    fn autostart_never_persists_winui_argument_to_keep_downgrades_and_fallback_safe() {
        // 正式版自启动绝不写入 --main-ui=winui，兼容旧版 WebView-only 与运行时缺失回退。
        assert!(autostart_arguments_for(MainUi::WinUi, true, false).is_empty());
        assert_eq!(
            parse_selection(&args(&[]), false, true, true).unwrap(),
            Selection {
                mode: MainUi::WinUi,
                explicit: false,
            }
        );
        assert_eq!(
            parse(&args(&[]), false, true, false).unwrap(),
            MainUi::Webview
        );

        // 开发模式仅保留 --dev-mode 数据隔离参数，不硬编码 --main-ui=winui。
        let dev_arguments = autostart_arguments_for(MainUi::WinUi, true, true);
        assert_eq!(dev_arguments, vec!["--dev-mode"]);
        assert!(!dev_arguments.iter().any(|arg| arg.contains("main-ui")));
        assert_eq!(
            parse(&args(&dev_arguments), false, true, true).unwrap(),
            MainUi::WinUi
        );
        assert_eq!(
            parse(&args(&dev_arguments), false, true, false).unwrap(),
            MainUi::Webview
        );
    }

    #[test]
    fn other_backends_and_platforms_keep_the_existing_autostart_arguments() {
        for developer_mode in [false, true] {
            assert!(autostart_arguments_for(MainUi::Webview, true, developer_mode).is_empty());
            assert!(autostart_arguments_for(MainUi::Native, false, developer_mode).is_empty());
            assert!(autostart_arguments_for(MainUi::WinUi, false, developer_mode).is_empty());
        }
    }

    #[test]
    fn production_state_machine_coordinates_default_fallback_explicit_failure_and_webview_guard() {
        // 1. 显式 --main-ui=webview：允许主 WebView，且绝不触发 WinUI 初始化。
        let webview_selection = parse_selection(
            &args(&["vPaste.exe", "--main-ui=webview"]),
            false,
            true,
            true,
        )
        .unwrap();
        let mut webview_state = ModeState::from_selection(webview_selection);
        assert!(webview_state.allows_main_webview());
        let mut called = 0usize;
        let outcome = webview_state
            .coordinate_winui_startup(|| {
                called += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(outcome, WinUiStartupOutcome::Webview);
        assert_eq!(called, 0);
        assert_eq!(webview_state.effective_mode(), MainUi::Webview);
        assert!(webview_state.allows_main_webview());

        // 2. 默认 WinUI 在初始化成功时禁用主 WebView 并保持后台存活语义。
        let default_selection = parse_selection(&args(&["vPaste.exe"]), false, true, true).unwrap();
        let mut ready_state = ModeState::from_selection(default_selection);
        assert!(!ready_state.allows_main_webview());
        assert_eq!(
            ready_state.coordinate_winui_startup(|| Ok(())).unwrap(),
            WinUiStartupOutcome::WinUiReady
        );
        assert_eq!(ready_state.effective_mode(), MainUi::WinUi);
        assert!(!ready_state.allows_main_webview());
        assert!(ready_state.keeps_background_alive(None));

        // 3. 默认 WinUI 在 Runtime 缺失/不兼容时安全回退 WebView，并恢复主 WebView 创建与退出语义。
        let mut fallback_state = ModeState::from_selection(default_selection);
        let outcome = fallback_state
            .coordinate_winui_startup(|| Err("runtime 2.6.5.0 missing".into()))
            .unwrap();
        assert_eq!(
            outcome,
            WinUiStartupOutcome::FallbackToWebview {
                reason: "runtime 2.6.5.0 missing".into(),
            }
        );
        assert_eq!(fallback_state.effective_mode(), MainUi::Webview);
        assert!(fallback_state.allows_main_webview());
        assert!(!fallback_state.keeps_background_alive(None));

        // 4. 显式 --main-ui=winui 在初始化失败时返回错误，绝不静默回退或放开主 WebView。
        let explicit_selection =
            parse_selection(&args(&["vPaste.exe", "--main-ui=winui"]), false, true, true).unwrap();
        let mut explicit_state = ModeState::from_selection(explicit_selection);
        let err = explicit_state
            .coordinate_winui_startup(|| Err("HRESULT 0x80040010".into()))
            .unwrap_err();
        assert_eq!(err, "HRESULT 0x80040010");
        assert_eq!(explicit_state.effective_mode(), MainUi::WinUi);
        assert!(!explicit_state.allows_main_webview());
    }
}
