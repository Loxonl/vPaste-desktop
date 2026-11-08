//! Native main-surface geometry and ownership for the shared preview pipeline.
use crate::{preview_behavior::PreviewMode, preview_motion::PreviewRect, ScreenBounds};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::AppHandle;

#[derive(Clone, Copy)]
pub(crate) struct Surface {
    pub(crate) bounds: ScreenBounds,
    pub(crate) rect: PreviewRect,
}
impl Surface {
    pub(crate) fn from_local(bounds: ScreenBounds, frame: [f64; 4]) -> Option<Self> {
        if !frame.iter().all(|value| value.is_finite()) || frame[2] <= 0.0 || frame[3] <= 0.0 {
            return None;
        }
        Some(Self {
            bounds,
            rect: PreviewRect {
                x: bounds.x + frame[0],
                y: bounds.y + frame[1],
                width: frame[2],
                height: frame[3],
            },
        })
    }
    pub(crate) fn preview_area(self, gap: f64) -> ScreenBounds {
        ScreenBounds {
            height: (self.rect.y - self.bounds.y - gap).clamp(0.0, self.bounds.height),
            ..self.bounds
        }
    }
    pub(crate) fn contains(self, x: i32, y: i32) -> bool {
        crate::preview_focus::rect_contains_point(
            (self.rect.x, self.rect.y, self.rect.width, self.rect.height),
            self.bounds.scale_factor,
            (x, y),
        )
    }
}
static SURFACE: Mutex<Option<Surface>> = Mutex::new(None);
static INTERACTIVE: AtomicBool = AtomicBool::new(false);
static OWNED: AtomicBool = AtomicBool::new(false);
static HOVER: AtomicBool = AtomicBool::new(false);
static REQUEST: AtomicU64 = AtomicU64::new(0);

pub(super) fn prepare(bounds: ScreenBounds, height: f64, interactive: bool) {
    INTERACTIVE.store(interactive, Ordering::Release);
    *SURFACE.lock().unwrap_or_else(|e| e.into_inner()) = Surface::from_local(
        bounds,
        [
            -crate::CLIPBOARD_HORIZONTAL_BLEED,
            bounds.height - height,
            bounds.width + crate::CLIPBOARD_HORIZONTAL_BLEED * 2.0,
            height,
        ],
    );
}
pub(super) fn publish(frame: [f64; 4]) {
    let mut value = SURFACE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(surface) = *value {
        *value = Surface::from_local(surface.bounds, frame);
    }
}
pub(crate) fn active() -> bool {
    super::ACTIVE.load(Ordering::Acquire) && INTERACTIVE.load(Ordering::Acquire)
}
pub(crate) fn surface() -> Option<Surface> {
    active()
        .then(|| *SURFACE.lock().unwrap_or_else(|e| e.into_inner()))
        .flatten()
}
pub(crate) fn cursor_inside() -> bool {
    surface()
        .zip(crate::cursor_physical_position())
        .is_some_and(|(surface, point)| surface.contains(point.x, point.y))
}
pub(crate) fn focus(app: &AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        if active() {
            // SAFETY: AppKit thread; activate preserves the existing controller/selection.
            unsafe { super::vpaste_native_panel_activate(false) };
        }
    })
    .map_err(|error| error.to_string())
}
pub(crate) fn hide(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        // SAFETY: AppKit thread; completion disposes this native reader only.
        unsafe { super::vpaste_native_panel_close(true) };
    });
}
pub(crate) fn current(request: u64) -> bool {
    active() && REQUEST.load(Ordering::Acquire) == request
}

// Serialize the native intent and the shared render generation under the same
// lock used by preview preparation. A stale queued worker cannot start later
// and supersede a newer selection or resurrect a dismissed hover.
pub(super) fn reserve(mode: PreviewMode) -> u64 {
    let mut pending = crate::PREVIEW_PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let request = REQUEST.fetch_add(1, Ordering::AcqRel) + 1;
    OWNED.store(true, Ordering::Release);
    HOVER.store(mode == PreviewMode::Hover, Ordering::Release);
    crate::PREVIEW_REQUESTS.begin();
    crate::PREVIEW_HOVER.store(mode == PreviewMode::Hover, Ordering::SeqCst);
    *pending = None;
    request
}
pub(crate) fn closed() {
    REQUEST.fetch_add(1, Ordering::AcqRel);
    OWNED.store(false, Ordering::Release);
    HOVER.store(false, Ordering::Release);
}
pub(super) fn dismiss_hover(app: &AppHandle, request: Option<u64>) -> Result<(), String> {
    {
        let mut pending = crate::PREVIEW_PENDING
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if HOVER.swap(false, Ordering::AcqRel) {
            REQUEST.fetch_add(1, Ordering::AcqRel);
            crate::PREVIEW_REQUESTS.cancel();
            *pending = None;
        }
    }
    crate::dismiss_hover_preview_window(app.clone(), request)
}
pub(super) fn close_owned(app: &AppHandle) -> Result<(), String> {
    if OWNED.load(Ordering::Acquire) {
        crate::retain_preview_window(app)?;
    }
    Ok(())
}
pub(super) fn dispose(app: Option<&AppHandle>) {
    INTERACTIVE.store(false, Ordering::Release);
    *SURFACE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let owned = OWNED.swap(false, Ordering::AcqRel);
    closed();
    if owned {
        if crate::PREVIEW_PINNED.load(Ordering::SeqCst) {
            // Match WebView main-panel hide: keep the explicit pinned reader,
            // but never allow queued work from its closed native owner to commit.
            crate::cancel_preview_content();
        } else if let Some(app) = app {
            let _ = crate::retain_preview_window(app);
        }
    }
}
pub(crate) fn route(event: serde_json::Value) -> bool {
    if !active() {
        return false;
    }
    super::deliver(super::SESSION.load(Ordering::Acquire), event);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_surface_keeps_preview_above_the_real_panel_on_scaled_negative_screens() {
        for scale in [1.0, 1.5, 2.0] {
            let bounds = crate::ScreenBounds {
                x: -1920.0,
                y: -200.0,
                width: 1920.0,
                height: 1080.0,
                scale_factor: scale,
            };
            let surface = Surface::from_local(bounds, [-12.0, 778.0, 1944.0, 302.0]).unwrap();
            assert_eq!(surface.rect.y, 578.0);
            let area = surface.preview_area(16.0);
            assert_eq!(area.y + area.height + 16.0, surface.rect.y);
            assert!(surface.contains((-1900.0 * scale) as i32, (600.0 * scale) as i32));
            assert!(!surface.contains((100.0 * scale) as i32, (600.0 * scale) as i32));
        }
    }

    #[test]
    fn native_surface_rejects_invalid_frames_and_does_not_overlap_on_small_screens() {
        let bounds = crate::ScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 400.0,
            scale_factor: 2.0,
        };
        let surface = Surface::from_local(bounds, [-12.0, 98.0, 824.0, 302.0]).unwrap();
        assert_eq!(surface.preview_area(16.0).height, 82.0);
        assert!(Surface::from_local(bounds, [0.0, 0.0, f64::NAN, 300.0]).is_none());
        assert!(Surface::from_local(bounds, [0.0, 0.0, 800.0, 0.0]).is_none());
    }
}
