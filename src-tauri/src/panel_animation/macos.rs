//! AppKit owns the content-view animation; the host window stays bottom-docked.

use std::sync::atomic::Ordering;
use std::time::Duration;

use cocoa::base::{id, nil, BOOL, YES};
use cocoa::foundation::{NSPoint, NSRect, NSString};
use objc::{class, msg_send, sel, sel_impl};

use super::model::Animation;

pub(crate) fn is_main_thread() -> bool {
    unsafe { msg_send![class!(NSThread), isMainThread] }
}

/// Call before taking the transition lock; waiting for the UI while holding it
/// can deadlock a focus or shortcut event which needs that same lock.
pub(crate) fn on_main<R: Send + 'static>(
    window: &tauri::WebviewWindow,
    action: impl FnOnce(tauri::WebviewWindow) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    if is_main_thread() {
        return action(window.clone());
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let owned = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(action(owned));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?
}

unsafe fn content(window: &tauri::WebviewWindow) -> Result<id, String> {
    if !is_main_thread() {
        return Err("Main-panel content must be accessed on the AppKit thread".into());
    }
    let native = window.ns_window().map_err(|error| error.to_string())? as id;
    let root: id = msg_send![native, contentView];
    if root == nil {
        return Err("Main panel has no content view".into());
    }
    // NSWindow and Tao manage the root frame during resize/docking. Keep that
    // root intact and animate one stable child containing both the WebView and
    // vibrancy view. Reuse it; no extra container is allocated per transition.
    let marker = NSString::alloc(nil).init_str("vpaste-main-panel-animation");
    let subviews: id = msg_send![root, subviews];
    let children: id = msg_send![subviews, copy];
    let count: usize = msg_send![children, count];
    let mut view = nil;
    for index in 0..count {
        let child: id = msg_send![children, objectAtIndex:index];
        let identifier: id = msg_send![child, identifier];
        if identifier != nil {
            let matches: BOOL = msg_send![identifier, isEqualToString:marker];
            if matches == YES {
                view = child;
                break;
            }
        }
    }
    if view == nil {
        let bounds: NSRect = msg_send![root, bounds];
        let allocated: id = msg_send![class!(NSView), alloc];
        view = msg_send![allocated, initWithFrame:bounds];
        let _: () = msg_send![view, setIdentifier:marker];
        let _: () = msg_send![view, setAutoresizingMask:18usize];
        let _: () = msg_send![root, addSubview:view];
        let _: () = msg_send![view, release];
    }
    // A native effect installed after initial WebView creation joins the same
    // surface too, preserving the existing glass appearance while it moves.
    for index in 0..count {
        let child: id = msg_send![children, objectAtIndex:index];
        if child != view {
            let _: id = msg_send![child, retain];
            let _: () = msg_send![child, removeFromSuperview];
            let _: () = msg_send![view, addSubview:child];
            let _: () = msg_send![child, release];
        }
    }
    let _: () = msg_send![children, release];
    let _: () = msg_send![marker, release];
    Ok(view)
}

#[cfg(debug_assertions)]
pub(crate) fn content_frame(window: &tauri::WebviewWindow) -> Result<NSRect, String> {
    unsafe {
        let view = content(window)?;
        Ok(msg_send![view, frame])
    }
}

#[cfg(debug_assertions)]
pub(crate) fn debug_geometry(window: &tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    unsafe {
        let view = content(window)?;
        let parent: id = msg_send![view, superview];
        let frame: NSRect = msg_send![view, frame];
        let parent_frame: NSRect = msg_send![parent, frame];
        let flipped: BOOL = msg_send![parent, isFlipped];
        let layer: id = msg_send![view, layer];
        let presentation: id = if layer == nil {
            nil
        } else {
            msg_send![layer, presentationLayer]
        };
        let presented = if presentation == nil {
            serde_json::Value::Null
        } else {
            let frame: NSRect = msg_send![presentation, frame];
            serde_json::json!({"x":frame.origin.x,"y":frame.origin.y,"height":frame.size.height})
        };
        let animations: id = if layer == nil {
            nil
        } else {
            msg_send![layer, animationKeys]
        };
        let count: usize = if animations == nil {
            0
        } else {
            msg_send![animations, count]
        };
        let children: id = msg_send![parent, subviews];
        let child_count: usize = msg_send![children, count];
        Ok(
            serde_json::json!({"modelY":frame.origin.y,"height":frame.size.height,"parentY":parent_frame.origin.y,
            "parentHeight":parent_frame.size.height,"parentFlipped":flipped==YES,"presentation":presented,"animations":count,"rootChildren":child_count}),
        )
    }
}

/// Read the presentation layer before replacing an in-flight transition. The
/// model frame already contains the old animation's final position.
pub(crate) fn current_fraction(window: &tauri::WebviewWindow) -> Result<f64, String> {
    unsafe {
        let view = content(window)?;
        let frame: NSRect = msg_send![view, frame];
        let layer: id = msg_send![view, layer];
        let presentation: id = if layer == nil {
            nil
        } else {
            msg_send![layer, presentationLayer]
        };
        let y = if presentation == nil {
            frame.origin.y
        } else {
            let presented: NSRect = msg_send![presentation, frame];
            presented.origin.y
        };
        Ok(if frame.size.height > 0.0 {
            (-y / frame.size.height).clamp(0.0, 1.0)
        } else {
            0.0
        })
    }
}

pub(crate) fn set_fraction(window: &tauri::WebviewWindow, fraction: f64) -> Result<(), String> {
    unsafe {
        let view = content(window)?;
        let _: () = msg_send![view, setWantsLayer:YES];
        let _: () = msg_send![class!(CATransaction), begin];
        let _: () = msg_send![class!(CATransaction), setDisableActions:YES];
        let layer: id = msg_send![view, layer];
        if layer != nil {
            let _: () = msg_send![layer, removeAllAnimations];
        }
        let parent: id = msg_send![view, superview];
        if parent != nil {
            let supported: BOOL = msg_send![parent, respondsToSelector:sel!(setClipsToBounds:)];
            if supported == YES {
                let _: () = msg_send![parent, setClipsToBounds:YES];
            } else {
                let _: () = msg_send![parent, setWantsLayer:YES];
                let parent_layer: id = msg_send![parent, layer];
                if parent_layer != nil {
                    let _: () = msg_send![parent_layer, setMasksToBounds:YES];
                }
            }
        }
        let frame: NSRect = msg_send![view, frame];
        let mut frame = frame;
        frame.origin = NSPoint::new(0.0, -frame.size.height * fraction.clamp(0.0, 1.0));
        let _: () = msg_send![view, setFrame:frame];
        let _: () = msg_send![class!(CATransaction), commit];
    }
    Ok(())
}

unsafe fn timing_function(animation: Animation) -> Result<id, String> {
    let easing = animation.easing();
    // objc 0.2's msg_send! macro cannot spell the three unnamed selector
    // components. Its checked message dispatcher supports the exact selector.
    objc::__send_message(
        class!(CAMediaTimingFunction),
        objc::runtime::Sel::register("functionWithControlPoints::::"),
        (
            easing[0] as f32,
            easing[1] as f32,
            easing[2] as f32,
            easing[3] as f32,
        ),
    )
    .map_err(|error| error.to_string())
}

/// Wait only on the animation worker. All view operations and completion
/// delivery are owned by AppKit, without per-frame Rust timers.
pub(crate) fn animate(
    window: &tauri::WebviewWindow,
    animation: Animation,
    duration_ms: u64,
    generation: u64,
) -> Result<bool, String> {
    if is_main_thread() {
        return Err("The native animation completion must be awaited off the UI thread".into());
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let setup_sender = sender.clone();
    let owned = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| unsafe {
                if crate::CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) != generation {
                    let _ = sender.send(Ok(false));
                    return Ok(());
                }
                let view = content(&owned)?;
                if crate::system_reduces_motion() {
                    set_fraction(&owned, animation.target_fraction())?;
                    let _ = sender.send(Ok(true));
                    return Ok(());
                }
                let frame: NSRect = msg_send![view, frame];
                let mut target = frame;
                target.origin = NSPoint::new(0.0, -frame.size.height * animation.target_fraction());
                let timing = timing_function(animation)?;
                let layer: id = msg_send![view, layer];
                let presentation: id = msg_send![layer, presentationLayer];
                let start: NSPoint = if animation == Animation::Hide && presentation != nil {
                    msg_send![presentation, position]
                } else {
                    msg_send![layer, position]
                };
                let complete = block::ConcreteBlock::new(move || {
                    let current =
                        crate::CLIPBOARD_WINDOW_GENERATION.load(Ordering::SeqCst) == generation;
                    let _ = sender.send(Ok(current));
                })
                .copy();
                let _: () = msg_send![class!(CATransaction), begin];
                let _: () = msg_send![class!(CATransaction), setDisableActions:YES];
                let _: () = msg_send![class!(CATransaction), setCompletionBlock:&*complete];
                let _: () = msg_send![view, setFrame:target];
                let end: NSPoint = msg_send![layer, position];
                let key = NSString::alloc(nil).init_str("position");
                let transition: id = msg_send![class!(CABasicAnimation), animationWithKeyPath:key];
                let from: id = msg_send![class!(NSValue), valueWithPoint:start];
                let to: id = msg_send![class!(NSValue), valueWithPoint:end];
                let _: () = msg_send![transition, setFromValue:from];
                let _: () = msg_send![transition, setToValue:to];
                let _: () = msg_send![transition, setDuration:duration_ms as f64 / 1000.0];
                let _: () = msg_send![transition, setTimingFunction:timing];
                // A parked window retains an old presentation layer. An explicit
                // start value prevents AppKit from treating a fresh show as 0 -> 0
                // before its off-screen origin has reached the render server.
                let _: () = msg_send![layer, addAnimation:transition forKey:key];
                let _: () = msg_send![key, release];
                let _: () = msg_send![class!(CATransaction), commit];
                Ok(())
            })();
            if let Err(error) = result {
                let _ = setup_sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?
}
