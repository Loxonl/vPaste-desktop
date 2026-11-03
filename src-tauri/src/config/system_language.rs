//! Chooses the default `multilingual` value for a freshly created config.
//!
//! Only used when no saved language exists; a user's saved choice is never
//! overridden by this module.

pub const CHINESE: &str = "Chinese";
pub const ENGLISH: &str = "English";

/// Default UI language derived from the system's ordered language preferences.
/// Falls back to English when nothing supported is found.
pub fn default_language() -> String {
    language_for_locales(preferred_locales())
        .unwrap_or(ENGLISH)
        .to_string()
}

/// Returns the first supported language in preference order.
///
/// Matching uses the primary language subtag (`zh-Hans-CN`, `zh_TW.UTF-8`,
/// `en-US` ...). Unsupported entries are skipped so that, for example,
/// `["fr-FR", "zh-Hans-CN"]` selects Chinese rather than English.
pub fn language_for_locales<I, S>(locales: I) -> Option<&'static str>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    locales.into_iter().find_map(|locale| {
        let primary = locale
            .as_ref()
            .trim()
            .split(['-', '_', '.', '@'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        match primary.as_str() {
            "zh" => Some(CHINESE),
            "en" => Some(ENGLISH),
            _ => None,
        }
    })
}

/// POSIX locale precedence: the first non-empty of `LC_ALL`, `LC_MESSAGES`,
/// `LANG`. An empty variable counts as unset, so it does not hide later ones.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn first_env_locale(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| get(name))
        .find(|value| !value.trim().is_empty())
}

#[cfg(not(target_os = "windows"))]
fn env_locale() -> Option<String> {
    first_env_locale(|name| std::env::var(name).ok())
}

#[cfg(target_os = "macos")]
fn preferred_locales() -> Vec<String> {
    // Apps launched from Finder/Launchpad usually receive no LANG/LC_* at all,
    // so the Mac's ordered "Preferred Languages" list is the reliable source.
    let preferred = mac_preferred_languages();
    if !preferred.is_empty() {
        return preferred;
    }
    env_locale().into_iter().collect()
}

#[cfg(target_os = "macos")]
fn mac_preferred_languages() -> Vec<String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    unsafe {
        let languages: id = msg_send![class!(NSLocale), preferredLanguages];
        if languages == nil {
            return Vec::new();
        }
        let count: usize = msg_send![languages, count];
        (0..count)
            .filter_map(|index| {
                let language: id = msg_send![languages, objectAtIndex: index];
                if language == nil {
                    return None;
                }
                let bytes: *const std::ffi::c_char = msg_send![language, UTF8String];
                if bytes.is_null() {
                    return None;
                }
                Some(CStr::from_ptr(bytes).to_string_lossy().into_owned())
            })
            .collect()
    }
}

#[cfg(target_os = "windows")]
fn preferred_locales() -> Vec<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;

    let mut buffer = [0_u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(&mut buffer) };
    if len <= 1 {
        return Vec::new();
    }
    vec![String::from_utf16_lossy(&buffer[..(len as usize - 1)])]
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn preferred_locales() -> Vec<String> {
    env_locale().into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{first_env_locale, language_for_locales};

    #[test]
    fn follows_first_supported_preferred_language() {
        assert_eq!(
            language_for_locales(["zh-Hans-CN", "en-CN"]),
            Some("Chinese")
        );
        assert_eq!(
            language_for_locales(["en-US", "zh-Hans-CN"]),
            Some("English")
        );
        assert_eq!(language_for_locales(["zh_TW.UTF-8"]), Some("Chinese"));
        assert_eq!(
            language_for_locales(["fr-FR", "zh-Hant-TW", "en"]),
            Some("Chinese")
        );
        assert_eq!(language_for_locales(["ja-JP", "en-JP"]), Some("English"));
    }

    #[test]
    fn unsupported_or_empty_preferences_make_no_decision() {
        assert_eq!(language_for_locales(["zha", "eng"]), None);
        assert_eq!(language_for_locales(["fr-FR", "", "C.UTF-8"]), None);
        assert_eq!(language_for_locales(Vec::<String>::new()), None);
    }

    fn lookup(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn empty_env_variable_does_not_hide_later_ones() {
        assert_eq!(
            first_env_locale(lookup(&[("LC_ALL", ""), ("LANG", "zh_CN.UTF-8")])),
            Some("zh_CN.UTF-8".to_string())
        );
        assert_eq!(
            first_env_locale(lookup(&[
                ("LC_ALL", "  "),
                ("LC_MESSAGES", "en_US.UTF-8"),
                ("LANG", "zh_CN.UTF-8"),
            ])),
            Some("en_US.UTF-8".to_string())
        );
        assert_eq!(first_env_locale(lookup(&[("LANG", "")])), None);
    }

    #[test]
    fn env_precedence_is_not_a_preference_list() {
        // LC_ALL overrides LANG even when only LANG names a supported language.
        assert_eq!(
            first_env_locale(lookup(&[
                ("LC_ALL", "fr_FR.UTF-8"),
                ("LANG", "zh_CN.UTF-8")
            ])),
            Some("fr_FR.UTF-8".to_string())
        );
    }
}
