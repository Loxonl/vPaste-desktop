#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct State {
    pub(crate) pinned: bool,
    pub(crate) preview_foreground: bool,
    pub(crate) clipboard_foreground: bool,
    pub(crate) memory_monitor_active: bool,
    pub(crate) cursor_inside_app: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Phase {
    Initial { opening_grace: bool },
    GraceRecheck,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Action {
    Keep,
    HidePreview,
    HideBoth,
    Recheck,
}

pub(crate) fn decide(state: State, phase: Phase) -> Action {
    if state.pinned || state.preview_foreground || state.memory_monitor_active {
        return Action::Keep;
    }
    if state.clipboard_foreground {
        return match phase {
            Phase::Initial { .. } => Action::Keep,
            Phase::GraceRecheck => Action::HidePreview,
        };
    }
    if state.cursor_inside_app {
        match phase {
            Phase::Initial {
                opening_grace: true,
            } => return Action::Recheck,
            Phase::GraceRecheck => return Action::Keep,
            Phase::Initial {
                opening_grace: false,
            } => {}
        }
    }
    Action::HideBoth
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focusing_memory_monitor_preserves_both_windows_during_and_after_grace() {
        for phase in [
            Phase::Initial {
                opening_grace: true,
            },
            Phase::Initial {
                opening_grace: false,
            },
            Phase::GraceRecheck,
        ] {
            let mut state = State::default();
            state.memory_monitor_active = true;
            assert_eq!(decide(state, phase), Action::Keep);
            state.cursor_inside_app = true;
            assert_eq!(decide(state, phase), Action::Keep);
        }
    }

    #[test]
    fn returning_to_clipboard_keeps_the_preview_available_for_selection_updates() {
        let state = State {
            clipboard_foreground: true,
            ..State::default()
        };
        assert_eq!(
            decide(
                state,
                Phase::Initial {
                    opening_grace: false
                }
            ),
            Action::Keep
        );
    }

    #[test]
    fn existing_preview_clipboard_and_external_focus_behavior_is_preserved() {
        let initial = Phase::Initial {
            opening_grace: false,
        };
        assert_eq!(decide(State::default(), initial), Action::HideBoth);
        assert_eq!(
            decide(State::default(), Phase::GraceRecheck),
            Action::HideBoth
        );
        assert_eq!(
            decide(
                State {
                    pinned: true,
                    ..State::default()
                },
                initial
            ),
            Action::Keep
        );
        assert_eq!(
            decide(
                State {
                    preview_foreground: true,
                    ..State::default()
                },
                initial
            ),
            Action::Keep
        );
        assert_eq!(
            decide(
                State {
                    clipboard_foreground: true,
                    ..State::default()
                },
                initial
            ),
            Action::Keep
        );
        assert_eq!(
            decide(
                State {
                    clipboard_foreground: true,
                    ..State::default()
                },
                Phase::GraceRecheck
            ),
            Action::HidePreview
        );
        let inside = State {
            cursor_inside_app: true,
            ..State::default()
        };
        assert_eq!(
            decide(
                inside,
                Phase::Initial {
                    opening_grace: true
                }
            ),
            Action::Recheck
        );
        assert_eq!(decide(inside, initial), Action::HideBoth);
        assert_eq!(decide(inside, Phase::GraceRecheck), Action::Keep);
    }
}
