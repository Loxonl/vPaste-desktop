use super::*;
use serde_json::json;

#[test]
fn only_left_and_right_releases_open_the_menu() {
    for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
        assert!(!opens_on(button, MouseButtonState::Down));
        assert_eq!(
            opens_on(button, MouseButtonState::Up),
            button != MouseButton::Middle
        );
    }
}

#[test]
fn menu_order_state_and_update_actions_match_the_tray() {
    let recording = menu(false, None, "English", "English", &[]);
    assert_eq!(
        recording.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
        [
            Action::Pause,
            Action::ShowMain,
            Action::Settings,
            Action::Quit
        ]
    );
    assert_eq!(recording.rows[0].title, "Pause Recording");
    let status = recording.rows[0].recording.as_ref().unwrap();
    assert!(!status.paused);
    assert_eq!(status.label, "On");
    assert!(recording.rows[1..]
        .iter()
        .all(|row| row.recording.is_none()));
    assert!(recording.selection(Action::Restart as i32).is_err());
    assert!(recording.selection(-1).is_err());
    assert_eq!(recording.selection(0).unwrap(), None);

    for update in [Action::Restart, Action::AppStore] {
        let paused = menu(true, Some(update), "Chinese", "English", &[]);
        assert_eq!(paused.rows[0].title, "恢复记录");
        let status = paused.rows[0].recording.as_ref().unwrap();
        assert!(status.paused);
        assert_eq!(status.label, "已暂停");
        assert!(paused.rows[1..].iter().all(|row| row.recording.is_none()));
        assert_eq!(paused.rows[1].id, update);
        assert_eq!(paused.selection(update as i32).unwrap(), Some(update));
    }
}

#[test]
fn external_language_and_english_fallback_follow_the_existing_menu() {
    let pack = |code: &str, translations| LanguagePackFile {
        code: code.into(),
        name: code.into(),
        native_name: code.into(),
        translations,
    };
    let packs = [
        pack("Chinese", json!({"tray.settings":"自定义设置"})),
        pack(
            "Custom",
            json!({
                "tray.showMain": "Open history",
                "tray.quit": "",
                "tray.pauseHistory": "Hold clip history",
                "tray.historyPausedShort": "Held"
            }),
        ),
    ];
    let external = menu(false, None, "Custom", "Chinese", &packs);
    assert_eq!(external.rows[0].title, "Hold clip history");
    assert_eq!(external.rows[0].recording.as_ref().unwrap().label, "On");
    let external_paused = menu(true, None, "Custom", "Chinese", &packs);
    assert_eq!(external_paused.rows[0].title, "Resume Recording");
    assert_eq!(
        external_paused.rows[0].recording.as_ref().unwrap().label,
        "Held"
    );
    assert_eq!(external.rows[1].title, "Open history");
    assert_eq!(external.rows[2].title, "Settings");
    assert_eq!(external.rows[3].title, "Quit");

    let fallback = menu(false, None, "Missing", "Chinese", &packs);
    assert_eq!(fallback.rows[1].title, "显示主面板");
    assert_eq!(fallback.rows[2].title, "自定义设置");
}

#[cfg(debug_assertions)]
#[test]
fn tray_language_follows_preview_settings_and_reloaded_config() {
    use crate::config::{self, Config};
    use crate::native_panel::developer::{preview_language, set_language_preview};

    struct Restore(Option<String>, Option<Config>, Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            *crate::GLOBAL_APP_DATA_DIR.lock().unwrap() = self.0.take();
            config::replace_test_cache(self.1.take());
            set_language_preview(self.2.take());
        }
    }

    let _lock = crate::TEST_APP_DATA_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let previous_dir = crate::GLOBAL_APP_DATA_DIR
        .lock()
        .unwrap()
        .replace(dir.path().to_string_lossy().into_owned());
    let _restore = Restore(
        previous_dir,
        config::replace_test_cache(None),
        preview_language(),
    );
    set_language_preview(None);
    config::save(Config {
        multilingual: "English".into(),
        ..Config::default()
    });
    let lang_dir = dir.path().join("lang");
    std::fs::create_dir(&lang_dir).unwrap();
    std::fs::write(
        lang_dir.join("fixture.json"),
        json!({
            "code": "fixture",
            "nativeName": "Display name",
            "translations": {"tray.showMain": "Fixture history"}
        })
        .to_string(),
    )
    .unwrap();

    let show_main = || current_menu(None).rows[1].title.clone();
    assert_eq!(show_main(), "Show Main Panel");
    set_language_preview(Some("Chinese".into()));
    assert_eq!(show_main(), "显示主面板");
    assert_eq!(config::get().multilingual, "English");

    let mut settings = config::get();
    settings.multilingual = "fixture".into();
    let saved = crate::persist_settings_config(settings).unwrap();
    assert_eq!(saved.multilingual, "fixture");
    assert_eq!(preview_language(), None);
    assert_eq!(show_main(), "Fixture history");
    assert_eq!(current_menu(None).rows[2].title, "Settings");
    config::replace_test_cache(None);
    assert_eq!(show_main(), "Fixture history");

    for (language, expected) in [("Chinese", "显示主面板"), ("English", "Show Main Panel")] {
        let mut settings = config::get();
        settings.multilingual = language.into();
        crate::persist_settings_config(settings).unwrap();
        assert_eq!(show_main(), expected);
    }
    config::replace_test_cache(None);
    assert_eq!(show_main(), "Show Main Panel");
}
