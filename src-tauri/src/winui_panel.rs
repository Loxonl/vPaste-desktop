//! Windows-only WinUI 3 experiment host. The XAML bridge is loaded on demand
//! so the ordinary WebView debug build does not load Windows App SDK runtime.

use std::{
    ffi::{c_char, c_void, OsStr},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    sync::{atomic::AtomicBool, OnceLock},
};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Listener};

mod actions;
mod app_actions;
mod behavior;
mod drag;
mod filters;
mod layout;
mod presentation;
pub(crate) mod preview;
mod search;
mod tab_order;
// This projection has no AppKit dependency. Keep the macOS importer unchanged.
#[path = "native_panel/rich_text.rs"]
mod rich_text;

type PanelCall = unsafe extern "C" fn() -> i32;
type PanelWindowHandle = unsafe extern "C" fn() -> usize;
type PanelSetTheme = unsafe extern "C" fn(u32) -> i32;
type PanelSetLayout = unsafe extern "C" fn(*const layout::PanelLayout) -> i32;
type PanelSetLanguage = unsafe extern "C" fn(bool) -> i32;
type PanelShutdown = unsafe extern "C" fn();
type PanelRequest = unsafe extern "C" fn(*const u8, usize);
type PanelReceive = unsafe extern "C" fn(*const u8, usize);
type PanelSetBehavior = unsafe extern "C" fn(*const u8, usize) -> i32;
type PanelSetClickMode = unsafe extern "C" fn(bool) -> i32;
type PanelSetQueueView = unsafe extern "C" fn(bool) -> i32;
type PanelShowQueueNoActivate = unsafe extern "C" fn() -> i32;
type PanelInitialize = unsafe extern "C" fn(extern "C" fn(bool), PanelRequest, bool, bool) -> i32;
type BootstrapInitialize = unsafe extern "system" fn(u32, *const u16, u64, u32) -> i32;
type BootstrapShutdown = unsafe extern "system" fn();

struct PanelApi {
    _module: usize,
    initialize: PanelInitialize,
    show: PanelCall,
    toggle: PanelCall,
    hide: PanelCall,
    refresh: PanelCall,
    receive: PanelReceive,
    set_theme: PanelSetTheme,
    set_layout: PanelSetLayout,
    set_language: PanelSetLanguage,
    set_click_mode: PanelSetClickMode,
    set_behavior: PanelSetBehavior,
    set_queue_view: PanelSetQueueView,
    show_queue_no_activate: PanelShowQueueNoActivate,
    hide_for_queue_paste: PanelCall,
    refresh_tags: PanelCall,
    window_handle: PanelWindowHandle,
    focus_history: PanelCall,
    shutdown: PanelShutdown,
}

struct BootstrapApi {
    _module: usize,
    shutdown: BootstrapShutdown,
}

static PANEL_API: OnceLock<Result<PanelApi, String>> = OnceLock::new();
static BOOTSTRAP_API: OnceLock<Result<BootstrapApi, String>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static ACTION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static MODAL_ACTIVE: AtomicBool = AtomicBool::new(false);

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
    // beside the normal Debug executable one directory above it.
    #[cfg(test)]
    if directory.ends_with("deps") {
        return directory
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "native test has no Debug output directory".to_string());
    }
    Ok(directory)
}

fn load_bootstrap() -> Result<BootstrapApi, String> {
    let library_path = runtime_directory()?.join("Microsoft.WindowsAppRuntime.Bootstrap.dll");
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
    // SAFETY: export names are NUL-terminated ASCII strings.
    let initialize =
        unsafe { GetProcAddress(module, b"MddBootstrapInitialize2\0".as_ptr().cast()) };
    let shutdown = unsafe { GetProcAddress(module, b"MddBootstrapShutdown\0".as_ptr().cast()) };
    if initialize.is_null() || shutdown.is_null() {
        return Err("Windows App SDK bootstrap exports are missing".into());
    }
    // SAFETY: signatures match MddBootstrapInitialize2 and MddBootstrapShutdown.
    let initialize: BootstrapInitialize = unsafe { std::mem::transmute(initialize) };
    let shutdown: BootstrapShutdown = unsafe { std::mem::transmute(shutdown) };
    // The zero minimum accepts the installed compatible 2.x runtime; the
    // project is compiled against the 2.6 WinUI 3 headers.
    check_hresult("runtime initialization", unsafe {
        initialize(0x0002_0006, std::ptr::null(), 0, 0)
    })?;
    Ok(BootstrapApi {
        _module: module as usize,
        shutdown,
    })
}

fn bootstrap() -> Result<&'static BootstrapApi, String> {
    BOOTSTRAP_API
        .get_or_init(load_bootstrap)
        .as_ref()
        .map_err(Clone::clone)
}

fn load_panel_api() -> Result<PanelApi, String> {
    let library_path = runtime_directory()?.join("VPasteWinUiPanel.dll");
    let library_name = wide_null(library_path.as_os_str());

    // SAFETY: `library_name` is NUL-terminated and remains valid for the call.
    let module = unsafe { LoadLibraryW(library_name.as_ptr()) };
    if module.is_null() {
        return Err(format!(
            "failed to load WinUI panel library {} (Windows error {})",
            library_path.display(),
            std::io::Error::last_os_error()
        ));
    }

    // SAFETY: every symbol below has the matching no-argument C ABI declared
    // in WinUiPanel.cpp and the module remains loaded for the process lifetime.
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
    unsafe fn show_queue_no_activate_symbol(
        module: *mut c_void,
    ) -> Result<PanelShowQueueNoActivate, String> {
        let address = unsafe {
            GetProcAddress(
                module,
                b"vpaste_winui_show_queue_no_activate\0".as_ptr().cast(),
            )
        };
        if address.is_null() {
            return Err("WinUI no-activate queue-show export is missing".into());
        }
        // SAFETY: the exported function accepts no arguments and returns HRESULT.
        Ok(unsafe { std::mem::transmute::<*mut c_void, PanelShowQueueNoActivate>(address) })
    }

    // SAFETY: the matching C++ export snapshots an HWND as uintptr_t.
    let window_handle =
        unsafe { GetProcAddress(module, b"vpaste_winui_window_handle\0".as_ptr().cast()) };
    if window_handle.is_null() {
        return Err("WinUI window-handle export is missing".into());
    }
    // SAFETY: the export takes a borrowed repr(C) PanelLayout and returns HRESULT.
    let set_layout =
        unsafe { GetProcAddress(module, b"vpaste_winui_set_layout\0".as_ptr().cast()) };
    if set_layout.is_null() {
        return Err("WinUI docking-layout export is missing".into());
    }
    // SAFETY: the symbol name is NUL-terminated; the module stays loaded.
    let set_behavior =
        unsafe { GetProcAddress(module, b"vpaste_winui_set_behavior\0".as_ptr().cast()) };
    if set_behavior.is_null() {
        return Err("WinUI behavior export is missing".into());
    }
    Ok(PanelApi {
        _module: module as usize,
        initialize: unsafe { initialize_symbol(module)? },
        show: unsafe { symbol(module, b"vpaste_winui_show\0")? },
        toggle: unsafe { symbol(module, b"vpaste_winui_toggle\0")? },
        hide: unsafe { symbol(module, b"vpaste_winui_hide\0")? },
        refresh: unsafe { symbol(module, b"vpaste_winui_refresh\0")? },
        receive: unsafe { receive_symbol(module)? },
        set_theme: unsafe { set_theme_symbol(module)? },
        set_layout: unsafe { std::mem::transmute::<*mut c_void, PanelSetLayout>(set_layout) },
        set_language: unsafe { set_language_symbol(module)? },
        set_click_mode: unsafe { set_click_mode_symbol(module)? },
        // SAFETY: matches the synchronous byte-buffer C ABI in WinUiPanel.cpp.
        set_behavior: unsafe { std::mem::transmute::<*mut c_void, PanelSetBehavior>(set_behavior) },
        set_queue_view: unsafe { set_queue_view_symbol(module)? },
        show_queue_no_activate: unsafe { show_queue_no_activate_symbol(module)? },
        hide_for_queue_paste: unsafe { symbol(module, b"vpaste_winui_hide_for_queue_paste\0")? },
        refresh_tags: unsafe { symbol(module, b"vpaste_winui_refresh_tags\0")? },
        window_handle: unsafe {
            std::mem::transmute::<*mut c_void, PanelWindowHandle>(window_handle)
        },
        focus_history: unsafe { symbol(module, b"vpaste_winui_focus_history\0")? },
        shutdown: unsafe { shutdown_symbol(module)? },
    })
}

fn api() -> Result<&'static PanelApi, String> {
    PANEL_API
        .get_or_init(load_panel_api)
        .as_ref()
        .map_err(Clone::clone)
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
pub(crate) fn initialize(app: AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    for event in [
        "listen_new_clipboard",
        "clipboard-item-edited",
        "clipboard-resources-updated",
    ] {
        app.listen(event, move |_| refresh());
    }
    app.listen("item-tags-changed", move |_| {
        refresh_tags();
    });
    app.listen("tab-order-changed", move |event| {
        if let Ok(order) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "tabOrderChanged", Ok(order));
        }
    });
    app.listen("paste-queue-state-changed", move |event| {
        if let Ok(state) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "queueStateUpdate", Ok(state));
        }
    });
    app.listen("app-update-state-changed", move |event| {
        if let Ok(state) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "updateStateChanged", Ok(state));
        }
    });
    app.listen("clipboard-capture-rejected", move |_| {
        send_response(0, "captureRejected", Ok(json!({})));
    });
    app.listen("clipboard-behavior-config-changed", move |_| {
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
            let owned = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = layout::refresh(&owned) {
                    log::error!("Failed to update WinUI panel layout: {error}");
                }
            }) {
                log::error!("Failed to schedule WinUI panel layout: {error}");
            }
        }
    });
    app.listen("language-changed", move |_| {
        if let Err(error) = apply_language() {
            log::debug!("WinUI language update deferred: {error}");
        }
    });
    let language = crate::config::get().multilingual;
    let english = language.to_ascii_lowercase().starts_with("en");
    let single_click_paste =
        crate::config::get().mouse_paste_mode == crate::config::MousePasteMode::Single;
    initialize_native(english, single_click_paste)?;
    apply_behavior()?;
    layout::before_show(&app)
}

fn initialize_native(english: bool, single_click_paste: bool) -> Result<(), String> {
    let _ = bootstrap()?;
    let panel = api()?;
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

extern "C" fn visibility_changed(visible: bool) {
    crate::CLIPBOARD_VISIBLE.store(visible, std::sync::atomic::Ordering::SeqCst);
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

pub(crate) fn set_queue_view(active: bool) -> Result<(), String> {
    let panel = api()?;
    // SAFETY: the DLL marshals the view switch to its dedicated WinUI thread.
    check_hresult("queue-view update", unsafe {
        (panel.set_queue_view)(active)
    })
}

pub(crate) fn show_queue_no_activate() -> Result<(), String> {
    let panel = api()?;
    // SAFETY: the DLL marshals the non-activating show operation to its UI thread.
    check_hresult("non-activating queue show", unsafe {
        (panel.show_queue_no_activate)()
    })
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
    if let Some(Ok(panel)) = PANEL_API.get() {
        // SAFETY: called during Tauri shutdown; the bridge stops and joins its
        // dedicated UI thread before returning.
        unsafe { (panel.shutdown)() };
    }
    if let Some(Ok(bootstrap)) = BOOTSTRAP_API.get() {
        // SAFETY: the WinUI UI thread has been joined above.
        unsafe { (bootstrap.shutdown)() };
    }
}

fn show_on_ui_thread() -> Result<(), String> {
    let panel = api()?;
    if let Some(app) = APP.get() {
        layout::before_show(app)?;
    }
    apply_behavior()?;
    apply_theme()?;
    // SAFETY: the DLL marshals this call to its dedicated UI thread.
    check_hresult("show", unsafe { (panel.show)() })?;
    check_hresult("history refresh", unsafe { (panel.refresh)() })?;
    check_hresult("tag refresh", unsafe { (panel.refresh_tags)() })
}

pub(crate) fn current_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let panel = api().ok()?;
    // SAFETY: the export snapshots the HWND under the native state mutex.
    let window = windows::Win32::Foundation::HWND(unsafe { (panel.window_handle)() } as isize);
    let (info, _, _) = layout::physical_geometry(window)?;
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
        if let Some(app) = APP.get() {
            layout::before_show(app)?;
        }
    }
    check_hresult("toggle", unsafe { (panel.toggle)() })?;
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
    let theme = match crate::config::get().theme_mode.as_str() {
        "light" => 1,
        "dark" => 2,
        _ => 0,
    };
    let panel = api()?;
    // SAFETY: the DLL synchronously applies the theme on the WinUI UI thread.
    check_hresult("theme update", unsafe { (panel.set_theme)(theme) })
}

fn apply_language() -> Result<(), String> {
    let language = crate::config::get().multilingual;
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

fn response_bytes(id: u64, op: &str, result: Result<serde_json::Value, String>) -> Option<Vec<u8>> {
    let response = match result {
        Ok(data) => json!({ "id": id, "op": op, "data": data }),
        Err(error) => json!({ "id": id, "op": op, "error": error }),
    };
    let bytes = serde_json::to_vec(&response).ok()?;
    // Match the DLL's receive limit. Never silently drop an oversized refresh
    // and leave its request in the loading state; return a bounded error.
    if bytes.len() > 4 * 1024 * 1024 {
        return serde_json::to_vec(&json!({"id":id, "op":op,
            "error":"Native result is too large; narrow the filter and retry / 返回内容过大，请缩小筛选范围后重试"})).ok();
    }
    Some(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    op: String,
    #[serde(default)]
    query: String,
    #[serde(default)]
    filter: String,
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    tag_id: i64,
    #[serde(default)]
    last_id: u64,
    #[serde(default)]
    last_time: u64,
    #[serde(default)]
    navigation_direction: i8,
    #[serde(default)]
    argument: String,
    #[serde(default)]
    limit: usize,
    #[serde(default)]
    card_scale: f64,
}

unsafe extern "C" fn panel_request(input: *const u8, length: usize) {
    if input.is_null() || length == 0 || length > 16 * 1024 {
        return;
    }
    // SAFETY: the C++ caller keeps the JSON buffer alive for this callback.
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(unsafe {
        std::slice::from_raw_parts(input, length)
    }) else {
        return;
    };
    let Ok(request) = serde_json::from_value::<Request>(payload.clone()) else {
        return;
    };
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let id = request.id;
    let op = request.op.clone();
    if matches!(op.as_str(), "dragBegin" | "dragEnd") {
        DRAG_ACTIVE.store(op == "dragBegin", std::sync::atomic::Ordering::Release);
        log::info!("[winui-drag] stage={op}");
        return;
    }
    if matches!(op.as_str(), "modalBegin" | "modalEnd") {
        MODAL_ACTIVE.store(op == "modalBegin", std::sync::atomic::Ordering::Release);
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
    if op == "previewDismiss" && crate::PREVIEW_PINNED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if matches!(op.as_str(), "previewClose" | "previewDismiss")
        || (op == "previewToggle" && preview::open())
    {
        preview::close(&app);
        send_response(id, &op, Ok(serde_json::Value::Null));
        return;
    }
    let preview_request = if matches!(
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
            crate::PREVIEW_PINNED.load(std::sync::atomic::Ordering::SeqCst),
        ) {
            return;
        }
        Some(preview::reserve(request.id, preview_mode))
    } else {
        None
    };
    tauri::async_runtime::spawn(async move {
        let result = match request.op.as_str() {
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
            "imageText" => crate::show_image_text_window(app.clone(), request.hash)
                .await
                .map(|_| json!({})),
            "openFolder" | "copyFolder" | "copyColor" | "clearTags" | "exportPrepare"
            | "exportImage" => {
                actions::dispatch(app.clone(), op.clone(), request.hash, request.argument).await
            }
            "favorite" => update_favorite(app.clone(), request.hash, request.favorite).await,
            "delete" => delete_history_item(app.clone(), request.hash).await,
            "edit" => crate::open_text_editor_window(app.clone(), request.hash)
                .await
                .map(|_| json!({})),
            "assignTag" | "recordTagAssign" => {
                update_item_tag(request.hash, request.tag_id, true).await
            }
            "removeTag" => update_item_tag(request.hash, request.tag_id, false).await,
            "card" => {
                query_card(
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
        if result.is_ok() && op == "delete" {
            let _ = app.emit("listen_new_clipboard", ());
        }
        if result.is_err() && matches!(op.as_str(), "paste" | "pastePlain" | "quickPaste") {
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
        if preview_request.is_none_or(preview::current) {
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
    })
}

async fn query_history(
    query: String,
    filter: String,
    tag_name: String,
    last_id: u64,
    last_time: u64,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let limit = query_page_size(limit)?;
    let (page, highlight_terms) = tauri::async_runtime::spawn_blocking(move || {
        let label = if let Some(id) = filter.strip_prefix("custom:") {
            filters::history_label(id, &tag_name)?
        } else {
            history_filter_label(&filter, &tag_name)
        };
        let (keywords, label) = search::resolve(&query, label);
        let page = crate::clipboard::history_ref_page(
            &keywords,
            last_id,
            last_time,
            limit,
            &label,
            || true,
        )?;
        Ok::<_, String>((page, search::highlight_terms(&keywords)))
    })
    .await
    .map_err(|error| error.to_string())??;
    let page = page.ok_or_else(|| "Clipboard history query was cancelled".to_string())?;
    let items = page
        .list
        .into_iter()
        .map(history_summary)
        .collect::<Vec<_>>();
    let count = items.len();
    Ok(json!({
        "items": items,
        "knownCount": count,
        "hasMore": page.has_more,
        "nextId": page.next_id,
        "nextTime": page.next_time,
        "highlightTerms": highlight_terms,
    }))
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
    app: AppHandle,
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
    app.emit("listen_new_clipboard", ())
        .map_err(|error| error.to_string())?;
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

async fn query_card(hash: String, refresh: bool, scale: f64) -> Result<serde_json::Value, String> {
    let summary_hash = hash.clone();
    let (mut card, media_path) = tauri::async_runtime::spawn_blocking(move || {
        let payload = crate::clipboard::history_card_payload(&summary_hash, false)?;
        let item = payload.item;
        let actions = actions::metadata(&item);
        let tags = item.tags.clone();
        let title_color = item.title_color.clone();
        let mut media_path = None;
        let mut display_title = String::new();
        let mut display_subtitle = String::new();
        let mut file_count = 0;
        let mut file_format = String::new();
        let mut file_kind = String::new();
        let display_text = match item.item_type {
            crate::clipboard::item::ItemType::Image => {
                media_path = Some(item.preview_content.clone());
                item.text_content.clone()
            }
            crate::clipboard::item::ItemType::File => {
                let info = crate::build_file_preview_info(item.content.clone()).ok();
                if let Some(info) = info {
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
                display_title = title.unwrap_or(&display_subtitle).to_string();
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
            _ => {
                if item.text_content.is_empty() {
                    item.content.clone()
                } else {
                    item.text_content.clone()
                }
            }
        };
        let source_icon = item.app_icon_path;
        let swatch_color = (item.item_type == crate::clipboard::item::ItemType::Color)
            .then(|| native_color(&display_text))
            .flatten();
        Ok::<_, String>((
            json!({
                "hash": summary_hash,
                "itemType": item.item_type.to_string(),
                "displayText": display_text,
                "displayTitle": display_title,
                "displaySubtitle": display_subtitle,
                "fileCount": file_count,
                "fileFormat": file_format,
                "fileKind": file_kind,
                "tags": tags,
                "titleColor": title_color,
                "headerColor": native_color(&title_color),
                "appIconPath": source_icon,
                "swatchColor": swatch_color,
                "actions": actions,
                "rich": if item.item_type == crate::clipboard::item::ItemType::Text {
                    presentation::rich_content(payload.rich_render.as_ref())
                } else { serde_json::Value::Null },
            }),
            media_path,
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
    if let Some(path) = media_path.filter(|path| !path.is_empty()) {
        match crate::media_resources::resolve_for_card_width(
            path.clone(),
            crate::media_resources::MediaIntent::Card,
            refresh,
            width,
        )
        .await
        {
            Ok(media) => {
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
    } else if card["itemType"] == "Image" {
        card["mediaError"] = json!("Image source is unavailable / 图片源文件不可用");
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
    if paste && !crate::check_paste_accessibility_permission().granted {
        return Err("Paste automation permission is not available".to_string());
    }
    crate::copy_history_record(app.clone(), hash.clone(), plain_text).await?;
    if paste {
        hide_on_ui_thread()?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::paste(&hash, quick_trigger.as_ref().map(|_| true), quick_trigger)
        })
        .await
        .map_err(|error| error.to_string())?;
        result?;
        Ok(json!({ "message": "Pasted" }))
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
                    panel._module as *mut std::ffi::c_void,
                    b"vpaste_winui_test_history_and_queue\0".as_ptr().cast(),
                )
            };
            if test.is_null() {
                return Err("WinUI regression test export is missing".to_string());
            }
            // SAFETY: the Debug export accepts a uint32_t pointer and returns HRESULT.
            let test: unsafe extern "C" fn(*mut u32) -> i32 = unsafe { std::mem::transmute(test) };
            let mut stage = 0;
            // SAFETY: stage lives for the whole call; the DLL writes it only
            // before returning, never from its asynchronous UI callback.
            let result = unsafe { test(&mut stage) };
            eprintln!(
                "WinUI native history/queue regression: stage={stage}, HRESULT=0x{:08X}",
                result as u32
            );
            super::check_hresult(&format!("history/queue regression stage {stage}"), result)?;
            // Exercise real window key messages, not only the handler helper.
            let route = unsafe {
                super::GetProcAddress(
                    panel._module as *mut std::ffi::c_void,
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
}
