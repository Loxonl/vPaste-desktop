use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreviewMode {
    #[default]
    Manual,
    Selection,
    Hover,
}

impl PreviewMode {
    pub(crate) fn allows(self, visible: bool, hover: bool, pinned: bool) -> bool {
        match self {
            Self::Manual => true,
            Self::Selection => visible && !hover && !pinned,
            Self::Hover => !pinned && (!visible || hover),
        }
    }

    pub(crate) fn takes_focus(self) -> bool {
        self == Self::Manual
    }
}

#[cfg(test)]
mod tests {
    use super::PreviewMode::*;

    #[test]
    fn hover_cannot_replace_manual_or_pinned_previews() {
        assert!(Hover.allows(false, false, false));
        assert!(Hover.allows(true, true, false));
        assert!(!Hover.allows(true, false, false));
        assert!(!Hover.allows(true, true, true));
    }

    #[test]
    fn selection_only_updates_an_existing_ordinary_preview() {
        assert!(Selection.allows(true, false, false));
        assert!(!Selection.allows(false, false, false));
        assert!(!Selection.allows(true, true, false));
        assert!(!Selection.allows(true, false, true));
    }

    #[test]
    fn only_manual_preview_takes_focus() {
        assert!(Manual.takes_focus());
        assert!(!Selection.takes_focus());
        assert!(!Hover.takes_focus());
    }
}
