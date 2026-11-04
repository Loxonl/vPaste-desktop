#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct State {
    pub(crate) pinned: bool,
    pub(crate) preview_foreground: bool,
    pub(crate) clipboard_foreground: bool,
    pub(crate) memory_monitor_active: bool,
    pub(crate) cursor_inside_app: bool,
    /// Focus is being moved between the clipboard and preview on purpose
    /// (cursor follow or a preview commit), so a transient blur must not hide them.
    pub(crate) focus_handoff: bool,
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
            Phase::GraceRecheck if state.focus_handoff => Action::Keep,
            Phase::GraceRecheck => Action::HidePreview,
        };
    }
    if state.cursor_inside_app {
        match phase {
            Phase::Initial {
                opening_grace: true,
            } => return Action::Recheck,
            Phase::Initial {
                opening_grace: false,
            } if state.focus_handoff => return Action::Recheck,
            Phase::GraceRecheck => return Action::Keep,
            Phase::Initial {
                opening_grace: false,
            } => {}
        }
    }
    Action::HideBoth
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FocusTarget {
    Clipboard,
    Preview,
}

/// Which window should hold keyboard focus after a preview is committed.
/// A Space preview gives focus to the preview only when the cursor is already
/// inside it; otherwise the clipboard keeps focus. Hover previews never move focus.
pub(crate) fn commit_focus_target(
    takes_focus: bool,
    cursor_in_preview: bool,
) -> Option<FocusTarget> {
    if !takes_focus {
        None
    } else if cursor_in_preview {
        Some(FocusTarget::Preview)
    } else {
        Some(FocusTarget::Clipboard)
    }
}

/// `rect` is `(x, y, width, height)` in logical pixels; `point` is physical.
pub(crate) fn rect_contains_point(
    rect: (f64, f64, f64, f64),
    scale: f64,
    point: (i32, i32),
) -> bool {
    let (x, y, width, height) = rect;
    let left = (x * scale).round() as i64;
    let top = (y * scale).round() as i64;
    let right = ((x + width) * scale).round() as i64;
    let bottom = ((y + height) * scale).round() as i64;
    let (px, py) = (i64::from(point.0), i64::from(point.1));
    px >= left && px <= right && py >= top && py <= bottom
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FollowState {
    pub(crate) preview_visible: bool,
    pub(crate) preview_hover: bool,
    /// The clipboard or the preview is the foreground window, so moving focus
    /// between them never takes focus away from another app.
    pub(crate) app_foreground: bool,
    pub(crate) cursor_in_requester: bool,
    pub(crate) requester_foreground: bool,
}

/// Focus follows the cursor between the clipboard and a Space (or pinned) preview.
pub(crate) fn follow_cursor(requester: FocusTarget, state: FollowState) -> Option<FocusTarget> {
    (state.preview_visible
        && !state.preview_hover
        && state.app_foreground
        && state.cursor_in_requester
        && !state.requester_foreground)
        .then_some(requester)
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

    #[test]
    fn space_preview_leaves_focus_on_the_clipboard_unless_the_cursor_is_inside_it() {
        assert_eq!(
            commit_focus_target(true, false),
            Some(FocusTarget::Clipboard)
        );
        assert_eq!(commit_focus_target(true, true), Some(FocusTarget::Preview));
        // Hover previews never move focus, wherever the cursor is.
        assert_eq!(commit_focus_target(false, false), None);
        assert_eq!(commit_focus_target(false, true), None);
    }

    #[test]
    fn preview_rect_containment_uses_the_physical_target_rect() {
        let rect = (100.0, 50.0, 400.0, 300.0);
        assert!(rect_contains_point(rect, 1.0, (100, 50)));
        assert!(rect_contains_point(rect, 1.0, (500, 350)));
        assert!(!rect_contains_point(rect, 1.0, (99, 200)));
        assert!(!rect_contains_point(rect, 1.0, (300, 351)));
        // Logical rect scaled to physical pixels on a 2x display.
        assert!(rect_contains_point(rect, 2.0, (900, 650)));
        assert!(!rect_contains_point(rect, 2.0, (150, 650)));
    }

    #[test]
    fn cursor_follow_moves_focus_only_between_vpaste_windows_of_a_space_preview() {
        let ready = FollowState {
            preview_visible: true,
            preview_hover: false,
            app_foreground: true,
            cursor_in_requester: true,
            requester_foreground: false,
        };
        for target in [FocusTarget::Clipboard, FocusTarget::Preview] {
            assert_eq!(follow_cursor(target, ready), Some(target));
            for blocked in [
                FollowState {
                    preview_visible: false,
                    ..ready
                },
                FollowState {
                    preview_hover: true,
                    ..ready
                },
                FollowState {
                    app_foreground: false,
                    ..ready
                },
                FollowState {
                    cursor_in_requester: false,
                    ..ready
                },
                FollowState {
                    requester_foreground: true,
                    ..ready
                },
            ] {
                assert_eq!(follow_cursor(target, blocked), None);
            }
        }
    }

    #[test]
    fn cursor_driven_handoff_does_not_close_either_window() {
        let handoff = State {
            focus_handoff: true,
            ..State::default()
        };
        let initial = Phase::Initial {
            opening_grace: false,
        };
        // Preview -> clipboard: clipboard already foreground, or activation still in flight.
        let to_clipboard = State {
            clipboard_foreground: true,
            ..handoff
        };
        assert_eq!(decide(to_clipboard, initial), Action::Keep);
        assert_eq!(decide(to_clipboard, Phase::GraceRecheck), Action::Keep);
        let in_flight = State {
            cursor_inside_app: true,
            ..handoff
        };
        assert_eq!(decide(in_flight, initial), Action::Recheck);
        assert_eq!(decide(in_flight, Phase::GraceRecheck), Action::Keep);
        // A handoff never keeps windows open once focus has really left vPaste.
        assert_eq!(decide(handoff, initial), Action::HideBoth);
        assert_eq!(decide(handoff, Phase::GraceRecheck), Action::HideBoth);
    }
}
