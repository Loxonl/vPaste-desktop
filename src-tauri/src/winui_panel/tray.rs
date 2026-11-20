//! Projection for the Windows native tray view. The Tauri tray icon and all
//! commands keep their shared owners in main.rs and app_updater.rs.
use serde_json::{json, Value};
use tauri::{AppHandle, PhysicalPosition, Rect};

enum Action {
    Pause,
    ShowMain,
    Settings,
    Update,
    Quit,
}

impl Action {
    fn parse(name: &str) -> Result<Self, String> {
        match name {
            "pause" => Ok(Self::Pause),
            "showMain" => Ok(Self::ShowMain),
            "settings" => Ok(Self::Settings),
            "update" => Ok(Self::Update),
            "quit" => Ok(Self::Quit),
            _ => Err("Unknown tray action".into()),
        }
    }
}

fn snapshot(app: &AppHandle) -> Value {
    let config = crate::config::get();
    json!({
        "paused": crate::get_clipboard_history_paused(),
        "updateReady": crate::app_updater::get_update_state(app.clone()).tray_restart_ready(),
        "english": config.multilingual.to_ascii_lowercase().starts_with("en"),
        "theme": config.theme_mode,
        "textScale": crate::ui_text_scale::current(),
    })
}

pub(super) fn refresh(app: &AppHandle) {
    super::send_response(0, "nativeTrayState", Ok(snapshot(app)));
}

pub(crate) async fn open(
    app: &AppHandle,
    icon: Rect,
    cursor: Option<PhysicalPosition<i32>>,
) -> Result<(), String> {
    let owner = app.clone();
    crate::auxiliary_windows::on_main_thread(app.clone(), move || {
        let lookup = cursor.unwrap_or_else(|| icon.position.to_physical(1.0));
        let monitor = owner
            .monitor_from_point(f64::from(lookup.x), f64::from(lookup.y))
            .ok()
            .flatten()
            .or_else(|| owner.primary_monitor().ok().flatten())
            .ok_or("The tray monitor is unavailable")?;
        let scale = monitor.scale_factor();
        let anchor = cursor.unwrap_or_else(|| {
            let pos = icon.position.to_physical::<i32>(scale);
            let size = icon.size.to_physical::<u32>(scale);
            PhysicalPosition::new(pos.x + size.width as i32 / 2, pos.y + size.height as i32)
        });
        let work = monitor.work_area();
        let mut data = snapshot(&owner);
        data["anchor"] = json!({"x": anchor.x, "y": anchor.y, "cursor": cursor.is_some()});
        data["workArea"] = json!({
            "left": work.position.x, "top": work.position.y,
            "right": i64::from(work.position.x) + i64::from(work.size.width),
            "bottom": i64::from(work.position.y) + i64::from(work.size.height),
        });
        data["dpiScale"] = json!(scale);
        super::api()?;
        super::send_response(0, "nativeTrayShow", Ok(data));
        Ok(())
    })
    .await
}

pub(super) async fn dispatch(app: AppHandle, name: &str, payload: &Value) -> Result<Value, String> {
    match Action::parse(name)? {
        Action::Pause => {
            let owner = app.clone();
            crate::auxiliary_windows::on_main_thread(app, move || {
                crate::toggle_clipboard_history_paused(owner)?;
                Ok(())
            })
            .await?;
        }
        Action::ShowMain => crate::show_main_panel_for_app(&app)?,
        Action::Settings => {
            // Use the popup's position, not the main panel's last monitor or
            // the current cursor, which may have moved during keyboard input.
            let monitor = payload["x"]
                .as_f64()
                .zip(payload["y"].as_f64())
                .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten());
            crate::open_config_window_from_source_monitor(app, None, None, monitor).await?;
        }
        Action::Update => crate::app_updater::restart_and_install_app_update(app).await?,
        Action::Quit => crate::quit_app(app),
    }
    Ok(json!({}))
}
