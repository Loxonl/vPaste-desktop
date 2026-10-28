use std::sync::atomic::{AtomicU64, Ordering};

/// The low bit records an active session; every request/close advances its version.
pub(crate) struct PreviewRequests(AtomicU64);

impl PreviewRequests {
    pub(crate) const fn new() -> Self {
        Self(AtomicU64::new(0))
    }

    pub(crate) fn begin(&self) -> u64 {
        let previous = self
            .0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                Some((value + 2) | 1)
            })
            .unwrap();
        (previous + 2) | 1
    }

    pub(crate) fn cancel(&self) {
        let _ = self
            .0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                Some((value + 2) & !1)
            });
    }

    pub(crate) fn active(&self) -> bool {
        self.0.load(Ordering::SeqCst) & 1 == 1
    }

    pub(crate) fn current(&self, request: u64) -> bool {
        request & 1 == 1 && self.0.load(Ordering::SeqCst) == request
    }

    /// Call while holding the pending-preview lock, shared with begin/cancel.
    pub(crate) fn should_discard_cancelled_window(&self, pinned: bool, visible: bool) -> bool {
        !self.active() && !pinned && !visible
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PreviewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PreviewRect {
    pub(crate) fn interpolate(self, target: Self, progress: f64) -> Self {
        let progress = progress.clamp(0.0, 1.0);
        Self {
            x: self.x + (target.x - self.x) * progress,
            y: self.y + (target.y - self.y) * progress,
            width: self.width + (target.width - self.width) * progress,
            height: self.height + (target.height - self.height) * progress,
        }
    }

    pub(crate) fn near(self, target: Self) -> bool {
        (self.x - target.x).abs() < 0.5
            && (self.y - target.y).abs() < 0.5
            && (self.width - target.width).abs() < 0.5
            && (self.height - target.height).abs() < 0.5
    }
}

/// Evaluate the CSS cubic-bezier supplied by the shared frontend Motion token.
pub(crate) fn eased_progress(progress: f64, easing: [f64; 4]) -> f64 {
    let progress = progress.clamp(0.0, 1.0);
    if progress == 0.0 || progress == 1.0 {
        return progress;
    }
    let coordinate = |t: f64, a: f64, b: f64| {
        3.0 * (1.0 - t).powi(2) * t * a + 3.0 * (1.0 - t) * t.powi(2) * b + t.powi(3)
    };
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..16 {
        let t = (low + high) / 2.0;
        if coordinate(t, easing[0], easing[2]) < progress {
            low = t;
        } else {
            high = t;
        }
    }
    coordinate((low + high) / 2.0, easing[1], easing[3])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_or_a_new_selection_invalidates_late_content_and_geometry() {
        let requests = PreviewRequests::new();
        let first = requests.begin();
        assert!(requests.active() && requests.current(first));
        let next = requests.begin();
        assert!(!requests.current(first));
        assert!(requests.current(next));
        requests.cancel();
        assert!(!requests.active() && !requests.current(next));
        let reopened = requests.begin();
        assert!(reopened > next && requests.current(reopened));
        assert!(!requests.current(next));
    }

    #[test]
    fn a_cancelled_cold_open_only_discards_an_idle_unpinned_window() {
        let requests = PreviewRequests::new();
        let cancelled = requests.begin();
        requests.cancel();
        assert!(!requests.current(cancelled));
        assert!(requests.should_discard_cancelled_window(false, false));
        assert!(!requests.should_discard_cancelled_window(true, false));
        // Pinning cancels preparation; unpinning must keep the displayed item.
        assert!(!requests.should_discard_cancelled_window(false, true));

        let newer = requests.begin();
        assert!(!requests.should_discard_cancelled_window(false, false));
        assert!(requests.current(newer));
        requests.cancel();
        assert!(requests.should_discard_cancelled_window(false, false));
    }

    #[test]
    fn retargeting_starts_from_the_current_rectangle_without_a_position_or_size_jump() {
        let start = PreviewRect {
            x: 100.0,
            y: 200.0,
            width: 800.0,
            height: 500.0,
        };
        let portrait = PreviewRect {
            x: 300.0,
            y: 120.0,
            width: 400.0,
            height: 700.0,
        };
        let current = start.interpolate(portrait, 0.4);
        assert_eq!(current.interpolate(start, 0.0), current);
        assert_eq!(current.interpolate(start, 1.0), start);
        assert!(current.width < start.width && current.height > start.height);
        assert!(start.near(start));
        assert!(!start.near(portrait));
    }

    #[test]
    fn shared_easing_has_exact_endpoints_and_moves_continuously_towards_the_target() {
        let easing = [0.22, 1.0, 0.36, 1.0];
        assert_eq!(eased_progress(0.0, easing), 0.0);
        assert_eq!(eased_progress(1.0, easing), 1.0);
        let values: Vec<_> = (0..=100)
            .map(|i| eased_progress(i as f64 / 100.0, easing))
            .collect();
        assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(eased_progress(0.5, easing) > 0.5);
    }
}
