//! Process-local DEV preview. Window destruction retains this small session only.
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager};

static NEXT: AtomicU64 = AtomicU64::new(0);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: u64,
    revision: u64,
    step: u8,
    filters: [bool; 5],
    shortcut: String,
    assets: BTreeMap<String, String>,
}
impl Session {
    fn update(
        &mut self,
        step: u8,
        action: &str,
        index: usize,
        enabled: bool,
    ) -> Result<bool, String> {
        if step != self.step {
            return Err("The tutorial step changed".into());
        }
        match action {
            "next" if self.step < 3 => self.step += 1,
            "back" if self.step > 1 => self.step -= 1,
            "toggle" if self.step == 2 && index < self.filters.len() => {
                self.filters[index] = enabled
            }
            "finish" if self.step == 3 => return Ok(true),
            "cancel" => return Ok(true),
            _ => return Err("Unsupported tutorial action".into()),
        }
        self.revision += 1;
        Ok(false)
    }
}

pub(crate) fn active() -> bool {
    SESSION
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .is_some()
}
pub(super) fn blocks_toggle() -> bool {
    SESSION
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .as_ref()
        .is_some_and(|state| state.step != 3)
}
fn encode(state: Session) -> Value {
    let mut value = serde_json::to_value(state).expect("tutorial session");
    value["permissions"] = json!(crate::get_onboarding_permission_status());
    value["motion"] = serde_json::from_str(include_str!("../../../src/ui/motion/tokens.json"))
        .expect("motion tokens");
    value
}
pub(super) fn snapshot() -> Option<Value> {
    let state = SESSION
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    state.map(encode)
}

pub(super) fn start(app: &AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join("native-onboarding");
    std::fs::create_dir_all(&directory).map_err(|err| err.to_string())?;
    let mut assets = BTreeMap::new();
    for (name, bytes) in [
        (
            "background",
            include_bytes!(concat!(env!("OUT_DIR"), "/permission-background.png")).as_slice(),
        ),
        (
            "paste",
            include_bytes!(concat!(env!("OUT_DIR"), "/permission-paste.png")).as_slice(),
        ),
        (
            "shortcut",
            include_bytes!(concat!(env!("OUT_DIR"), "/shortcut-popover.png")).as_slice(),
        ),
        (
            "logo",
            include_bytes!("../../icons/source/vpaste-app-icon-1024.png").as_slice(),
        ),
    ] {
        let version = hex::encode(&Sha256::digest(bytes)[..8]);
        let path = directory.join(format!("{name}-{version}.png"));
        if !path.is_file() {
            let mut file =
                tempfile::NamedTempFile::new_in(&directory).map_err(|err| err.to_string())?;
            file.write_all(bytes).map_err(|err| err.to_string())?;
            file.persist(&path).map_err(|err| err.to_string())?;
        }
        assets.insert(name.into(), path.to_string_lossy().into_owned());
    }
    *SESSION.lock().unwrap_or_else(|err| err.into_inner()) = Some(Session {
        id: NEXT.fetch_add(1, Ordering::AcqRel) + 1,
        revision: 1,
        step: 0,
        filters: [true, true, true, true, false],
        shortcut: crate::config::get()
            .shortcut_keys
            .main_window
            .unwrap_or_else(|| "Alt+V".into()),
        assets,
    });
    Ok(())
}

pub(super) async fn handle(app: AppHandle, request: &super::Request) -> Result<Value, String> {
    let exiting = {
        let mut session = SESSION.lock().unwrap_or_else(|err| err.into_inner());
        let state = session
            .as_mut()
            .filter(|state| state.id == request.onboarding_id)
            .ok_or("The tutorial preview is no longer active")?;
        if request.target == "status" {
            return Ok(encode(state.clone()));
        }
        if request.target == "permission" {
            if state.step != 1
                || request.step != 1
                || !matches!(request.kind.as_str(), "background" | "paste")
            {
                return Err("Permission is unavailable at this tutorial step".into());
            }
            false
        } else {
            let exit = state.update(
                request.step,
                &request.target,
                request.start,
                request.enabled,
            )?;
            if exit {
                *session = None;
            }
            exit
        }
    };
    if request.target == "permission" {
        crate::open_onboarding_permission_window_from_source(
            app,
            None,
            request.kind.clone(),
            Some(request.language.clone()),
            Some(request.theme.clone()),
        )
        .await?;
    } else if exiting {
        let config = crate::config::get();
        super::present(
            app,
            config.multilingual,
            config.theme_mode,
            false,
            true,
            None,
        )?;
    }
    Ok(snapshot().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> Session {
        Session {
            id: 1,
            revision: 1,
            step: 0,
            filters: [true, true, true, true, false],
            shortcut: "Alt+V".into(),
            assets: BTreeMap::new(),
        }
    }
    #[test]
    fn preview_keeps_filter_drafts_and_requires_the_current_step() {
        let mut state = session();
        assert!(state.update(0, "toggle", 0, false).is_err());
        assert!(!state.update(0, "next", 0, false).unwrap());
        assert!(state.update(0, "next", 0, false).is_err());
        assert!(!state.update(1, "next", 0, false).unwrap());
        assert!(!state.update(2, "toggle", 4, true).unwrap());
        assert!(state.filters[4]);
        assert!(state.update(2, "toggle", 5, true).is_err());
        assert!(state.update(2, "finish", 0, false).is_err());
        assert!(!state.update(2, "next", 0, false).unwrap());
        let restored = state.clone();
        assert_eq!(restored.step, 3);
        assert!(state.update(3, "finish", 0, false).unwrap());
    }
    #[test]
    fn permissions_are_optional_and_cancel_does_not_complete_formal_onboarding() {
        let mut state = session();
        assert!(!state.update(0, "next", 0, false).unwrap());
        assert!(!state.update(1, "next", 0, false).unwrap());
        assert!(!state.update(2, "back", 0, false).unwrap());
        assert_eq!(state.step, 1);
        assert!(state.update(1, "cancel", 0, false).unwrap());
        assert!(state.update(1, "unknown", 0, false).is_err());
    }
}
