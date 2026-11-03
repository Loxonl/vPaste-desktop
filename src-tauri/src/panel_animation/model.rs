//! Parameters recovered from the reference app, shared by both native backends.

pub(crate) const SHOW_DURATION_MS: u64 = 150;
pub(crate) const HIDE_DURATION_MS: u64 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Animation {
    Show,
    Hide,
}

impl Animation {
    pub(crate) fn easing(self) -> [f64; 4] {
        match self {
            Self::Show => [0.2, 0.8, 0.2, 1.0],
            Self::Hide => [0.42, 0.0, 0.58, 1.0],
        }
    }

    #[cfg(any(test, not(target_os = "macos")))]
    pub(crate) fn progress(self, progress: f64) -> f64 {
        crate::preview_motion::eased_progress(progress, self.easing())
    }

    #[cfg(any(test, target_os = "macos"))]
    pub(crate) fn target_fraction(self) -> f64 {
        match self {
            Self::Show => 0.0,
            Self::Hide => 1.0,
        }
    }
}

pub(crate) fn may_complete_show(request: u64, current: u64, visible: bool, hiding: bool) -> bool {
    request == current && visible && !hiding
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_completion_cannot_reactivate_a_parked_or_reversing_panel() {
        assert!(may_complete_show(7, 7, true, false));
        assert!(!may_complete_show(7, 8, true, false));
        assert!(!may_complete_show(7, 7, false, false));
        assert!(!may_complete_show(7, 7, true, true));
    }

    #[test]
    fn opening_matches_the_recovered_timing_function() {
        assert_eq!(SHOW_DURATION_MS, 150);
        // Independent samples of cubic-bezier(0.2, 0.8, 0.2, 1.0).
        for (time, expected) in [(0.1, 0.39669355), (0.25, 0.76728430), (0.5, 0.94607946)] {
            assert!((Animation::Show.progress(time) - expected).abs() < 0.0001);
        }
    }

    #[test]
    fn closing_slows_before_reaching_the_screen_edge() {
        assert_eq!(HIDE_DURATION_MS, 200);
        assert!((Animation::Hide.progress(0.5) - 0.5).abs() < 0.0001);
        let beginning = Animation::Hide.progress(0.1);
        let middle = Animation::Hide.progress(0.6) - Animation::Hide.progress(0.5);
        let ending = 1.0 - Animation::Hide.progress(0.9);
        assert!(beginning < middle && ending < middle);
        assert!((beginning - ending).abs() < 0.0001);
    }

    #[test]
    fn both_native_backends_receive_monotonic_curves_with_exact_endpoints() {
        for animation in [Animation::Show, Animation::Hide] {
            assert_eq!(animation.progress(-1.0), 0.0);
            assert_eq!(animation.progress(1.1), 1.0);
            let samples: Vec<_> = (0..=100)
                .map(|i| animation.progress(i as f64 / 100.0))
                .collect();
            assert!(samples.windows(2).all(|pair| pair[0] <= pair[1]));
        }
        assert_eq!(Animation::Show.target_fraction(), 0.0);
        assert_eq!(Animation::Hide.target_fraction(), 1.0);
    }
}
