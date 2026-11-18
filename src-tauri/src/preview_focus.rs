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
/// Interactive text readers take focus immediately so selection and copy work.
pub(crate) fn commit_focus_target(
    takes_focus: bool,
    cursor_in_preview: bool,
    interactive_text: bool,
) -> Option<FocusTarget> {
    if !takes_focus {
        None
    } else if interactive_text || cursor_in_preview {
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

/// Focus attempts per window entry; activation can land a tick late on macOS.
pub(crate) const FOCUS_WATCH_ATTEMPTS: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Eligibility {
    /// Focus may move to the target now.
    Ready,
    /// The target already has focus; nothing left to do for this entry.
    AlreadyFocused,
    /// Moving focus is not allowed right now; wait for the next entry.
    Blocked,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct WatchState {
    /// The clipboard is shown and no other vPaste window (editor, settings...) is in use.
    pub(crate) clipboard_available: bool,
    pub(crate) clipboard_foreground: bool,
    /// A Space or pinned preview is visible (hover previews never take focus).
    pub(crate) preview_follows: bool,
    pub(crate) preview_foreground: bool,
    /// The clipboard or the preview is the foreground window.
    pub(crate) vpaste_foreground: bool,
}

/// Entering the clipboard takes focus back from anywhere, including other apps.
/// Entering a preview only moves focus within vPaste, so a pinned preview never
/// steals focus from another app.
pub(crate) fn eligibility(target: FocusTarget, state: WatchState) -> Eligibility {
    match target {
        FocusTarget::Clipboard if !state.clipboard_available => Eligibility::Blocked,
        FocusTarget::Clipboard if state.clipboard_foreground => Eligibility::AlreadyFocused,
        FocusTarget::Clipboard => Eligibility::Ready,
        FocusTarget::Preview if !state.preview_follows || !state.vpaste_foreground => {
            Eligibility::Blocked
        }
        FocusTarget::Preview if state.preview_foreground => Eligibility::AlreadyFocused,
        FocusTarget::Preview => Eligibility::Ready,
    }
}

/// Edge-triggered cursor tracking: acts when the cursor enters a window, never
/// while it rests inside one, so it does not fight clicks or keyboard focus changes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusWatch {
    region: Option<FocusTarget>,
    attempts_left: u8,
}

impl FocusWatch {
    pub(crate) fn new(region: Option<FocusTarget>) -> Self {
        Self {
            region,
            attempts_left: 0,
        }
    }

    /// Records the window under the cursor; returns a target still owed focus.
    pub(crate) fn pending(&mut self, region: Option<FocusTarget>) -> Option<FocusTarget> {
        if region != self.region {
            self.region = region;
            self.attempts_left = if region.is_some() {
                FOCUS_WATCH_ATTEMPTS
            } else {
                0
            };
        }
        (self.attempts_left > 0).then_some(self.region).flatten()
    }

    pub(crate) fn resolve(&mut self, eligibility: Eligibility) {
        self.attempts_left = match eligibility {
            Eligibility::Ready => self.attempts_left.saturating_sub(1),
            Eligibility::AlreadyFocused | Eligibility::Blocked => 0,
        };
    }
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
            commit_focus_target(true, false, false),
            Some(FocusTarget::Clipboard)
        );
        assert_eq!(
            commit_focus_target(true, true, false),
            Some(FocusTarget::Preview)
        );
        // Hover previews never move focus, wherever the cursor is.
        assert_eq!(commit_focus_target(false, false, false), None);
        assert_eq!(commit_focus_target(false, true, false), None);
    }

    #[test]
    fn interactive_text_takes_focus_without_waiting_for_cursor_entry() {
        assert_eq!(
            commit_focus_target(true, false, true),
            Some(FocusTarget::Preview)
        );
        assert_eq!(
            commit_focus_target(true, true, true),
            Some(FocusTarget::Preview)
        );
        assert_eq!(commit_focus_target(false, false, true), None);
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

    fn eligible() -> Eligibility {
        Eligibility::Ready
    }

    #[test]
    fn entering_the_clipboard_from_anywhere_requests_focus_with_bounded_retries() {
        // Watch starts with the cursor outside every vPaste window.
        let mut watch = FocusWatch::new(None);
        assert_eq!(watch.pending(None), None);
        assert_eq!(
            watch.pending(Some(FocusTarget::Clipboard)),
            Some(FocusTarget::Clipboard)
        );
        watch.resolve(eligible());
        // Activation can be asynchronous: retry while focus has not arrived yet.
        for _ in 1..FOCUS_WATCH_ATTEMPTS {
            assert_eq!(
                watch.pending(Some(FocusTarget::Clipboard)),
                Some(FocusTarget::Clipboard)
            );
            watch.resolve(eligible());
        }
        // Never keeps fighting while the cursor rests inside the same window.
        assert_eq!(watch.pending(Some(FocusTarget::Clipboard)), None);
        // Leaving and re-entering arms it again.
        assert_eq!(watch.pending(None), None);
        assert_eq!(
            watch.pending(Some(FocusTarget::Clipboard)),
            Some(FocusTarget::Clipboard)
        );
    }

    #[test]
    fn focus_watch_stops_once_focus_arrived_or_the_move_is_not_allowed() {
        let mut watch = FocusWatch::new(None);
        assert!(watch.pending(Some(FocusTarget::Clipboard)).is_some());
        watch.resolve(Eligibility::AlreadyFocused);
        assert_eq!(watch.pending(Some(FocusTarget::Clipboard)), None);

        assert!(watch.pending(Some(FocusTarget::Preview)).is_some());
        watch.resolve(Eligibility::Blocked);
        assert_eq!(watch.pending(Some(FocusTarget::Preview)), None);
    }

    #[test]
    fn focus_watch_ignores_the_window_under_the_cursor_when_it_starts() {
        let mut watch = FocusWatch::new(Some(FocusTarget::Clipboard));
        assert_eq!(watch.pending(Some(FocusTarget::Clipboard)), None);
        assert_eq!(
            watch.pending(Some(FocusTarget::Preview)),
            Some(FocusTarget::Preview)
        );
    }

    #[test]
    fn clipboard_focus_returns_from_any_app_but_preview_only_within_vpaste() {
        let base = WatchState {
            clipboard_available: true,
            clipboard_foreground: false,
            preview_follows: true,
            preview_foreground: false,
            vpaste_foreground: false,
        };
        // Another app (or nothing) has focus: the clipboard still takes it back.
        assert_eq!(
            eligibility(FocusTarget::Clipboard, base),
            Eligibility::Ready
        );
        // A pinned/Space preview never steals focus from another app.
        assert_eq!(
            eligibility(FocusTarget::Preview, base),
            Eligibility::Blocked
        );
        let in_vpaste = WatchState {
            vpaste_foreground: true,
            ..base
        };
        assert_eq!(
            eligibility(FocusTarget::Preview, in_vpaste),
            Eligibility::Ready
        );
        assert_eq!(
            eligibility(
                FocusTarget::Clipboard,
                WatchState {
                    clipboard_foreground: true,
                    ..base
                }
            ),
            Eligibility::AlreadyFocused
        );
        assert_eq!(
            eligibility(
                FocusTarget::Clipboard,
                WatchState {
                    clipboard_available: false,
                    ..base
                }
            ),
            Eligibility::Blocked
        );
        assert_eq!(
            eligibility(
                FocusTarget::Preview,
                WatchState {
                    preview_follows: false,
                    ..in_vpaste
                }
            ),
            Eligibility::Blocked
        );
    }
}
