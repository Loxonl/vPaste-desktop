pub(crate) fn build_window(
    app: &tauri::AppHandle,
    url: tauri::WebviewUrl,
) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder = tauri::WebviewWindowBuilder::new(app, "devMemory", url)
        .title("vPaste · Memory monitor")
        .visible(false)
        .focused(false)
        .decorations(true)
        .transparent(false)
        .always_on_top(true)
        .resizable(true)
        .inner_size(880.0, 680.0)
        .min_inner_size(620.0, 420.0);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone())?;
    }
    builder.build()
}

pub(crate) fn keep_on_top(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        use objc::{msg_send, sel, sel_impl};
        let handle = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(native) = handle.ns_window() {
                    if !native.is_null() {
                        // Existing vPaste popups use levels 101/102. Do not also
                        // queue Tauri's setter: it would overwrite this with 5.
                        unsafe {
                            let _: () = msg_send![native as id, setLevel:103_isize];
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
