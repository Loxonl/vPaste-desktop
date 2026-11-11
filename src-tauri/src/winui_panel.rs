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

type PanelCall = unsafe extern "C" fn() -> i32;
type PanelSetTheme = unsafe extern "C" fn(u32) -> i32;
type PanelSetLanguage = unsafe extern "C" fn(bool) -> i32;
type PanelShutdown = unsafe extern "C" fn();
type PanelRequest = unsafe extern "C" fn(*const u8, usize);
type PanelReceive = unsafe extern "C" fn(*const u8, usize);
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
    set_language: PanelSetLanguage,
    set_click_mode: PanelSetClickMode,
    set_queue_view: PanelSetQueueView,
    show_queue_no_activate: PanelShowQueueNoActivate,
    hide_for_queue_paste: PanelCall,
    refresh_tags: PanelCall,
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

    Ok(PanelApi {
        _module: module as usize,
        initialize: unsafe { initialize_symbol(module)? },
        show: unsafe { symbol(module, b"vpaste_winui_show\0")? },
        toggle: unsafe { symbol(module, b"vpaste_winui_toggle\0")? },
        hide: unsafe { symbol(module, b"vpaste_winui_hide\0")? },
        refresh: unsafe { symbol(module, b"vpaste_winui_refresh\0")? },
        receive: unsafe { receive_symbol(module)? },
        set_theme: unsafe { set_theme_symbol(module)? },
        set_language: unsafe { set_language_symbol(module)? },
        set_click_mode: unsafe { set_click_mode_symbol(module)? },
        set_queue_view: unsafe { set_queue_view_symbol(module)? },
        show_queue_no_activate: unsafe { show_queue_no_activate_symbol(module)? },
        hide_for_queue_paste: unsafe { symbol(module, b"vpaste_winui_hide_for_queue_paste\0")? },
        refresh_tags: unsafe { symbol(module, b"vpaste_winui_refresh_tags\0")? },
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
    app.listen("paste-queue-state-changed", move |event| {
        if let Ok(state) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            send_response(0, "queueStateUpdate", Ok(state));
        }
    });
    app.listen("clipboard-behavior-config-changed", move |_| {
        if let Err(error) = apply_theme() {
            log::debug!("WinUI theme update deferred: {error}");
        }
        if let Err(error) = apply_click_mode() {
            log::debug!("WinUI click-mode update deferred: {error}");
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
    initialize_native(english, single_click_paste)
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
    apply_theme()?;
    // SAFETY: the DLL marshals this call to its dedicated UI thread.
    check_hresult("show", unsafe { (panel.show)() })?;
    check_hresult("history refresh", unsafe { (panel.refresh)() })?;
    check_hresult("tag refresh", unsafe { (panel.refresh_tags)() })
}

fn toggle_on_ui_thread() -> Result<(), String> {
    let panel = api()?;
    apply_theme()?;
    // SAFETY: the DLL marshals this call to its dedicated UI thread.
    if !crate::CLIPBOARD_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
        crate::windows_paste_focus::capture_foreground();
        crate::record_foreground_app_before_clipboard();
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
    let response = match result {
        Ok(data) => json!({ "id": id, "op": op, "data": data }),
        Err(error) => json!({ "id": id, "op": op, "error": error }),
    };
    let Ok(bytes) = serde_json::to_vec(&response) else {
        return;
    };
    if let Ok(panel) = api() {
        // SAFETY: the native export copies these bytes before it returns.
        unsafe { (panel.receive)(bytes.as_ptr(), bytes.len()) };
    }
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
    tauri::async_runtime::spawn(async move {
        let result = match request.op.as_str() {
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
            "query" => query_history(request.query, request.filter, request.tag_name, 0, 0).await,
            "queryMore" => {
                query_history(
                    request.query,
                    request.filter,
                    request.tag_name,
                    request.last_id,
                    request.last_time,
                )
                .await
            }
            "tags" => query_tags().await,
            "copy" => run_history_action(app.clone(), request.hash, false).await,
            "paste" => run_history_action(app.clone(), request.hash, true).await,
            "favorite" => update_favorite(app.clone(), request.hash, request.favorite).await,
            "delete" => delete_history_item(app.clone(), request.hash).await,
            "edit" => crate::open_text_editor_window(app.clone(), request.hash)
                .await
                .map(|_| json!({})),
            "assignTag" => update_item_tag(request.hash, request.tag_id, true).await,
            "removeTag" => update_item_tag(request.hash, request.tag_id, false).await,
            "card" => query_card(request.hash).await,
            _ => Err("Unknown WinUI panel request".to_string()),
        };
        if result.is_ok() && matches!(op.as_str(), "assignTag" | "removeTag") {
            let _ = app.emit("item-tags-changed", json!({}));
        }
        if result.is_ok() && op == "delete" {
            let _ = app.emit("listen_new_clipboard", ());
        }
        if result.is_err() && op == "paste" {
            let _ = show_on_ui_thread();
        }
        send_response(id, &op, result);
    });
}

async fn query_history(
    query: String,
    filter: String,
    tag_name: String,
    last_id: u64,
    last_time: u64,
) -> Result<serde_json::Value, String> {
    let label = history_filter_label(&filter, &tag_name);
    let page = tauri::async_runtime::spawn_blocking(move || {
        crate::clipboard::history_ref_page(&query, last_id, last_time, 36, &label, || true)
    })
    .await
    .map_err(|error| error.to_string())??
    .ok_or_else(|| "Clipboard history query was cancelled".to_string())?;
    let items = page
        .list
        .into_iter()
        .map(|item| {
            json!({
                "hash": item.hash,
                "itemType": item.item_type.to_string(),
                "previewText": item.preview_text,
                "appSource": item.app_source,
                "time": item.time,
                "favorite": item.label & 1 != 0,
                "tags": item.tags,
            })
        })
        .collect::<Vec<_>>();
    let count = items.len();
    Ok(json!({
        "items": items,
        "knownCount": count,
        "hasMore": page.has_more,
        "nextId": page.next_id,
        "nextTime": page.next_time,
    }))
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
    let affected = tauri::async_runtime::spawn_blocking(move || {
        crate::clipboard::delete_by_hash(&hash).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    if affected == 0 {
        return Err("Clipboard item was not found".to_string());
    }
    crate::paste_queue::emit_state(&app);
    Ok(json!({ "deleted": true }))
}

async fn query_card(hash: String) -> Result<serde_json::Value, String> {
    let summary_hash = hash.clone();
    let (item_type, display_text, media_path, tags, title_color) =
        tauri::async_runtime::spawn_blocking(move || {
            let payload = crate::clipboard::history_card_payload(&summary_hash, false)?;
            let item = payload.item;
            let tags = item.tags.clone();
            let title_color = item.title_color.clone();
            let mut media_path = None;
            let display_text = match item.item_type {
                crate::clipboard::item::ItemType::Image => {
                    media_path = Some(item.preview_content.clone());
                    item.text_content.clone()
                }
                crate::clipboard::item::ItemType::File => {
                    let info = crate::build_file_preview_info(item.content.clone()).ok();
                    if let Some(info) = info {
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
            Ok::<_, String>((
                item.item_type.to_string(),
                display_text,
                media_path,
                tags,
                title_color,
            ))
        })
        .await
        .map_err(|error| error.to_string())??;

    let media = if let Some(path) = media_path.filter(|path| !path.is_empty()) {
        crate::media_resources::resolve_for_card_width(
            path,
            crate::media_resources::MediaIntent::Card,
            false,
            240,
        )
        .await
        .ok()
    } else {
        None
    };
    let (asset_path, dimensions) = media
        .map(|media| {
            (
                media.asset_path,
                if media.metadata.width > 0 && media.metadata.height > 0 {
                    format!("{} × {}", media.metadata.width, media.metadata.height)
                } else {
                    String::new()
                },
            )
        })
        .unwrap_or_default();
    Ok(json!({
        "hash": hash,
        "itemType": item_type,
        "displayText": display_text,
        "assetPath": asset_path,
        "dimensions": dimensions,
        "tags": tags,
        "titleColor": title_color,
    }))
}

async fn run_history_action(
    app: AppHandle,
    hash: String,
    paste: bool,
) -> Result<serde_json::Value, String> {
    if ACTION_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("Another clipboard action is already running".to_string());
    }
    struct ResetAction;
    impl Drop for ResetAction {
        fn drop(&mut self) {
            ACTION_IN_FLIGHT.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    let _reset = ResetAction;
    let info = crate::history_item_action_info(hash.clone()).await?;
    if let Some(path) = info.missing_paths.first() {
        return Err(format!("Source file is missing: {path}"));
    }
    if paste && !crate::check_paste_accessibility_permission().granted {
        return Err("Paste automation permission is not available".to_string());
    }
    crate::copy_history_record(app.clone(), hash.clone(), false).await?;
    if paste {
        hide_on_ui_thread()?;
        let result = tauri::async_runtime::spawn_blocking(move || crate::paste(&hash, None, None))
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
            super::check_hresult("tag refresh", unsafe { (panel.refresh_tags)() })
        });
        super::shutdown();
        assert!(result.is_ok(), "native initialization failed: {result:?}");
        assert!(matches!(shown, Ok(Ok(()))), "native show failed: {shown:?}");
    }
}
