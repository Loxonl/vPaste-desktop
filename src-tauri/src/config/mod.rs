pub mod shortcuts;

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use crate::splicing_with_app_data_dir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Config {
    pub startup: bool,
    pub display_tray_icon: bool,
    pub multilingual: String,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    pub storage_history: u8,
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
            storage_dir: String::new(),
            retain_search_history: false,
            retain_last_position: false,
            retain_tab_position: false,
            link_auto_preview: true,
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
    let config = Config::default();
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
        let config = Config::default();
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
    // Update cache
    if let Ok(mut cache) = CACHE.write() {
        *cache = Some(config.clone());
    }

    let config_json = serde_json::to_string_pretty(&config).unwrap();

    File::create(path())
        .unwrap()
        .write_all(config_json.as_bytes())
        .unwrap()
}
