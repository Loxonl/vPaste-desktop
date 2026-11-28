//! Windows WinUI 3 host. The XAML bridge is loaded on demand
//! so the ordinary WebView backend does not load Windows App SDK runtime.

use std::{
    ffi::{c_char, c_void, OsStr},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    sync::{atomic::AtomicBool, Mutex, OnceLock},
};

use serde_json::json;
use tauri::{AppHandle, Emitter, Listener, Manager};

mod actions;
mod app_actions;
mod behavior;
pub(crate) mod bridge;
use bridge::response as response_bytes;
mod drag;
mod editor;
mod file_icons;
mod filters;
mod focus;
mod layout;
mod ocr;
pub(crate) mod onboarding;
mod presentation;
pub(crate) mod preview;
mod reader;
mod search;
mod tab_order;
pub(crate) mod tray;
// This projection has no AppKit dependency. Keep the macOS importer unchanged.
#[path = "native_panel/rich_text.rs"]
mod rich_text;

type PanelCall = unsafe extern "C" fn() -> i32;
type PanelWindowHandle = unsafe extern "C" fn() -> usize;
type PanelSetTheme = unsafe extern "C" fn(u32) -> i32;
type PanelSetLayout = unsafe extern "C" fn(*const layout::PanelLayout) -> i32;
type PanelGetLayout = unsafe extern "C" fn(*mut layout::PanelLayout) -> i32;
type PanelSetPreviewLayout = unsafe extern "C" fn(*const layout::PanelLayout) -> i32;
type PanelSizePreview = unsafe extern "C" fn(bool, bool) -> i32;
type PanelSetLanguage = unsafe extern "C" fn(bool) -> i32;
type PanelShutdown = unsafe extern "C" fn();
type PanelRequest = unsafe extern "C" fn(*const u8, usize);
type PanelReceive = unsafe extern "C" fn(*const u8, usize);
type PanelSetBehavior = unsafe extern "C" fn(*const u8, usize) -> i32;
type PanelSetClickMode = unsafe extern "C" fn(bool) -> i32;
type PanelSetQueueView = unsafe extern "C" fn(bool) -> i32;
type PanelSetDiagnosticsLogPath = unsafe extern "C" fn(*const u16) -> i32;
type PanelInitialize = unsafe extern "C" fn(extern "C" fn(bool), PanelRequest, bool, bool) -> i32;
type BootstrapInitialize = unsafe extern "system" fn(u32, *const u16, u64, u32) -> i32;
type BootstrapShutdown = unsafe extern "system" fn();

struct PanelApi {
    _module: LoadedModule,
    initialize: PanelInitialize,
    show: PanelCall,
    toggle: PanelCall,
    hide: PanelCall,
    refresh: PanelCall,
    receive: PanelReceive,
    set_theme: PanelSetTheme,
    set_layout: PanelSetLayout,
    get_layout: PanelGetLayout,
    set_preview_layout: PanelSetPreviewLayout,
    size_preview: PanelSizePreview,
    set_language: PanelSetLanguage,
    set_click_mode: PanelSetClickMode,
    set_behavior: PanelSetBehavior,
    set_queue_view: PanelSetQueueView,
    hide_for_queue_paste: PanelCall,
    refresh_tags: PanelCall,
    window_handle: PanelWindowHandle,
    reader_handle: PanelWindowHandle,
    focus_history: PanelCall,
    set_diagnostics_log_path: Option<PanelSetDiagnosticsLogPath>,
    shutdown: PanelShutdown,
}

struct BootstrapApi {
    _module: LoadedModule,
    shutdown: BootstrapShutdown,
}

impl Drop for BootstrapApi {
    fn drop(&mut self) {
        // SAFETY: the bootstrap is initialized and its module is still loaded.
        unsafe { (self.shutdown)() };
    }
}

struct NativeLibraries {
    // Drop the panel module before disconnecting the runtime dependency.
    panel: PanelApi,
    bootstrap: BootstrapApi,
}

static NATIVE_LIBRARIES: OnceLock<Result<NativeLibraries, String>> = OnceLock::new();
static NATIVE_SHUTDOWN_DONE: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();
static ACTION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static MODAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static SIZE_PREVIEW: Mutex<Option<SizePreviewSnapshot>> = Mutex::new(None);

// 锁定与 WindowsAppSDK 2.6.5 构建一致的运行时版本下限 (2.6.5.0 = 0x0002_0006_0005_0000)。
const RUNTIME_MAJOR_MINOR: u32 = 0x0002_0006;
const RUNTIME_MIN_VERSION: u64 = package_version(2, 6, 5, 0);

const fn package_version(major: u16, minor: u16, build: u16, revision: u16) -> u64 {
    ((major as u64) << 48) | ((minor as u64) << 32) | ((build as u64) << 16) | (revision as u64)
}

fn format_bootstrap_error(error: &str) -> String {
    format!(
        "{error}. Windows App Runtime 2.6.5 (x64) or newer compatible 2.6 runtime is missing or incompatible. Install Windows App Runtime 2.6.5 (x64) and restart vPaste, or launch with --main-ui=webview."
    )
}

/// Owns the module reference returned by LoadLibraryW.
struct LoadedModule(usize);

impl LoadedModule {
    fn as_ptr(&self) -> *mut c_void {
        self.0 as *mut c_void
    }
}

impl Drop for LoadedModule {
    fn drop(&mut self) {
        // SAFETY: this reference came from a successful LoadLibraryW call.
        unsafe { FreeLibrary(self.as_ptr()) };
    }
}

#[derive(Clone, Copy)]
struct SizePreviewSnapshot {
    layout: layout::PanelLayout,
    was_visible: bool,
}

pub(crate) fn modal_active() -> bool {
    MODAL_ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

pub(crate) fn dragging() -> bool {
    DRAG_ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryW(file_name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn runtime_directory() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = executable
        .parent()
        .ok_or_else(|| "vPaste executable has no parent directory".to_string())?
        .to_path_buf();
    // Cargo's native smoke test runs from debug/deps; build.rs copies the DLLs
    // beside the normal executable one directory above it.
    #[cfg(test)]
    if directory.ends_with("deps") {
        return directory
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "native test has no profile output directory".to_string());
    }
    Ok(directory)
}

fn load_bootstrap() -> Result<BootstrapApi, String> {
    let directory = runtime_directory()?;
    let library_path = directory.join("Microsoft.WindowsAppRuntime.Bootstrap.dll");
    let library_name = wide_null(library_path.as_os_str());
    // SAFETY: the path is a NUL-terminated UTF-16 string valid through the call.
    let module = unsafe { LoadLibraryW(library_name.as_ptr()) };
    if module.is_null() {
        return Err(format!(
            "failed to load Windows App SDK bootstrap {}: {}",
            library_path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let module = LoadedModule(module as usize);
    // SAFETY: export names are NUL-terminated ASCII strings.
    let initialize = unsafe {
        GetProcAddress(
            module.as_ptr(),
            b"MddBootstrapInitialize2\0".as_ptr().cast(),
        )
    };
    let shutdown =
        unsafe { GetProcAddress(module.as_ptr(), b"MddBootstrapShutdown\0".as_ptr().cast()) };
    if initialize.is_null() || shutdown.is_null() {
        return Err("Windows App SDK bootstrap exports are missing".into());
    }
    // SAFETY: signatures match MddBootstrapInitialize2 and MddBootstrapShutdown.
    let initialize: BootstrapInitialize = unsafe { std::mem::transmute(initialize) };
    let shutdown: BootstrapShutdown = unsafe { std::mem::transmute(shutdown) };
    // Bind to compatible 2.6 runtime with minimum version floor 2.6.5.0.
    check_hresult("runtime initialization", unsafe {
        initialize(
            RUNTIME_MAJOR_MINOR,
            std::ptr::null(),
            RUNTIME_MIN_VERSION,
            0,
        )
    })
    .map_err(|error| {
        let mut message = format_bootstrap_error(&error);
        if directory.join("Install-WinUiRuntime.ps1").is_file() {
            message.push_str(" This portable bundle includes Install-WinUiRuntime.ps1.");
        }
        message
    })?;
    Ok(BootstrapApi {
        _module: module,
        shutdown,
    })
}

fn load_panel_api() -> Result<PanelApi, String> {
    let library_path = runtime_directory()?.join("VPasteWinUiPanel.dll");
    let library_name = wide_null(library_path.as_os_str());

    // SAFETY: `library_name` is NUL-terminated and remains valid for the call.
    let raw_module = unsafe { LoadLibraryW(library_name.as_ptr()) };
    if raw_module.is_null() {
        return Err(format!(
            "failed to load WinUI panel library {} (Windows error {})",
            library_path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let guard = LoadedModule(raw_module as usize);
    let module = guard.as_ptr();

    // SAFETY: the version export has a no-argument C ABI and no UI side effects.
    let version =
        unsafe { GetProcAddress(module, b"vpaste_winui_protocol_version\0".as_ptr().cast()) };
    if version.is_null() {
        return Err("WinUI bridge version is missing; rebuild the native app".into());
    }
    let version: unsafe extern "C" fn() -> u32 = unsafe { std::mem::transmute(version) };
    bridge::check_version(unsafe { version() })?;

    // SAFETY: every symbol below has the matching no-argument C ABI declared
    // in WinUiPanel.cpp and the API owns the module reference.
    unsafe fn symbol(module: *mut c_void, name: &'static [u8]) -> Result<PanelCall, String> {
        // SAFETY: symbol names are NUL-terminated byte strings.
        let address = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
        if address.is_null() {
            return Err(format!("WinUI panel export {} is missing", name[0] as char));
        }
        // SAFETY: the exported function uses the `PanelCall` signature.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelCall>(address) })
    }
    unsafe fn shutdown_symbol(module: *mut c_void) -> Result<PanelShutdown, String> {
        // SAFETY: the symbol name is NUL-terminated.
        let address = unsafe { GetProcAddress(module, b"vpaste_winui_shutdown\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel shutdown export is missing".into());
        }
        // SAFETY: the exported function has the matching no-argument C ABI.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelShutdown>(address) })
    }
    unsafe fn initialize_symbol(module: *mut c_void) -> Result<PanelInitialize, String> {
        // SAFETY: the symbol name is NUL-terminated.
        let address =
            unsafe { GetProcAddress(module, b"vpaste_winui_initialize\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel initialization export is missing".into());
        }
        // SAFETY: the export takes C callbacks for visibility and text reversal.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelInitialize>(address) })
    }
    unsafe fn receive_symbol(module: *mut c_void) -> Result<PanelReceive, String> {
        let address = unsafe { GetProcAddress(module, b"vpaste_winui_receive\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel response export is missing".into());
        }
        // SAFETY: the export copies the borrowed response bytes before returning.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelReceive>(address) })
    }
    unsafe fn set_theme_symbol(module: *mut c_void) -> Result<PanelSetTheme, String> {
        let address =
            unsafe { GetProcAddress(module, b"vpaste_winui_set_theme\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel theme export is missing".into());
        }
        // SAFETY: the export accepts the documented theme enum value.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelSetTheme>(address) })
    }
    unsafe fn set_language_symbol(module: *mut c_void) -> Result<PanelSetLanguage, String> {
        let address =
            unsafe { GetProcAddress(module, b"vpaste_winui_set_language\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel language export is missing".into());
        }
        // SAFETY: the export accepts the documented English-language flag.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelSetLanguage>(address) })
    }
    unsafe fn set_click_mode_symbol(module: *mut c_void) -> Result<PanelSetClickMode, String> {
        let address =
            unsafe { GetProcAddress(module, b"vpaste_winui_set_click_mode\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel click-mode export is missing".into());
        }
        // SAFETY: the export accepts the documented single-click mode flag.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelSetClickMode>(address) })
    }
    unsafe fn set_queue_view_symbol(module: *mut c_void) -> Result<PanelSetQueueView, String> {
        let address =
            unsafe { GetProcAddress(module, b"vpaste_winui_set_queue_view\0".as_ptr().cast()) };
        if address.is_null() {
            return Err("WinUI panel queue-view export is missing".into());
        }
        // SAFETY: the exported function accepts the queue-view visibility flag.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelSetQueueView>(address) })
    }
    // SAFETY: the matching C++ export snapshots an HWND as uintptr_t.
    let window_handle =
        unsafe { GetProcAddress(module, b"vpaste_winui_window_handle\0".as_ptr().cast()) };
    if window_handle.is_null() {
        return Err("WinUI window-handle export is missing".into());
    }
    // SAFETY: matching export reads only the native reader's atomic HWND.
    let reader_handle =
        unsafe { GetProcAddress(module, b"vpaste_winui_reader_handle\0".as_ptr().cast()) };
    if reader_handle.is_null() {
        return Err("WinUI reader-handle export is missing".into());
    }
    // SAFETY: the export takes a borrowed repr(C) PanelLayout and returns HRESULT.
    let set_layout =
        unsafe { GetProcAddress(module, b"vpaste_winui_set_layout\0".as_ptr().cast()) };
    if set_layout.is_null() {
        return Err("WinUI docking-layout export is missing".into());
    }
    // SAFETY: the matching export synchronously fills a caller-owned repr(C) layout.
    let get_layout =
        unsafe { GetProcAddress(module, b"vpaste_winui_get_layout\0".as_ptr().cast()) };
    if get_layout.is_null() {
        return Err("WinUI stable-layout export is missing; rebuild the native app".into());
    }
    // SAFETY: the export borrows a repr(C) preview layout for the synchronous STA message.
    let set_preview_layout =
        unsafe { GetProcAddress(module, b"vpaste_winui_set_preview_layout\0".as_ptr().cast()) };
    if set_preview_layout.is_null() {
        return Err("WinUI preview-layout export is missing; rebuild the native app".into());
    }
    let size_preview =
        unsafe { GetProcAddress(module, b"vpaste_winui_size_preview\0".as_ptr().cast()) };
    if size_preview.is_null() {
        return Err("WinUI size-preview export is missing; rebuild the native app".into());
    }
    // SAFETY: the symbol name is NUL-terminated; the module stays loaded.
    let set_behavior =
        unsafe { GetProcAddress(module, b"vpaste_winui_set_behavior\0".as_ptr().cast()) };
    if set_behavior.is_null() {
        return Err("WinUI behavior export is missing".into());
    }
    // 诊断日志路径导出为可选绑定，保持与既有协议版本 8 兼容。
    let set_diagnostics_log_path = unsafe {
        GetProcAddress(
            module,
            b"vpaste_winui_set_diagnostics_log_path\0".as_ptr().cast(),
        )
    };
    let set_diagnostics_log_path = if set_diagnostics_log_path.is_null() {
        None
    } else {
        // SAFETY: 导出函数签名接收只读 NUL 结尾 UTF-16 路径并返回 HRESULT。
        Some(unsafe {
            std::mem::transmute::<*mut c_void, PanelSetDiagnosticsLogPath>(set_diagnostics_log_path)
        })
    };
    Ok(PanelApi {
        initialize: unsafe { initialize_symbol(module)? },
        show: unsafe { symbol(module, b"vpaste_winui_show\0")? },
        toggle: unsafe { symbol(module, b"vpaste_winui_toggle\0")? },
        hide: unsafe { symbol(module, b"vpaste_winui_hide\0")? },
        refresh: unsafe { symbol(module, b"vpaste_winui_refresh\0")? },
        receive: unsafe { receive_symbol(module)? },
        set_theme: unsafe { set_theme_symbol(module)? },
        set_layout: unsafe { std::mem::transmute::<*mut c_void, PanelSetLayout>(set_layout) },
        get_layout: unsafe { std::mem::transmute::<*mut c_void, PanelGetLayout>(get_layout) },
        set_preview_layout: unsafe {
            std::mem::transmute::<*mut c_void, PanelSetPreviewLayout>(set_preview_layout)
        },
        size_preview: unsafe { std::mem::transmute::<*mut c_void, PanelSizePreview>(size_preview) },
        set_language: unsafe { set_language_symbol(module)? },
        set_click_mode: unsafe { set_click_mode_symbol(module)? },
        // SAFETY: matches the synchronous byte-buffer C ABI in WinUiPanel.cpp.
        set_behavior: unsafe { std::mem::transmute::<*mut c_void, PanelSetBehavior>(set_behavior) },
        set_queue_view: unsafe { set_queue_view_symbol(module)? },
        hide_for_queue_paste: unsafe { symbol(module, b"vpaste_winui_hide_for_queue_paste\0")? },
        refresh_tags: unsafe { symbol(module, b"vpaste_winui_refresh_tags\0")? },
        window_handle: unsafe {
            std::mem::transmute::<*mut c_void, PanelWindowHandle>(window_handle)
        },
        reader_handle: unsafe {
            std::mem::transmute::<*mut c_void, PanelWindowHandle>(reader_handle)
        },
        focus_history: unsafe { symbol(module, b"vpaste_winui_focus_history\0")? },
        set_diagnostics_log_path,
        shutdown: unsafe { shutdown_symbol(module)? },
        _module: guard,
    })
}

fn load_native_libraries() -> Result<NativeLibraries, String> {
    let bootstrap = load_bootstrap()?;
    let panel = load_panel_api()?;
    Ok(NativeLibraries { panel, bootstrap })
}

fn api() -> Result<&'static PanelApi, String> {
    if NATIVE_SHUTDOWN_DONE.load(std::sync::atomic::Ordering::Acquire) {
        return Err("The WinUI panel has shut down".into());
    }
    NATIVE_LIBRARIES
        .get()
        .ok_or_else(|| "The WinUI panel has not started".to_string())?
        .as_ref()
        .map(|libraries| &libraries.panel)
        .map_err(Clone::clone)
}

pub(crate) fn check_runtime() -> Result<(), String> {
    let _libraries = load_native_libraries()?;
    Ok(())
}

fn check_hresult(operation: &str, result: i32) -> Result<(), String> {
    if result >= 0 {
        Ok(())
    } else {
        Err(format!(
            "WinUI {operation} failed (HRESULT 0x{:08X})",
            result as u32
        ))
    }
}

/// Initializes Windows App SDK and starts the island's dedicated STA UI thread.
/// 先完成原生运行时与面板初始化，再注册 Tauri 事件监听器；若中途失败则立即清理，
/// 确保默认回退到 WebView 后不会残留半初始化句柄或无效事件监听。
pub(crate) fn initialize(app: AppHandle) -> Result<(), String> {
    let language = crate::config::get().multilingual;
    let english = language.to_ascii_lowercase().starts_with("en");
    let single_click_paste =
        crate::config::get().mouse_paste_mode == crate::config::MousePasteMode::Single;
    let diagnostics_log_path =
        crate::winui_diagnostics_log_path(std::path::Path::new(&crate::get_app_data_dir()));
    if let Err(error) =
        initialize_native_with_diagnostics(english, single_click_paste, Some(&diagnostics_log_path))
            .and_then(|()| apply_behavior())
            .and_then(|()| layout::before_show(&app))
    {
        shutdown();
        return Err(error);
    }
    let _ = APP.set(app.clone());
    for event in ["listen_new_clipboard", "clipboard-resources-updated"] {
        // Resource notifications may explicitly target the clipboard WebView,
        // which does not exist in this backend.
        app.listen_any(event, move |_| refresh());
    }
    app.listen_any("clipboard-item-edited", move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "clipboardItemEdited", Ok(payload));
        }
        refresh();
    });
    app.listen_any("image-ocr-updated", move |_| {
        send_response(0, "imageOcrUpdated", Ok(json!({})));
        if crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
            refresh();
        }
    });
    // 后端所有 history-reset 均通过全局 app.emit 广播，沿用 app.listen 以匹配呈现契约
    app.listen("history-reset", move |_| {
        preview::owner_hidden();
        send_response(0, "historyReset", Ok(json!({})));
    });
    app.listen_any("custom-tabs-changed", move |_| {
        send_response(0, "filtersChanged", Ok(json!({})));
    });
    app.listen_any("item-tags-changed", move |_| {
        refresh_tags();
    });
    app.listen_any("tab-order-changed", move |event| {
        if let Ok(order) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "tabOrderChanged", Ok(order));
        }
    });
    app.listen_any("paste-queue-state-changed", move |_event| {
        if let Ok(state) = crate::paste_queue::winui_state_value() {
            send_response(0, "queueStateUpdate", Ok(state));
        }
    });
    app.listen_any("app-update-state-changed", move |event| {
        if let Ok(state) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "updateStateChanged", Ok(state));
        }
        if let Some(app) = APP.get() {
            tray::refresh(app);
        }
    });
    app.listen_any("clipboard-history-pause-changed", move |_| {
        if let Some(app) = APP.get() {
            tray::refresh(app);
        }
    });
    app.listen_any("clipboard-capture-rejected", move |_| {
        send_response(0, "captureRejected", Ok(json!({})));
    });
    app.listen_any("clipboard-behavior-config-changed", move |_| {
        app_actions::reset_preview();
        if let Err(error) = apply_behavior() {
            log::error!("Failed to update WinUI input preferences: {error}");
        }
        if let Err(error) = apply_theme() {
            log::debug!("WinUI theme update deferred: {error}");
        }
        if let Err(error) = apply_click_mode() {
            log::debug!("WinUI click-mode update deferred: {error}");
        }
        if let Some(app) = APP.get() {
            tray::refresh(app);
            let owned = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = layout::refresh(&owned) {
                    log::error!("Failed to update WinUI panel layout: {error}");
                }
            }) {
                log::error!("Failed to schedule WinUI panel layout: {error}");
            }
        }
        refresh();
    });
    app.listen_any("language-changed", move |_| {
        app_actions::reset_preview();
        if let Err(error) = apply_language() {
            log::debug!("WinUI language update deferred: {error}");
        }
        let english = crate::config::get()
            .multilingual
            .to_ascii_lowercase()
            .starts_with("en");
        if let Some(app) = APP.get() {
            onboarding::refresh_language(app, english);
            tray::refresh(app);
        }
    });
    Ok(())
}

fn configure_diagnostics_log_path(panel: &PanelApi, log_path: &std::path::Path) {
    let Some(set_path) = panel.set_diagnostics_log_path else {
        return;
    };
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let wide = wide_null(log_path.as_os_str());
    // SAFETY: wide 为 NUL 结尾的 UTF-16 路径字符串，调用期间保持有效，DLL 会同步拷贝路径。
    let _ = unsafe { set_path(wide.as_ptr()) };
}

fn initialize_native_with_diagnostics(
    english: bool,
    single_click_paste: bool,
    diagnostics_log_path: Option<&std::path::Path>,
) -> Result<(), String> {
    let _ = NATIVE_LIBRARIES.get_or_init(load_native_libraries);
    let panel = api()?;
    if let Some(path) = diagnostics_log_path {
        configure_diagnostics_log_path(panel, path);
    }
    // SAFETY: the native side stores these process-lifetime callbacks and calls
    // them from its UI thread with valid arguments. The callback never waits
    // for database work; it schedules that work on the shared Tokio runtime.
    check_hresult("initialization", unsafe {
        (panel.initialize)(
            visibility_changed,
            panel_request,
            english,
            single_click_paste,
        )
    })
}

#[cfg(test)]
fn initialize_native(english: bool, single_click_paste: bool) -> Result<(), String> {
    initialize_native_with_diagnostics(english, single_click_paste, None)
}

extern "C" fn visibility_changed(visible: bool) {
    focus::visibility_changed();
    crate::CLIPBOARD_VISIBLE.store(visible, std::sync::atomic::Ordering::SeqCst);
    if let Some(app) = APP.get() {
        crate::background_resources::set_visible(app, visible);
    }
    if visible {
        crate::CLIPBOARD_HIDING.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Some(app) = APP.get() {
            crate::ensure_focus_watch(app);
        }
    } else {
        preview::owner_hidden();
    }
}

pub(crate) fn show(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        if !crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
            crate::windows_paste_focus::capture_foreground();
            crate::record_foreground_app_before_clipboard();
        }
        if let Err(error) = show_on_ui_thread() {
            log::error!("Failed to show WinUI main panel: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn toggle(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        if let Err(error) = toggle_on_ui_thread() {
            log::error!("Failed to toggle WinUI main panel: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn hide() -> Result<(), String> {
    hide_on_ui_thread()
}

pub(crate) fn restore_after_editor() -> Result<(), String> {
    let panel = api()?;
    let event = br#"{"op":"editorClosed","data":{}}"#;
    // SAFETY: receive copies the bytes and posts restoration to the native STA.
    unsafe { (panel.receive)(event.as_ptr(), event.len()) };
    Ok(())
}

pub(crate) fn text_editor_focused() -> bool {
    editor::focused()
}

pub(crate) fn editor_open() -> bool {
    editor::is_open()
}

pub(crate) fn raise_editor_if_open() {
    editor::raise_if_open();
}

pub(crate) fn refresh_layout(app: &AppHandle) -> Result<(), String> {
    layout::refresh(app)
}

/// 主面板处于隐藏状态（含开机静默自启后首次）时，开启粘贴队列前需先将隐藏主面板同步到当前目标屏幕与 DPI。
pub(crate) fn should_realign_hidden_panel_before_queue(panel_visible: bool) -> bool {
    !panel_visible
}

pub(crate) fn prepare_monitor_for_hidden_panel(app: &AppHandle) -> Result<(), String> {
    layout::before_show(app)
}

/// 当 WinUI 原生编辑器、托盘菜单或非普通预览的原生子窗获得前台焦点时，阻止 focus_watch 将焦点强拉回主列表。
pub(crate) fn other_native_window_foreground() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    if editor::focused() || modal_active() {
        return true;
    }
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0 == 0 {
        return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(foreground, Some(&mut pid)) };
    if pid != std::process::id() {
        return false;
    }
    let Ok(panel) = api() else {
        return false;
    };
    let hwnd = foreground.0 as usize;
    let main_hwnd = unsafe { (panel.window_handle)() };
    if hwnd == main_hwnd {
        return false;
    }
    let reader_hwnd = unsafe { (panel.reader_handle)() };
    // 当 reader 作为普通预览（非编辑器且非 OCR 工具栏文本预览）时，交由 preview_foreground 处理。
    if hwnd == reader_hwnd
        && !editor::is_open()
        && !crate::WINUI_IMAGE_TEXT_PREVIEW.load(std::sync::atomic::Ordering::SeqCst)
    {
        return false;
    }
    true
}

pub(crate) fn set_queue_view(active: bool) -> Result<(), String> {
    let panel = api()?;
    // SAFETY: the DLL marshals the view switch to its dedicated WinUI thread.
    check_hresult("queue-view update", unsafe {
        (panel.set_queue_view)(active)
    })
}

pub(crate) fn show_size_preview(
    source: &tauri::WebviewWindow,
    panel_scale: f64,
) -> Result<(), String> {
    let panel = api()?;
    let mut original = layout::PanelLayout::default();
    check_hresult("size preview layout snapshot", unsafe {
        (panel.get_layout)(&mut original)
    })?;
    let mut preview = SIZE_PREVIEW
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if preview.is_none() {
        *preview = Some(SizePreviewSnapshot {
            layout: original,
            was_visible: crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst),
        });
    }
    drop(preview);

    layout::apply_size_preview(source, panel_scale)?;
    check_hresult("size preview show", unsafe {
        (panel.size_preview)(true, false)
    })
}

pub(crate) fn finish_size_preview() -> Result<bool, String> {
    let panel = api()?;
    let Some(snapshot) = SIZE_PREVIEW
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    else {
        return Ok(crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst));
    };
    let layout_result = check_hresult("size preview layout restore", unsafe {
        (panel.set_preview_layout)(&snapshot.layout)
    });
    let visibility_result = check_hresult("size preview restore", unsafe {
        (panel.size_preview)(false, snapshot.was_visible)
    });
    layout_result?;
    visibility_result?;
    Ok(snapshot.was_visible)
}

pub(crate) fn hide_for_queue_paste() -> Result<(), String> {
    let panel = api()?;
    // SAFETY: the DLL hides the panel without discarding its queue return state.
    check_hresult("hide for queue paste", unsafe {
        (panel.hide_for_queue_paste)()
    })
}

pub(crate) fn shutdown() {
    DRAG_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    MODAL_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    if !NATIVE_SHUTDOWN_DONE.swap(true, std::sync::atomic::Ordering::AcqRel) {
        if let Some(Ok(libraries)) = NATIVE_LIBRARIES.get() {
            // SAFETY: called during Tauri shutdown or failed init cleanup;
            // the bridge stops and joins its dedicated UI thread before returning.
            unsafe {
                (libraries.panel.shutdown)();
                (libraries.bootstrap.shutdown)();
            }
        }
    }
}

static PENDING_CAPTURE_SYNC: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static LATEST_QUERY_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_query_generation() -> u64 {
    LATEST_QUERY_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

fn current_query_generation() -> u64 {
    LATEST_QUERY_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}

fn is_query_generation_current(generation: u64) -> bool {
    LATEST_QUERY_GENERATION.load(std::sync::atomic::Ordering::Acquire) == generation
}

fn show_on_ui_thread() -> Result<(), String> {
    let panel = api()?;
    if let Some(app) = APP.get() {
        layout::before_show(app)?;
    }
    apply_behavior()?;
    apply_theme()?;
    PENDING_CAPTURE_SYNC.store(true, std::sync::atomic::Ordering::SeqCst);
    // SAFETY: the DLL marshals this call to its dedicated UI thread.
    check_hresult("show", unsafe { (panel.show)() })?;
    check_hresult("history refresh", unsafe { (panel.refresh)() })?;
    check_hresult("tag refresh", unsafe { (panel.refresh_tags)() })
}

pub(crate) fn current_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let (info, _, _) = layout::panel_geometry()?;
    let rect = info.rcMonitor;
    app.monitor_from_point(
        f64::from(rect.left + (rect.right - rect.left) / 2),
        f64::from(rect.top + (rect.bottom - rect.top) / 2),
    )
    .ok()
    .flatten()
}

fn toggle_on_ui_thread() -> Result<(), String> {
    let panel = api()?;
    apply_behavior()?;
    apply_theme()?;
    // SAFETY: the DLL marshals this call to its dedicated UI thread.
    if !crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
        crate::windows_paste_focus::capture_foreground();
        crate::record_foreground_app_before_clipboard();
        PENDING_CAPTURE_SYNC.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(app) = APP.get() {
            layout::before_show(app)?;
        }
    }
    check_hresult("toggle", unsafe { (panel.toggle)() })?;
    if !should_refresh_after_toggle(
        crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst),
    ) {
        PENDING_CAPTURE_SYNC.store(false, std::sync::atomic::Ordering::SeqCst);
        return Ok(());
    }
    check_hresult("history refresh", unsafe { (panel.refresh)() })?;
    check_hresult("tag refresh", unsafe { (panel.refresh_tags)() })
}

fn hide_on_ui_thread() -> Result<(), String> {
    let panel = api()?;
    // SAFETY: the DLL marshals the hide operation to its dedicated UI thread.
    check_hresult("hide", unsafe { (panel.hide)() })
}

fn apply_behavior() -> Result<(), String> {
    let bytes = serde_json::to_vec(&behavior::from_config(&crate::config::get()))
        .map_err(|error| error.to_string())?;
    let panel = api()?;
    // SAFETY: synchronous send; the native handler consumes this buffer before
    // returning, so showing cannot overtake a queued preferences update.
    check_hresult("input preferences", unsafe {
        (panel.set_behavior)(bytes.as_ptr(), bytes.len())
    })
}

fn apply_theme() -> Result<(), String> {
    let config = crate::config::get();
    let (_, theme) = app_actions::appearance(config.multilingual, config.theme_mode);
    let theme = match theme.as_str() {
        "light" => 1,
        "dark" => 2,
        _ => 0,
    };
    let panel = api()?;
    // SAFETY: the DLL synchronously applies the theme on the WinUI UI thread.
    check_hresult("theme update", unsafe { (panel.set_theme)(theme) })
}

fn apply_language() -> Result<(), String> {
    let config = crate::config::get();
    let (language, _) = app_actions::appearance(config.multilingual, config.theme_mode);
    let english = language.to_ascii_lowercase().starts_with("en");
    let panel = api()?;
    // SAFETY: the DLL synchronously applies the language on the WinUI UI thread.
    check_hresult("language update", unsafe { (panel.set_language)(english) })
}

fn apply_click_mode() -> Result<(), String> {
    let single_click_paste =
        crate::config::get().mouse_paste_mode == crate::config::MousePasteMode::Single;
    let panel = api()?;
    // SAFETY: the DLL synchronously applies the click mode on the WinUI UI thread.
    check_hresult("click-mode update", unsafe {
        (panel.set_click_mode)(single_click_paste)
    })
}

fn send_response(id: u64, op: &str, result: Result<serde_json::Value, String>) {
    let Some(bytes) = response_bytes(id, op, result) else {
        return;
    };
    if let Ok(panel) = api() {
        // SAFETY: the native export copies these bytes before it returns.
        unsafe { (panel.receive)(bytes.as_ptr(), bytes.len()) };
    }
}

unsafe extern "C" fn panel_request(input: *const u8, length: usize) {
    if input.is_null() || length == 0 || length > bridge::MAX_DOCUMENT_BYTES {
        return;
    }
    // SAFETY: the C++ caller keeps the JSON buffer alive for this callback.
    let Ok((request, payload)) =
        bridge::request(unsafe { std::slice::from_raw_parts(input, length) })
    else {
        return;
    };
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let id = request.id;
    let op = request.op.clone();
    let query_generation = match op.as_str() {
        "query" => next_query_generation(),
        "queryMore" => current_query_generation(),
        _ => 0,
    };
    if op == "query" {
        let resources = app.state::<crate::background_resources::BackgroundResources>();
        resources.reset_links_for_view(resources.epoch());
    }
    if op == "panelBlur" {
        focus::lost(app);
        return;
    }
    if reader::handle(&app, &op, &request.argument) {
        return;
    }
    if editor::focus_changed(&op, &request.argument) {
        return;
    }
    if onboarding::handle(&app, id, &op, &payload) {
        return;
    }
    if matches!(op.as_str(), "dragBegin" | "dragEnd") {
        DRAG_ACTIVE.store(op == "dragBegin", std::sync::atomic::Ordering::Release);
        log::info!("[winui-drag] stage={op}");
        if op == "dragEnd" {
            focus::lost(app);
        }
        return;
    }
    if matches!(op.as_str(), "modalBegin" | "modalEnd") {
        MODAL_ACTIVE.store(op == "modalBegin", std::sync::atomic::Ordering::Release);
        if op == "modalEnd" {
            focus::lost(app);
        }
        return;
    }
    if op == "dismiss" && preview::open() {
        preview::close(&app);
        send_response(id, &op, Ok(json!({})));
        return;
    }
    if op == "hoverDismiss" {
        preview::cancel_hover(&app);
        return;
    }
    // Reserve on the native callback, before spawning: a slow old worker must
    // never supersede a newer selection or reopen a preview closed with Space.
    let preview_mode = if op == "hoverPreview" {
        crate::PreviewMode::Hover
    } else if op == "previewToggle" {
        crate::PreviewMode::Manual
    } else {
        crate::PreviewMode::Selection
    };
    if op == "previewDismiss" && crate::preview_protected_from_replacement() {
        return;
    }
    if matches!(op.as_str(), "previewClose" | "previewDismiss")
        || (op == "previewToggle" && preview::open())
    {
        preview::close(&app);
        send_response(id, &op, Ok(serde_json::Value::Null));
        return;
    }
    let preview_request = if op == "imageText" {
        Some(preview::reserve(request.id, crate::PreviewMode::Manual))
    } else if matches!(
        op.as_str(),
        "previewToggle" | "previewSelect" | "hoverPreview"
    ) {
        if op == "hoverPreview"
            && (!crate::config::get().hover_preview_enabled || dragging() || modal_active())
        {
            return;
        }
        if !preview_mode.allows(
            preview::open(),
            crate::PREVIEW_HOVER.load(std::sync::atomic::Ordering::SeqCst),
            crate::preview_protected_from_replacement(),
        ) {
            return;
        }
        Some(preview::reserve(request.id, preview_mode))
    } else {
        None
    };
    tauri::async_runtime::spawn(async move {
        let result = match request.op.as_str() {
            "nativeTrayAction" => tray::dispatch(app.clone(), &request.argument, &payload).await,
            "appState" => app_actions::snapshot(app.clone()),
            "appTool" => app_actions::open_tool(app.clone(), &request.argument).await,
            "updateInstall" => app_actions::install(app.clone(), &request.argument).await,
            "tabOrderLoad" => tab_order::load(),
            "tabOrderSave" => tab_order::reorder(app.clone(), payload),
            "layout" => {
                let owned = app.clone();
                crate::auxiliary_windows::on_main_thread(app.clone(), move || {
                    layout::refresh(&owned)
                })
                .await
                .map(|_| json!({}))
            }
            "settings" => crate::open_config_window_from_source(app.clone(), None, None)
                .await
                .map(|_| json!({})),
            "dismiss" => hide_on_ui_thread().map(|_| json!({})),
            "previewToggle" | "previewSelect" | "hoverPreview" => {
                preview::show(
                    app.clone(),
                    request.hash,
                    preview_mode,
                    request.navigation_direction,
                    preview_request.expect("preview request reserved before spawning"),
                )
                .await
            }
            "queueOpen" => crate::set_paste_queue_active_impl(&app, true)
                .await
                .map(|_| json!({})),
            "queueClose" => crate::set_paste_queue_active_impl(&app, false)
                .await
                .map(|_| json!({})),
            "queueAdd" => {
                async {
                    if !crate::paste_queue::is_active() {
                        crate::set_paste_queue_active_impl(&app, true).await?;
                    }
                    crate::winui_queue::dispatch(app.clone(), op.clone(), payload).await
                }
                .await
            }
            queue_operation if queue_operation.starts_with("queue") => {
                crate::winui_queue::dispatch(app.clone(), op.clone(), payload).await
            }
            "tagsList" | "tagsCreate" | "tagsRename" | "tagsDelete" => {
                crate::winui_tags::dispatch(app.clone(), op.clone(), payload).await
            }
            "recordTagCreate" | "recordTagRename" | "recordTagDelete" => {
                crate::winui_tags::dispatch_editor(app.clone(), op.clone(), payload).await
            }
            "query" => {
                query_history(
                    request.query,
                    request.filter,
                    request.tag_name,
                    0,
                    0,
                    request.limit,
                    query_generation,
                )
                .await
            }
            "queryMore" => {
                query_history(
                    request.query,
                    request.filter,
                    request.tag_name,
                    request.last_id,
                    request.last_time,
                    36,
                    query_generation,
                )
                .await
            }
            "tags" => query_tags().await,
            "filtersList" | "filtersSave" | "filtersDelete" | "filterSources" => {
                filters::dispatch(op.clone(), payload).await
            }
            "copy" | "copyPlain" => {
                run_history_action(app.clone(), request.hash, false, op == "copyPlain", None).await
            }
            "paste" | "pastePlain" => {
                run_history_action(app.clone(), request.hash, true, op == "pastePlain", None).await
            }
            "quickPaste" => {
                if request.argument.len() == 1
                    && matches!(request.argument.as_bytes()[0], b'1'..=b'9')
                {
                    run_history_action(
                        app.clone(),
                        request.hash,
                        true,
                        false,
                        Some(request.argument),
                    )
                    .await
                } else {
                    Err("Invalid quick-input key / 无效的快速粘贴按键".into())
                }
            }
            "imageText" => ocr::open(app.clone(), request.hash, preview_request.unwrap()).await,
            "nativeOcrCopy" => ocr::copy(app.clone(), payload).await,
            "openFolder" | "copyFolder" | "copyColor" | "clearTags" | "exportPrepare"
            | "exportImage" => {
                actions::dispatch(app.clone(), op.clone(), request.hash, request.argument).await
            }
            "favorite" => update_favorite(app.clone(), request.hash, request.favorite).await,
            "delete" => delete_history_item(app.clone(), request.hash).await,
            "edit" => editor::open(app.clone(), request.hash).await,
            "nativeEditorSave" => editor::save(app.clone(), payload).await,
            "nativeEditorClose" => editor::close(&request.argument).await,
            "assignTag" | "recordTagAssign" => {
                update_item_tag(request.hash, request.tag_id, true).await
            }
            "removeTag" => update_item_tag(request.hash, request.tag_id, false).await,
            "card" => {
                query_card(
                    app.clone(),
                    request.hash,
                    request.argument == "refresh",
                    request.card_scale,
                )
                .await
            }
            "dragPrepare" => drag::prepare(request.hash).await,
            _ => Err("Unknown WinUI panel request".to_string()),
        };
        if (result.is_ok() && matches!(op.as_str(), "assignTag" | "recordTagAssign" | "removeTag"))
            || op == "clearTags"
        {
            let _ = app.emit("item-tags-changed", json!({}));
        }
        if result.is_err() && should_reopen_panel_after_action_error(&op) {
            let _ = show_on_ui_thread();
        }
        if op == "dragPrepare" {
            match &result {
                Ok(data) => log::info!(
                    "[winui-drag] stage=data-ready files={} text_bytes={} html_bytes={}",
                    data["files"].as_array().map_or(0, Vec::len),
                    data["text"].as_str().map_or(0, str::len),
                    data["html"].as_str().map_or(0, str::len)
                ),
                Err(_) => log::warn!("[winui-drag] stage=prepare-failed"),
            }
        }
        let query_current = !matches!(op.as_str(), "query" | "queryMore")
            || is_query_generation_current(query_generation);
        if preview_request.is_none_or(preview::current) && query_current {
            send_response(id, &op, result);
        }
    });
}

fn history_summary(item: crate::history_views::HistoryRef) -> serde_json::Value {
    json!({
        "id": item.id,
        "hash": item.hash,
        "itemType": item.item_type.to_string(),
        "previewText": item.preview_text,
        "appSource": item.app_source,
        "time": item.time,
        "favorite": item.label & 1 != 0,
        "tags": item.tags,
        "isRichText": item.is_rich_text,
        "linkResource": item.link_resource,
        "hasOcrText": item.has_ocr_text,
    })
}

async fn query_history(
    query: String,
    filter: String,
    tag_name: String,
    last_id: u64,
    last_time: u64,
    limit: usize,
    query_generation: u64,
) -> Result<serde_json::Value, String> {
    let sync_pending_capture = last_id == 0
        && PENDING_CAPTURE_SYNC.swap(false, std::sync::atomic::Ordering::SeqCst)
        && !crate::local_acceptance_no_capture();
    let limit = query_page_size(limit)?;
    let (page, highlight_terms) = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(all(target_os = "windows", not(test)))]
        if sync_pending_capture && !crate::memory_profile_active() {
            // 与 React ShowGate 对齐：首次呼出若正在异步捕获剪贴板/富文本延迟渲染，先等落库再返回首屏。
            let _ = crate::clipboard::windows::listen::wait_for_capture();
        }
        #[cfg(not(all(target_os = "windows", not(test))))]
        let _ = sync_pending_capture;
        let label = if let Some(id) = filter.strip_prefix("custom:") {
            filters::history_label(id, &tag_name)?
        } else {
            history_filter_label(&filter, &tag_name)
        };
        let (keywords, label) = search::resolve(&query, label);
        let page = crate::clipboard::history_ref_page_for_winui(
            &keywords,
            last_id,
            last_time,
            limit,
            &label,
            move || is_query_generation_current(query_generation),
        )?;
        Ok::<_, String>((page, search::highlight_terms(&keywords)))
    })
    .await
    .map_err(|error| error.to_string())??;
    let page = page.ok_or_else(|| "Clipboard history query was cancelled".to_string())?;
    Ok(pack_history_query_page(
        page.list,
        page.has_more,
        page.next_id,
        page.next_time,
        highlight_terms,
        MAX_QUERY_PAYLOAD_BYTES,
    ))
}

const MAX_QUERY_PAYLOAD_BYTES: usize = 3 * 1024 * 1024 + 512 * 1024;

fn pack_history_query_page(
    list: Vec<crate::history_views::HistoryRef>,
    has_more: bool,
    next_id: u64,
    next_time: u64,
    highlight_terms: Vec<String>,
    max_payload_bytes: usize,
) -> serde_json::Value {
    let overhead = 512
        + serde_json::to_vec(&highlight_terms)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
    let mut used = overhead;
    let mut items = Vec::with_capacity(list.len());
    let mut effective_has_more = has_more;
    let mut effective_next_id = next_id;
    let mut effective_next_time = next_time;
    let mut last_cursor: Option<(u64, u64)> = None;

    for item in list {
        let item_id = item.id as u64;
        let item_time = item.time;
        let mut summary = history_summary(item);
        let mut item_bytes = serde_json::to_vec(&summary)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        // 首条记录若极端超限则先裁剪文本字段，确保永远不会因单条过大让整页查询触发 "Native result is too large"。
        if items.is_empty() && used.saturating_add(item_bytes) > max_payload_bytes {
            let allow_text = max_payload_bytes.saturating_sub(used + 512).min(4096);
            if let Some(obj) = summary.as_object_mut() {
                for key in ["preview", "displayText", "linkResource", "appSource"] {
                    if let Some(serde_json::Value::String(text)) = obj.get_mut(key) {
                        if text.len() > allow_text {
                            let mut end = allow_text;
                            while end > 0 && !text.is_char_boundary(end) {
                                end -= 1;
                            }
                            text.truncate(end);
                        }
                    }
                }
            }
            item_bytes = serde_json::to_vec(&summary)
                .map(|bytes| bytes.len())
                .unwrap_or(0);
        }
        if !items.is_empty() && used.saturating_add(item_bytes + 1) > max_payload_bytes {
            effective_has_more = true;
            if let Some((cursor_id, cursor_time)) = last_cursor {
                effective_next_id = cursor_id;
                effective_next_time = cursor_time;
            }
            break;
        }
        used = used.saturating_add(item_bytes + 1);
        items.push(summary);
        last_cursor = Some((item_id, item_time));
    }

    let count = items.len();
    json!({
        "items": items,
        "knownCount": count,
        "hasMore": effective_has_more,
        "nextId": effective_next_id,
        "nextTime": effective_next_time,
        "highlightTerms": highlight_terms,
    })
}

fn query_page_size(requested: usize) -> Result<usize, String> {
    if requested > 10_000 {
        return Err("History window is too large; reopen without position retention / 已加载范围过大，请关闭位置保留后重新打开".into());
    }
    Ok(requested.max(36))
}

async fn query_tags() -> Result<serde_json::Value, String> {
    let tags = tauri::async_runtime::spawn_blocking(crate::clipboard::list_tags)
        .await
        .map_err(|error| error.to_string())??;
    Ok(json!({ "items": tags }))
}

fn history_filter_label(filter: &str, tag_name: &str) -> String {
    if !tag_name.is_empty() {
        let mut values = serde_json::Map::new();
        values.insert("mode".to_string(), json!("all"));
        values.insert("tag_name".to_string(), json!(tag_name));
        match filter {
            "favorite" => {
                values.insert("favorite".to_string(), json!(true));
            }
            "Text" | "Image" | "Link" | "Color" | "File" => {
                values.insert("item_type".to_string(), json!(filter));
            }
            _ => {}
        }
        return format!("__filter:{}", serde_json::Value::Object(values));
    }

    match filter {
        "favorite" => "__favorite".to_string(),
        "Text" | "Image" | "Link" | "Color" | "File" => {
            format!(r#"__filter:{{"mode":"all","item_type":"{filter}"}}"#)
        }
        _ => "__all".to_string(),
    }
}

async fn update_favorite(
    _app: AppHandle,
    hash: String,
    favorite: bool,
) -> Result<serde_json::Value, String> {
    let affected = tauri::async_runtime::spawn_blocking(move || {
        crate::clipboard::set_favorite(&hash, favorite).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    if affected == 0 {
        return Err("Clipboard item was not found".to_string());
    }
    Ok(json!({ "favorite": favorite }))
}

async fn update_item_tag(
    hash: String,
    tag_id: i64,
    assign: bool,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if assign {
            crate::clipboard::assign_tag(&hash, tag_id)?;
        } else {
            crate::clipboard::remove_tag(&hash, tag_id)?;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({ "tagId": tag_id, "assigned": assign }))
}

async fn delete_history_item(app: AppHandle, hash: String) -> Result<serde_json::Value, String> {
    let delete_hash = hash.clone();
    let affected = tauri::async_runtime::spawn_blocking(move || {
        crate::clipboard::delete_by_hash(&delete_hash).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    if affected == 0 {
        return Err("Clipboard item was not found".to_string());
    }
    crate::paste_queue::emit_state(&app);
    Ok(json!({ "deleted": true, "hash": hash }))
}

async fn query_card(
    app: AppHandle,
    hash: String,
    refresh: bool,
    scale: f64,
) -> Result<serde_json::Value, String> {
    let resources = app
        .state::<crate::background_resources::BackgroundResources>()
        .inner()
        .clone();
    let resource_epoch = resources.epoch();
    let summary_hash = hash.clone();
    let (mut card, media_path, original_image) = tauri::async_runtime::spawn_blocking(move || {
        let payload = crate::clipboard::history_card_payload(&summary_hash, false)?;
        let is_rich_text = presentation::is_rich_format(&payload);
        let item = payload.item;
        // Match the shipping reader: schedule only requested/visible cards,
        // reuse its link preference, cache, cancellation and visibility epoch.
        resources.submit_refs(app, &[&item], resource_epoch, false);
        let actions = actions::metadata(&item);
        let tags = item.tags.clone();
        let title_color = item.title_color.clone();
        let mut media_path = None;
        let mut display_title = String::new();
        let mut original_image = None;
        let mut display_subtitle = String::new();
        let mut file_count = 0;
        let mut file_format = String::new();
        let mut file_kind = String::new();
        let mut file_presentation = serde_json::Value::Null;
        let mut image_kind = String::new();
        let display_text = match item.item_type {
            crate::clipboard::item::ItemType::Image => {
                media_path = Some(item.preview_content.clone());
                original_image = Some(item.content.clone());
                item.text_content.clone()
            }
            crate::clipboard::item::ItemType::File => {
                let info = crate::build_file_preview_info(item.content.clone()).ok();
                if let Some(info) = info {
                    file_presentation = file_icons::presentation(
                        &info,
                        crate::config::get()
                            .multilingual
                            .to_ascii_lowercase()
                            .starts_with("en"),
                    );
                    file_count = info.paths.len();
                    file_format = info.extension.to_uppercase();
                    file_kind = info.kind.clone();
                    display_subtitle = if file_count > 1 {
                        info.paths
                            .iter()
                            .filter_map(|path| std::path::Path::new(path).file_name())
                            .map(|name| name.to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else {
                        info.display_path.clone()
                    };
                    if file_count == 1 {
                        display_title = std::path::Path::new(&info.display_path)
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default();
                    }
                    if info.kind == "single-preview" && !info.preview_path.is_empty() {
                        media_path = Some(info.preview_path.clone());
                    }
                    info.paths
                        .iter()
                        .filter_map(|path| std::path::Path::new(path).file_name())
                        .map(|name| name.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    item.content.clone()
                }
            }
            crate::clipboard::item::ItemType::Link => {
                let parts = item.content.split("|||").collect::<Vec<_>>();
                if let Some(path) = parts
                    .get(1)
                    .filter(|path| std::path::Path::new(**path).is_absolute())
                {
                    media_path = Some(path.to_string());
                }
                let title = parts.get(2).filter(|title| !title.is_empty()).copied();
                display_subtitle = parts.first().copied().unwrap_or("").to_string();
                display_title = title.map(str::to_string).unwrap_or_else(|| {
                    reqwest::Url::parse(&display_subtitle)
                        .ok()
                        .and_then(|url| {
                            url.host_str().map(|host| match url.port() {
                                Some(port) => format!("{host}:{port}"),
                                None => host.to_string(),
                            })
                        })
                        .unwrap_or_else(|| display_subtitle.clone())
                });
                image_kind = parts.get(3).copied().unwrap_or("").to_string();
                format!(
                    "{}\n{}",
                    title.unwrap_or_else(|| parts.first().copied().unwrap_or("")),
                    parts.first().copied().unwrap_or("")
                )
            }
            crate::clipboard::item::ItemType::TextFile => {
                crate::clipboard::plain_text_preview(&item.hash)
                    .map(|preview| preview.text)
                    .unwrap_or_default()
            }
            _ => bounded_card_display_text(&item.item_type, &item.content, &item.text_content),
        };
        let is_gif = presentation::is_gif_format(
            &item.item_type.to_string(),
            &item.content,
            &item.preview_content,
        );
        let source_icon = item.app_icon_path;
        let swatch_color = (item.item_type == crate::clipboard::item::ItemType::Color)
            .then(|| native_color(&display_text))
            .flatten();
        Ok::<_, String>((
            json!({
                "hash": summary_hash,
                "itemType": item.item_type.to_string(),
                "displayText": display_text,
                "visualType": presentation::visual_type(&item.item_type.to_string(), &item.content),
                "displayTitle": display_title,
                "displaySubtitle": display_subtitle,
                "fileCount": file_count,
                "fileFormat": file_format,
                "fileKind": file_kind,
                "filePresentation": file_presentation,
                "imageKind": image_kind,
                "tags": tags,
                "titleColor": title_color,
                "headerColor": native_color(&title_color),
                "appIconPath": source_icon,
                "swatchColor": swatch_color,
                "actions": actions,
                "isRichText": is_rich_text,
                "isGif": is_gif,
                "rich": if item.item_type == crate::clipboard::item::ItemType::Text {
                    presentation::rich_content(payload.rich_render.as_ref())
                } else { serde_json::Value::Null },
            }),
            media_path,
            original_image,
        ))
    })
    .await
    .map_err(|error| error.to_string())??;

    let width =
        crate::media_resources::card_width_for_scale_factor(if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        });
    card["cardPixelWidth"] = json!(width);
    card["assetPath"] = json!("");
    card["dimensions"] = json!("");
    if let Some(path) = media_path {
        let resource = if let Some(original) = original_image {
            presentation::resolve_image_card(path, original, refresh, width).await
        } else {
            crate::media_resources::resolve_for_card_width(
                path.clone(),
                crate::media_resources::MediaIntent::Card,
                refresh,
                width,
            )
            .await
            .map(|media| (media, path))
        };
        match resource {
            Ok((media, path)) => {
                card["assetPath"] = json!(media.asset_path);
                if media.metadata.width > 0 && media.metadata.height > 0 {
                    card["dimensions"] = json!(format!(
                        "{} × {}",
                        media.metadata.width, media.metadata.height
                    ));
                }
                card["media"] = presentation::media_details(&media.metadata, &path);
            }
            Err(error) => card["mediaError"] = json!(error),
        }
    }
    Ok(card)
}

fn native_color(input: &str) -> Option<serde_json::Value> {
    crate::clipboard::color::parse_color(input).map(|color| {
        json!({ "r": color.r, "g": color.g, "b": color.b,
            "a": (color.a * 255.0).round() as u8 })
    })
}

struct ClipboardActionGuard;

impl ClipboardActionGuard {
    fn acquire() -> Result<Self, String> {
        if ACTION_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::AcqRel) {
            Err("Another clipboard action is already running".to_string())
        } else {
            Ok(Self)
        }
    }
}

impl Drop for ClipboardActionGuard {
    fn drop(&mut self) {
        ACTION_IN_FLIGHT.store(false, std::sync::atomic::Ordering::Release);
    }
}

async fn run_history_action(
    app: AppHandle,
    hash: String,
    paste: bool,
    plain_text: bool,
    quick_trigger: Option<String>,
) -> Result<serde_json::Value, String> {
    let _action = ClipboardActionGuard::acquire()?;
    let info = crate::history_item_action_info(hash.clone()).await?;
    if plain_text && !["Text", "TextFile", "Link"].contains(&info.item_type.as_str()) {
        return Err("This record is not text / 此记录不能作为纯文本操作".into());
    }
    if let Some(path) = info.missing_paths.first() {
        return Err(format!("Source file is missing: {path}"));
    }
    crate::copy_history_record(app.clone(), hash.clone(), plain_text).await?;
    if paste {
        match winui_paste_permission_flow(crate::check_paste_accessibility_permission().granted) {
            WinUiPastePermissionFlow::FallbackCopyWithNotice => {
                hide_for_queue_paste()?;
                crate::restore_foreground_app_before_paste();
                let notice_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::show_paste_fallback_notice(notice_app).await;
                });
                Ok(json!({ "message": "Copied" }))
            }
            WinUiPastePermissionFlow::AutoPaste => {
                // 粘贴隐藏必须立即退出屏幕并释放 WS_EX_TOPMOST，避免与 120ms 后的 Ctrl+V 发生动画竞争。
                hide_for_queue_paste()?;
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::paste(&hash, quick_trigger.as_ref().map(|_| true), quick_trigger)
                })
                .await
                .map_err(|error| error.to_string())?;
                if let Err(error) = result {
                    let notice_app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::show_paste_fallback_notice(notice_app).await;
                    });
                    return Err(error);
                }
                Ok(json!({ "message": "Pasted" }))
            }
        }
    } else {
        Ok(json!({ "message": "Copied" }))
    }
}

fn refresh() {
    if let Ok(panel) = api() {
        // SAFETY: this export only posts a refresh message to the native UI thread.
        let result = unsafe { (panel.refresh)() };
        if result < 0 {
            log::debug!(
                "WinUI history refresh was deferred (HRESULT 0x{:08X})",
                result as u32
            );
        }
    }
}

fn refresh_tags() {
    if let Ok(panel) = api() {
        // SAFETY: this export only posts a tag-list refresh message to the native UI thread.
        let result = unsafe { (panel.refresh_tags)() };
        if result < 0 {
            log::debug!(
                "WinUI tag refresh was deferred (HRESULT 0x{:08X})",
                result as u32
            );
        }
    }
}

fn should_reopen_panel_after_action_error(_op: &str) -> bool {
    false
}

fn should_refresh_after_toggle(visible_after_toggle: bool) -> bool {
    visible_after_toggle
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WinUiPastePermissionFlow {
    AutoPaste,
    FallbackCopyWithNotice,
}

fn winui_paste_permission_flow(has_permission: bool) -> WinUiPastePermissionFlow {
    if has_permission {
        WinUiPastePermissionFlow::AutoPaste
    } else {
        WinUiPastePermissionFlow::FallbackCopyWithNotice
    }
}

fn bounded_card_display_text(
    item_type: &crate::clipboard::item::ItemType,
    content: &str,
    text_content: &str,
) -> String {
    let raw = if text_content.is_empty() {
        content
    } else {
        text_content
    };
    if *item_type == crate::clipboard::item::ItemType::Text
        && raw.len() > crate::clipboard_budget::TEXT_PREVIEW_BYTES
    {
        crate::clipboard_budget::text_preview(raw.as_bytes().to_vec())
            .map(|preview| preview.text)
            .unwrap_or_else(|_| crate::clipboard_budget::limit_error())
    } else {
        raw.to_string()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn history_summary_keeps_record_identity_when_editing_changes_its_hash() {
        let summary = |hash: &str| {
            super::history_summary(crate::history_views::HistoryRef {
                id: 42,
                hash: hash.into(),
                item_type: crate::clipboard::item::ItemType::Text,
                time: 123,
                label: 1,
                tags: vec![crate::clipboard::item::ItemTag {
                    id: 7,
                    name: "Work".into(),
                }],
                app_source: "Notepad".into(),
                app_icon_path: String::new(),
                source_metadata: Default::default(),
                title_color: String::new(),
                preview_text: "Full preview".into(),
                is_rich_text: false,
                link_resource: String::new(),
                has_ocr_text: false,
            })
        };
        let before = summary("old-hash");
        let after = summary("new-hash");
        assert_eq!(before["id"], 42);
        assert_eq!(before["id"], after["id"]);
        assert_ne!(before["hash"], after["hash"]);
        assert_eq!(after["previewText"], "Full preview");
        assert_eq!(after["tags"][0]["id"], 7);
        assert_eq!(after["favorite"], true);
    }

    #[test]
    fn oversized_results_return_a_small_error_with_the_same_request_identity() {
        let data = serde_json::json!({"preview":"x".repeat(4 * 1024 * 1024)});
        let bytes = super::response_bytes(123, "query", Ok(data)).unwrap();
        assert!(bytes.len() < 4 * 1024 * 1024);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["id"], 123);
        assert_eq!(value["op"], "query");
        assert!(value["error"].is_string());
        assert!(value.get("data").is_none());
        let small =
            super::response_bytes(124, "query", Ok(serde_json::json!({"text":"中文😀"}))).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&small).unwrap();
        assert_eq!(value["data"]["text"], "中文😀");
    }

    #[test]
    fn history_refresh_keeps_loaded_pages_with_a_bounded_request() {
        assert_eq!(super::query_page_size(0).unwrap(), 36);
        assert_eq!(super::query_page_size(72).unwrap(), 72);
        assert_eq!(super::query_page_size(10_000).unwrap(), 10_000);
        assert!(super::query_page_size(usize::MAX).is_err());
    }
    #[test]
    fn clipboard_action_guard_rejects_duplicates_and_releases_on_drop() {
        let first = super::ClipboardActionGuard::acquire().unwrap();
        assert!(super::ClipboardActionGuard::acquire().is_err());
        drop(first);
        assert!(super::ClipboardActionGuard::acquire().is_ok());
    }

    #[test]
    fn native_colors_reuse_the_existing_css_color_parser() {
        for value in ["#0B86FF", "rgb(11, 134, 255)"] {
            assert_eq!(
                super::native_color(value),
                Some(serde_json::json!({"r":11,"g":134,"b":255,"a":255}))
            );
        }
        assert_eq!(
            super::native_color("rgba(11, 134, 255, 0.5)").unwrap()["a"],
            128
        );
        assert!(super::native_color("hsl(0, 100%, 50%)").is_some());
        assert!(super::native_color("invalid").is_none());
    }

    #[test]
    fn native_filter_tabs_map_to_the_existing_history_filters() {
        for (selected, expected) in [
            ("all", "__all"),
            ("favorite", "__favorite"),
            ("Text", r#"__filter:{"mode":"all","item_type":"Text"}"#),
            ("Image", r#"__filter:{"mode":"all","item_type":"Image"}"#),
            ("Link", r#"__filter:{"mode":"all","item_type":"Link"}"#),
            ("Color", r#"__filter:{"mode":"all","item_type":"Color"}"#),
            ("File", r#"__filter:{"mode":"all","item_type":"File"}"#),
        ] {
            assert_eq!(super::history_filter_label(selected, ""), expected);
        }
        assert_eq!(super::history_filter_label("unexpected", ""), "__all");
    }

    #[test]
    fn tag_filter_composes_with_favorites_and_content_types() {
        for (filter, expected) in [
            ("all", serde_json::json!({"mode":"all", "tag_name":"Work"})),
            (
                "favorite",
                serde_json::json!({"mode":"all", "favorite":true, "tag_name":"Work"}),
            ),
            (
                "Image",
                serde_json::json!({"mode":"all", "item_type":"Image", "tag_name":"Work"}),
            ),
        ] {
            let label = super::history_filter_label(filter, "Work");
            let payload = label.strip_prefix("__filter:").expect("filter prefix");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(payload).unwrap(),
                expected
            );
        }
    }

    #[test]
    #[ignore = "requires the Windows App SDK runtime and an interactive desktop"]
    fn native_shell_parity() {
        let result = (|| {
            super::initialize_native(false, true)?;
            let panel = super::api()?;
            let preferences = serde_json::to_vec(&super::behavior::from_config(
                &crate::config::Config::default(),
            ))
            .unwrap();
            super::check_hresult("test preferences", unsafe {
                (panel.set_behavior)(preferences.as_ptr(), preferences.len())
            })?;
            // SAFETY: the native exports marshal show and synthetic control
            // assertions to the owning STA. No AppHandle or user data is used.
            if std::env::var_os("VPASTE_WINUI_TRAY_CHECK").is_none() {
                super::check_hresult("show", unsafe { (panel.show)() })?;
            }
            let test = unsafe {
                super::GetProcAddress(
                    panel._module.as_ptr(),
                    b"vpaste_winui_test_shell_parity\0".as_ptr().cast(),
                )
            };
            if test.is_null() {
                return Err("WinUI shell regression export is missing".to_string());
            }
            // SAFETY: Debug test ABI; stage is written before the call returns.
            let test: unsafe extern "C" fn(*mut u32) -> i32 = unsafe { std::mem::transmute(test) };
            let mut stage = 0;
            let result = unsafe { test(&mut stage) };
            eprintln!(
                "WinUI shell parity: stage={stage}, HRESULT=0x{:08X}",
                result as u32
            );
            super::check_hresult(&format!("shell parity stage {stage}"), result)
        })();
        super::shutdown();
        assert!(result.is_ok(), "native shell failed: {result:?}");
    }

    #[test]
    #[ignore = "requires the Windows App SDK runtime and an interactive desktop"]
    fn native_batch2_regressions() {
        let result = (|| -> Result<(), String> {
            super::initialize_native(false, false)?;
            let panel = super::api()?;
            // SAFETY: Debug 测试导出在同一 STA 上验证 Batch 2 所有交互/焦点/同步/渲染修复回归。
            let test = unsafe {
                super::GetProcAddress(
                    panel._module.as_ptr(),
                    b"vpaste_winui_test_batch2_regressions\0".as_ptr().cast(),
                )
            };
            if test.is_null() {
                return Err("WinUI batch2 regression export is missing".to_string());
            }
            let test: unsafe extern "C" fn(*mut u32) -> i32 = unsafe { std::mem::transmute(test) };
            let mut stage = 0;
            let status = unsafe { test(&mut stage) };
            eprintln!(
                "WinUI batch2 regressions: stage={stage}, HRESULT=0x{:08X}",
                status as u32
            );
            super::check_hresult(&format!("batch2 regressions stage {stage}"), status)
        })();
        super::shutdown();
        assert!(
            result.is_ok(),
            "native batch2 regressions failed: {result:?}"
        );
    }

    #[test]
    #[ignore = "requires the Windows App SDK runtime and an interactive desktop"]
    fn native_stage1_diagnostics_and_erase_bkgnd() {
        let temp = tempfile::tempdir().unwrap();
        let diag_path = temp
            .path()
            .join("logs")
            .join(crate::WINUI_DIAGNOSTICS_LOG_FILE);
        let result = (|| -> Result<(), String> {
            super::initialize_native_with_diagnostics(false, true, Some(&diag_path))?;
            let panel = super::api()?;
            let test = unsafe {
                super::GetProcAddress(
                    panel._module.as_ptr(),
                    b"vpaste_winui_test_stage1_diagnostics\0".as_ptr().cast(),
                )
            };
            if test.is_null() {
                return Err("WinUI stage1 diagnostics test export is missing".to_string());
            }
            let wide_path = super::wide_null(diag_path.as_os_str());
            // SAFETY: Debug 测试导出在同一 STA 上验证 WM_POWERBROADCAST、WM_ERASEBKGND、
            // 去白框画刷与脱敏诊断日志轮转，且只操作隔离临时目录。
            let test: unsafe extern "C" fn(*const u16, *mut u32) -> i32 =
                unsafe { std::mem::transmute(test) };
            let mut stage = 0;
            let status = unsafe { test(wide_path.as_ptr(), &mut stage) };
            eprintln!(
                "WinUI stage1 diagnostics probe: stage={stage}, HRESULT=0x{:08X}",
                status as u32
            );
            super::check_hresult(&format!("stage1 diagnostics probe stage {stage}"), status)?;
            let saved = std::fs::read_to_string(&diag_path)
                .map_err(|err| format!("read diagnostics log failed: {err}"))?;
            let resume_entries = saved.matches("event=power_resume_first_show").count();
            if resume_entries != 1 {
                return Err(format!(
                    "expected exactly 1 power_resume_first_show entry in diagnostics log, got {resume_entries}: {saved}"
                ));
            }
            Ok(())
        })();
        super::shutdown();
        assert!(
            result.is_ok(),
            "native stage1 diagnostics probe failed: {result:?}"
        );
    }

    #[test]
    #[ignore = "requires the Windows App SDK runtime and an interactive desktop"]
    fn native_history_queue_refresh_and_shutdown() {
        let result = super::initialize_native(false, true);
        let shown = result.as_ref().map(|_| {
            let panel = super::api()?;
            // SAFETY: the test uses the live panel export and checks its HRESULT.
            super::check_hresult("show", unsafe { (panel.show)() })?;
            super::check_hresult("single-click mode", unsafe { (panel.set_click_mode)(true) })?;
            super::check_hresult("double-click mode", unsafe {
                (panel.set_click_mode)(false)
            })?;
            // SAFETY: Debug-only test export runs synthetic rendering/selection
            // cases on the native STA. No AppHandle or user database is used.
            let test = unsafe {
                super::GetProcAddress(
                    panel._module.as_ptr(),
                    b"vpaste_winui_test_history_and_queue\0".as_ptr().cast(),
                )
            };
            if test.is_null() {
                return Err("WinUI regression test export is missing".to_string());
            }
            let fixtures = [
                ("C:/docs/report.pdf", "single-icon", false),
                ("C:/notes.txt", "single-icon", false),
                ("C:/project/package.json", "single-icon", false),
                ("C:/project/example.toml", "single-icon", false),
                ("C:/unknown.something-vpaste", "single-icon", false),
                ("C:/documents", "single-folder", false),
                ("C:/notes.txt", "multiple", true),
                ("C:/notes.txt", "multiple", false),
            ].map(|(path, kind, mixed)| {
                let info = crate::FilePreviewInfo {
                    kind: kind.into(), paths: if kind == "multiple" {
                        vec![path.into(), "C:/report.pdf".into(), "C:/README.md".into()]
                    } else { vec![path.into()] },
                    exists: true, missing_paths: vec![], display_path: path.into(),
                    secondary_text: String::new(), extension: path.rsplit('.').next().unwrap().into(),
                    preview_path: String::new(), contains_directories: mixed,
                    image_width: None, image_height: None,
                };
                super::file_icons::presentation(&info, true)
            });
            let fixtures = serde_json::to_vec(&fixtures).map_err(|error| error.to_string())?;
            // SAFETY: Debug-only ABI copies fixture bytes before returning.
            let test: unsafe extern "C" fn(*const u8, usize, *mut u32) -> i32 = unsafe { std::mem::transmute(test) };
            let mut stage = 0;
            // SAFETY: stage lives for the whole call; the DLL writes it only
            // before returning, never from its asynchronous UI callback.
            let result = unsafe { test(fixtures.as_ptr(), fixtures.len(), &mut stage) };
            eprintln!(
                "WinUI native history/queue regression: stage={stage}, HRESULT=0x{:08X}",
                result as u32
            );
            super::check_hresult(&format!("history/queue regression stage {stage}"), result)?;
            // Exercise real window key messages, not only the handler helper.
            let route = unsafe {
                super::GetProcAddress(
                    panel._module.as_ptr(),
                    b"vpaste_winui_test_preview_key_route\0".as_ptr().cast(),
                )
            };
            if route.is_null() {
                return Err("WinUI key-route test export is missing".into());
            }
            // SAFETY: same Debug test ABI as above; it targets synthetic controls only.
            let route: unsafe extern "C" fn(*mut u32) -> i32 =
                unsafe { std::mem::transmute(route) };
            let routed = unsafe { route(&mut stage) };
            eprintln!(
                "WinUI posted Space regression: stage={stage}, HRESULT=0x{:08X}",
                routed as u32
            );
            if routed == 1 {
                eprintln!("SKIPPED posted Space: Windows did not grant foreground focus to the test window; manual keyboard verification is still required.");
            } else {
                super::check_hresult(&format!("posted Space regression stage {stage}"), routed)?;
            }
            super::check_hresult("tag refresh", unsafe { (panel.refresh_tags)() })
        });
        super::shutdown();
        assert!(result.is_ok(), "native initialization failed: {result:?}");
        assert!(matches!(shown, Ok(Ok(()))), "native show failed: {shown:?}");
    }

    #[test]
    fn winui_regression_paste_action_error_and_toggle_hide_policy() {
        assert!(!super::should_reopen_panel_after_action_error("paste"));
        assert!(!super::should_reopen_panel_after_action_error("pastePlain"));
        assert!(!super::should_reopen_panel_after_action_error("quickPaste"));
        assert!(!super::should_refresh_after_toggle(false));
        assert!(super::should_refresh_after_toggle(true));
        assert_eq!(
            super::winui_paste_permission_flow(false),
            super::WinUiPastePermissionFlow::FallbackCopyWithNotice
        );
        assert_eq!(
            super::winui_paste_permission_flow(true),
            super::WinUiPastePermissionFlow::AutoPaste
        );
    }

    #[test]
    fn winui_regression_large_text_card_query_is_bounded_and_summary_tracks_resources() {
        let oversized_text = "A".repeat(5 * 1024 * 1024);
        let display_text = super::bounded_card_display_text(
            &crate::clipboard::item::ItemType::Text,
            &oversized_text,
            "",
        );
        let encoded = super::bridge::response(
            1,
            "card",
            Ok(serde_json::json!({ "displayText": display_text })),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert!(
            parsed.get("error").is_none(),
            "oversized Text card exceeded bridge budget: {}",
            parsed["error"]
        );

        let base_ref = || crate::history_views::HistoryRef {
            id: 10,
            hash: "hash-res".into(),
            item_type: crate::clipboard::item::ItemType::Link,
            time: 99,
            label: 0,
            tags: vec![],
            app_source: "Browser".into(),
            app_icon_path: String::new(),
            source_metadata: Default::default(),
            title_color: String::new(),
            preview_text: "Example".into(),
            is_rich_text: true,
            link_resource: "C:\\cache\\icon.png:favicon".into(),
            has_ocr_text: true,
        };
        let without_resource = super::history_summary(crate::history_views::HistoryRef {
            is_rich_text: false,
            link_resource: String::new(),
            has_ocr_text: false,
            ..base_ref()
        });
        let with_resource = super::history_summary(base_ref());
        assert_ne!(without_resource, with_resource);
        assert_eq!(with_resource["isRichText"], true);
        assert_eq!(with_resource["linkResource"], "C:\\cache\\icon.png:favicon");
        assert_eq!(with_resource["hasOcrText"], true);
    }

    #[test]
    fn winui_regression_query_history_respects_bridge_budget() {
        // 模拟全量刷新携带数百条含超长字段的历史摘要时，不应触发 4 MiB bridge 溢出错误，
        // 而是按预算截断并保持正确的 hasMore / nextId / nextTime 分页游标。
        let large_preview = "P".repeat(24 * 1024);
        let refs = (0..220_usize)
            .map(|idx| crate::history_views::HistoryRef {
                id: 1000 - idx,
                hash: format!("hash-{idx}"),
                item_type: crate::clipboard::item::ItemType::Text,
                time: (5000 - idx) as u64,
                label: 0,
                tags: vec![],
                app_source: "Code.exe".into(),
                app_icon_path: String::new(),
                source_metadata: Default::default(),
                title_color: String::new(),
                preview_text: large_preview.clone(),
                is_rich_text: false,
                link_resource: String::new(),
                has_ocr_text: false,
            })
            .collect::<Vec<_>>();
        let payload = super::pack_history_query_page(
            refs,
            false,
            781,
            4781,
            vec!["alpha".into()],
            super::MAX_QUERY_PAYLOAD_BYTES,
        );
        let kept_count = payload["items"].as_array().unwrap().len();
        assert!(kept_count > 0 && kept_count < 220);
        assert_eq!(payload["knownCount"], kept_count);
        assert_eq!(payload["hasMore"], true);
        assert_eq!(payload["nextId"], 1000 - (kept_count - 1));
        assert_eq!(payload["nextTime"], 5000 - (kept_count as u64 - 1));
        let encoded = super::bridge::response(77, "query", Ok(payload)).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert!(
            parsed.get("error").is_none(),
            "packed history query exceeded bridge limit: {:?}",
            parsed.get("error")
        );
    }

    #[test]
    fn winui_regression_query_generation_cancels_superseded_search() {
        let older = super::next_query_generation();
        assert_eq!(super::current_query_generation(), older);
        assert!(super::is_query_generation_current(older));

        let newer = super::next_query_generation();
        assert!(!super::is_query_generation_current(older));
        assert!(super::is_query_generation_current(newer));
    }

    #[test]
    fn winui_startup_coordinator_and_runtime_floor_match_2_6_5_0() {
        use crate::main_panel_mode::{MainUi, ModeState, Selection, WinUiStartupOutcome};

        // 验证 Windows App Runtime 下限精确锁定 2.6.5.0 (0x0002_0006_0005_0000)。
        assert_eq!(super::RUNTIME_MAJOR_MINOR, 0x0002_0006);
        assert_eq!(super::RUNTIME_MIN_VERSION, 0x0002_0006_0005_0000);
        assert_eq!(super::package_version(2, 6, 5, 0), 562_975_723_552_768);

        // 1. 显式 --main-ui=webview 绝不触碰 WinUI / Runtime 初始化。
        let mut webview_state = ModeState::from_selection(Selection {
            mode: MainUi::Webview,
            explicit: true,
        });
        let mut init_calls = 0usize;
        let outcome = webview_state
            .coordinate_winui_startup(|| {
                init_calls += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(outcome, WinUiStartupOutcome::Webview);
        assert_eq!(init_calls, 0);

        // 2. 默认 WinUI 在缺少/不兼容 Windows App Runtime 2.6.5 时安全回退 WebView。
        for simulated_error in [
            super::format_bootstrap_error(
                "WinUI runtime initialization failed (HRESULT 0x80040010)",
            ),
            "failed to load Windows App SDK bootstrap Microsoft.WindowsAppRuntime.Bootstrap.dll"
                .to_string(),
            "failed to load WinUI panel library VPasteWinUiPanel.dll".to_string(),
            "WinUI bridge version 7 is incompatible with 8; rebuild the native app".to_string(),
        ] {
            let mut state = ModeState::from_selection(Selection {
                mode: MainUi::WinUi,
                explicit: false,
            });
            let mut calls = 0usize;
            let outcome = state
                .coordinate_winui_startup(|| {
                    calls += 1;
                    Err(simulated_error.clone())
                })
                .unwrap();
            assert_eq!(calls, 1);
            assert_eq!(
                outcome,
                WinUiStartupOutcome::FallbackToWebview {
                    reason: simulated_error,
                }
            );
            assert_eq!(state.effective_mode(), MainUi::Webview);
            assert!(state.allows_main_webview());
        }

        // 3. 显式 --main-ui=winui 在 Runtime 缺失时必须返回清晰可操作的非零错误，不静默回退。
        let runtime_error = super::format_bootstrap_error(
            "WinUI runtime initialization failed (HRESULT 0x80070490)",
        );
        assert!(runtime_error.contains("Windows App Runtime 2.6.5 (x64)"));
        assert!(runtime_error.contains("--main-ui=webview"));
        let mut explicit_state = ModeState::from_selection(Selection {
            mode: MainUi::WinUi,
            explicit: true,
        });
        let explicit_error = explicit_state
            .coordinate_winui_startup(|| Err(runtime_error.clone()))
            .unwrap_err();
        assert_eq!(explicit_error, runtime_error);
        assert!(!explicit_state.allows_main_webview());

        // 4. 默认 WinUI 在 Runtime 可用时正常进入 WinUI。
        let mut ready_state = ModeState::from_selection(Selection {
            mode: MainUi::WinUi,
            explicit: false,
        });
        assert_eq!(
            ready_state.coordinate_winui_startup(|| Ok(())).unwrap(),
            WinUiStartupOutcome::WinUiReady
        );
        assert!(!ready_state.allows_main_webview());
    }
}
