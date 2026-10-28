pub mod shortcuts;

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use crate::{runtime_mode, splicing_with_app_data_dir};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(tag = "mode", content = "value", rename_all = "snake_case")]
pub enum AutoCleanupPolicy {
    #[default]
    Disabled,
    Days(u32),
    Count(u32),
}

impl AutoCleanupPolicy {
    pub fn validate(self) -> Result<(), String> {
        match self {
            Self::Disabled | Self::Days(1..=36_500) | Self::Count(1..=1_000_000) => Ok(()),
            _ => Err("Invalid automatic cleanup limit".to_string()),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MousePasteMode {
    #[default]
    Single,
    Double,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Config {
    pub startup: bool,
    pub display_tray_icon: bool,
    pub multilingual: String,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    pub storage_history: u8,
    #[serde(default)]
    pub auto_cleanup: AutoCleanupPolicy,
    #[serde(default)]
    pub storage_dir: String,
    #[serde(default)]
    pub retain_search_history: bool,
    #[serde(default)]
    pub retain_last_position: bool,
    #[serde(default)]
    pub retain_tab_position: bool,
    #[serde(default = "default_true")]
    pub link_auto_preview: bool,
    #[serde(default)]
    pub mouse_paste_mode: MousePasteMode,
    #[serde(default)]
    pub hover_preview_enabled: bool,
    #[serde(default = "default_true")]
    pub sensitive_content_protection: bool,
    #[serde(default = "default_true")]
    pub quick_input_enabled: bool,
    #[serde(default = "default_true")]
    pub tab_quick_select_enabled: bool,
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default = "default_true")]
    pub update_check_enabled: bool,
    #[serde(default)]
    pub last_update_check_at: String,
    #[serde(default)]
    pub ignored_update_version: String,
    #[serde(default)]
    pub ignored_app_sources: Vec<String>,
    pub shortcut_keys: Shortcutkey,
}
impl Default for Config {
    fn default() -> Self {
        Config {
            startup: true,
            display_tray_icon: true,
            multilingual: default_language(),
            theme_mode: default_theme_mode(),
            storage_history: 0b0,
            auto_cleanup: AutoCleanupPolicy::Disabled,
            storage_dir: String::new(),
            retain_search_history: false,
            retain_last_position: false,
            retain_tab_position: false,
            link_auto_preview: true,
            mouse_paste_mode: MousePasteMode::Single,
            hover_preview_enabled: false,
            sensitive_content_protection: true,
            quick_input_enabled: true,
            tab_quick_select_enabled: true,
            onboarding_completed: false,
            update_check_enabled: true,
            last_update_check_at: String::new(),
            ignored_update_version: String::new(),
            ignored_app_sources: Vec::new(),
            shortcut_keys: Shortcutkey::default(),
        }
    }
}

impl Config {
    pub fn for_runtime(portable: bool) -> Self {
        let mut config = Self::default();
        if portable {
            config.startup = false;
        }
        config
    }
}

fn default_true() -> bool {
    true
}

fn default_theme_mode() -> String {
    "system".to_string()
}

fn default_language() -> String {
    system_locale()
        .map(|locale| {
            if locale.to_ascii_lowercase().starts_with("zh") {
                "Chinese".to_string()
            } else {
                "English".to_string()
            }
        })
        .unwrap_or_else(|| "English".to_string())
}

#[cfg(target_os = "windows")]
fn system_locale() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;

    let mut buffer = [0_u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(&mut buffer) };
    if len <= 1 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..(len as usize - 1)]))
}

#[cfg(not(target_os = "windows"))]
fn system_locale() -> Option<String> {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .or_else(|_| std::env::var("LANG"))
        .ok()
        .filter(|locale| !locale.trim().is_empty())
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Shortcutkey {
    pub main_window: Option<String>,
    pub paste_queue_toggle: Option<String>,
    pub copy_and_show_shortcut: Option<String>,
    pub copy_and_exec_shortcut: Option<String>,
    pub translate: Option<String>,
    pub preview: Option<String>,
    pub paste_into_plain_text: Option<String>,
    pub quick_selection: Option<String>,
}

impl Default for Shortcutkey {
    fn default() -> Self {
        Shortcutkey {
            main_window: Some("Alt+V".to_string()),
            paste_queue_toggle: Some("Alt+Shift+V".to_string()),
            copy_and_show_shortcut: None,
            copy_and_exec_shortcut: None,
            translate: None,
            preview: None,
            paste_into_plain_text: Some("Shift+Enter".to_string()),
            quick_selection: None,
        }
    }
}
use std::sync::RwLock;

lazy_static! {
    static ref CACHE: RwLock<Option<Config>> = RwLock::new(None);
}

pub fn init() {
    let config = Config::for_runtime(runtime_mode::is_portable());
    save(config);
}

pub fn get() -> Config {
    // Try to read from cache first
    if let Ok(cache) = CACHE.read() {
        if let Some(c) = cache.as_ref() {
            return c.clone();
        }
    }

    let config_path = path();
    if !Path::new(config_path.as_str()).exists() {
        init();
        // init calls save, which populates cache
        return get();
    }

    let mut config_content = "".to_string();
    let _ = File::open(config_path)
        .unwrap()
        .read_to_string(&mut config_content);

    let mut config: Config = serde_json::from_str(config_content.as_str()).unwrap_or_else(|_| {
        let config = Config::for_runtime(runtime_mode::is_portable());
        save(config.clone());
        config
    });
    if config.shortcut_keys.paste_into_plain_text.is_none() {
        config.shortcut_keys.paste_into_plain_text = Shortcutkey::default().paste_into_plain_text;
    } else if config.shortcut_keys.paste_into_plain_text.as_deref() == Some("Control+Enter") {
        config.shortcut_keys.paste_into_plain_text = Some("Shift+Enter".to_string());
    }
    if config.shortcut_keys.main_window.is_none() {
        config.shortcut_keys.main_window = Shortcutkey::default().main_window;
    }
    if config.shortcut_keys.paste_queue_toggle.is_none() {
        config.shortcut_keys.paste_queue_toggle = Shortcutkey::default().paste_queue_toggle;
    }

    // Update cache
    if let Ok(mut cache) = CACHE.write() {
        *cache = Some(config.clone());
    }

    config
}

fn path() -> String {
    splicing_with_app_data_dir(&["config.json"])
}

pub fn save(config: Config) {
    let mut cache = CACHE.write().unwrap();
    *cache = Some(config.clone());
    write_to_disk(&config);
}

pub fn update<F>(mutate: F) -> Config
where
    F: FnOnce(&mut Config),
{
    let initialized = CACHE.read().unwrap().is_some();
    if !initialized {
        get();
    }
    let mut cache = CACHE.write().unwrap();
    let config = cache.as_mut().expect("config cache must be initialized");
    mutate(config);
    write_to_disk(config);
    config.clone()
}

fn write_to_disk(config: &Config) {
    let config_json = serde_json::to_string_pretty(config).unwrap();
    File::create(path())
        .unwrap()
        .write_all(config_json.as_bytes())
        .unwrap()
}

// A destructive retention policy must not become active if persistence fails.
pub fn try_update<F>(mutate: F) -> Result<Config, String>
where
    F: FnOnce(&mut Config),
{
    get();
    let mut cache = CACHE.write().map_err(|err| err.to_string())?;
    let mut next = cache
        .as_ref()
        .ok_or("Configuration is unavailable")?
        .clone();
    mutate(&mut next);
    let config_path = path();
    let parent = Path::new(&config_path)
        .parent()
        .ok_or("Invalid configuration path")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|err| err.to_string())?;
    let bytes = serde_json::to_vec_pretty(&next).map_err(|err| err.to_string())?;
    file.write_all(&bytes).map_err(|err| err.to_string())?;
    file.as_file().sync_all().map_err(|err| err.to_string())?;
    file.persist(&config_path).map_err(|err| err.to_string())?;
    *cache = Some(next.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::{AutoCleanupPolicy, Config, MousePasteMode};

    #[test]
    fn mouse_preferences_preserve_legacy_behavior_and_round_trip() {
        let mut old = serde_json::to_value(Config::default()).unwrap();
        old.as_object_mut().unwrap().remove("mouse_paste_mode");
        old.as_object_mut().unwrap().remove("hover_preview_enabled");
        let mut restored: Config = serde_json::from_value(old).unwrap();
        assert_eq!(restored.mouse_paste_mode, MousePasteMode::Single);
        assert!(!restored.hover_preview_enabled);
        restored.mouse_paste_mode = MousePasteMode::Double;
        restored.hover_preview_enabled = true;
        let saved = serde_json::to_value(restored).unwrap();
        assert_eq!(saved["mouse_paste_mode"], "double");
        assert_eq!(saved["hover_preview_enabled"], true);
    }

    #[test]
    fn auto_cleanup_is_disabled_for_new_and_legacy_configs() {
        assert_eq!(Config::default().auto_cleanup, AutoCleanupPolicy::Disabled);
        let mut old = serde_json::to_value(Config::default()).unwrap();
        old.as_object_mut().unwrap().remove("auto_cleanup");
        let restored: Config = serde_json::from_value(old).unwrap();
        assert_eq!(restored.auto_cleanup, AutoCleanupPolicy::Disabled);
    }

    #[test]
    fn auto_cleanup_validates_limits_and_round_trips_settings_payload() {
        for policy in [
            AutoCleanupPolicy::Days(0),
            AutoCleanupPolicy::Count(0),
            AutoCleanupPolicy::Days(36_501),
            AutoCleanupPolicy::Count(1_000_001),
        ] {
            assert!(policy.validate().is_err());
        }
        let policy: AutoCleanupPolicy =
            serde_json::from_str(r#"{"mode":"count","value":5000}"#).unwrap();
        assert_eq!(policy, AutoCleanupPolicy::Count(5000));
        assert!(policy.validate().is_ok());
        assert_eq!(
            serde_json::to_string(&policy).unwrap(),
            r#"{"mode":"count","value":5000}"#
        );
    }

    #[test]
    fn auto_cleanup_persistence_failure_does_not_activate_new_policy() {
        let _guard = crate::TEST_APP_DATA_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() =
            Some(dir.path().to_string_lossy().to_string());
        super::save(Config::default());
        let config_path = dir.path().join("config.json");
        std::fs::remove_file(&config_path).unwrap();
        std::fs::create_dir(&config_path).unwrap();
        let result = super::try_update(|c| c.auto_cleanup = AutoCleanupPolicy::Count(10));
        assert!(result.is_err());
        assert_eq!(super::get().auto_cleanup, AutoCleanupPolicy::Disabled);
        std::fs::remove_dir(&config_path).unwrap();
        let saved = super::try_update(|c| c.auto_cleanup = AutoCleanupPolicy::Days(45)).unwrap();
        assert_eq!(saved.auto_cleanup, AutoCleanupPolicy::Days(45));
        let disk: Config = serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
        assert_eq!(disk.auto_cleanup, saved.auto_cleanup);
        super::save(Config::default());
    }

    #[test]
    fn startup_is_enabled_by_default() {
        assert!(Config::default().startup);
    }

    #[test]
    fn fresh_portable_config_requires_opt_in_for_startup() {
        assert!(!Config::for_runtime(true).startup);
        assert!(Config::for_runtime(false).startup);
    }
}
