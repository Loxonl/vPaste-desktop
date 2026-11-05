//! AppKit implementation of the DEV native window experiment.

use std::cell::{Cell, OnceCell, RefCell};
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSAutoresizingMaskOptions, NSBackingStoreType, NSButton, NSColor,
    NSControlStateValueOn, NSFont, NSLayoutAttribute, NSSlider, NSStackView, NSSwitch,
    NSTextField, NSUserInterfaceLayoutOrientation, NSView, NSVisualEffectBlendingMode,
    NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow,
    NSWindowDelegate, NSWindowStyleMask,
};
use objc2_foundation::{
    ns_string, NSEdgeInsets, NSNotification, NSObject, NSObjectProtocol, NSPoint, NSRect,
    NSSize, NSString,
};

use super::{describe_text, interaction_label, opacity_for_slider, opacity_label};

/// Same level as the DEV memory monitor: above vPaste popups (101/102).
const FLOATING_LEVEL: isize = 103;
const NORMAL_LEVEL: isize = 0;
const WINDOW_SIZE: NSSize = NSSize::new(440.0, 340.0);
const CONTENT_WIDTH: f64 = 380.0;

/// Mirrors the window's key state for the clipboard blur-hide guard,
/// which runs off the main thread.
static KEY_WINDOW: AtomicBool = AtomicBool::new(false);

thread_local! {
    static CONTROLLER: RefCell<Option<Retained<Controller>>> = const { RefCell::new(None) };
}

pub(crate) fn is_key_window() -> bool {
    KEY_WINDOW.load(Ordering::SeqCst)
}

/// Shows the window, creating it on first use. Reopening after close
/// reuses the same window and keeps its state. Must run on the main thread.
pub(crate) fn show() {
    let Some(mtm) = MainThreadMarker::new() else {
        log::error!("native demo window must be created on the main thread");
        return;
    };
    let controller = CONTROLLER.with(|slot| {
        slot.borrow_mut()
            .get_or_insert_with(|| Controller::new(mtm))
            .clone()
    });
    controller.present(mtm);
}

#[derive(Default)]
struct Ivars {
    window: OnceCell<Retained<NSWindow>>,
    input: OnceCell<Retained<NSTextField>>,
    result: OnceCell<Retained<NSTextField>>,
    slider: OnceCell<Retained<NSSlider>>,
    opacity: OnceCell<Retained<NSTextField>>,
    on_top: OnceCell<Retained<NSSwitch>>,
    counter: OnceCell<Retained<NSTextField>>,
    interactions: Cell<u32>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and `Controller`
    // does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VPasteNativeDemoController"]
    #[ivars = Ivars]
    struct Controller;

    // SAFETY: Selector signatures match the AppKit action convention.
    impl Controller {
        #[unsafe(method(processText:))]
        fn process_text(&self, _sender: Option<&AnyObject>) {
            let ivars = self.ivars();
            let text = ivars
                .input
                .get()
                .map(|input| input.stringValue().to_string())
                .unwrap_or_default();
            if let Some(result) = ivars.result.get() {
                result.setStringValue(&NSString::from_str(&describe_text(&text)));
            }
            self.record_interaction();
        }

        #[unsafe(method(sliderChanged:))]
        fn slider_changed(&self, _sender: Option<&AnyObject>) {
            let ivars = self.ivars();
            let Some(slider) = ivars.slider.get() else { return };
            let opacity = opacity_for_slider(slider.doubleValue());
            if let Some(window) = ivars.window.get() {
                window.setAlphaValue(opacity);
            }
            if let Some(label) = ivars.opacity.get() {
                label.setStringValue(&NSString::from_str(&opacity_label(opacity)));
            }
            self.record_interaction();
        }

        #[unsafe(method(toggleOnTop:))]
        fn toggle_on_top(&self, _sender: Option<&AnyObject>) {
            let ivars = self.ivars();
            let on_top = ivars
                .on_top
                .get()
                .is_some_and(|switch| switch.state() == NSControlStateValueOn);
            if let Some(window) = ivars.window.get() {
                window.setLevel(if on_top { FLOATING_LEVEL } else { NORMAL_LEVEL });
            }
            self.record_interaction();
        }
    }

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for Controller {}

    // SAFETY: NSWindowDelegate has no safety requirements.
    unsafe impl NSWindowDelegate for Controller {
        #[unsafe(method(windowDidBecomeKey:))]
        fn window_did_become_key(&self, _notification: &NSNotification) {
            KEY_WINDOW.store(true, Ordering::SeqCst);
        }

        #[unsafe(method(windowDidResignKey:))]
        fn window_did_resign_key(&self, _notification: &NSNotification) {
            KEY_WINDOW.store(false, Ordering::SeqCst);
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            KEY_WINDOW.store(false, Ordering::SeqCst);
        }
    }
);

impl Controller {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars::default());
        // SAFETY: NSObject's `init` signature is correct.
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        this.build(mtm);
        this
    }

    fn present(&self, mtm: MainThreadMarker) {
        let Some(window) = self.ivars().window.get() else { return };
        if !window.isVisible() {
            window.center();
        }
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        window.makeKeyAndOrderFront(None);
    }

    fn record_interaction(&self) {
        let ivars = self.ivars();
        let count = ivars.interactions.get().saturating_add(1);
        ivars.interactions.set(count);
        if let Some(counter) = ivars.counter.get() {
            counter.setStringValue(&NSString::from_str(&interaction_label(count)));
        }
    }

    fn build(&self, mtm: MainThreadMarker) {
        let target: &AnyObject = self;
        let ivars = self.ivars();

        let title = NSTextField::labelWithString(ns_string!("原生 AppKit 窗口"), mtm);
        title.setFont(Some(&NSFont::boldSystemFontOfSize(18.0)));
        let subtitle = NSTextField::labelWithString(
            ns_string!("由 Rust 通过 objc2 直接创建，不经过 WebView"),
            mtm,
        );
        subtitle.setTextColor(Some(&NSColor::secondaryLabelColor()));

        let input = NSTextField::textFieldWithString(ns_string!(""), mtm);
        input.setPlaceholderString(Some(ns_string!("输入文字后按回车或点按钮")));
        // SAFETY: `processText:` is defined on `Controller`, which outlives the control.
        unsafe {
            input.setTarget(Some(target));
            input.setAction(Some(sel!(processText:)));
        }
        input.widthAnchor().constraintEqualToConstant(240.0).setActive(true);
        // SAFETY: as above.
        let button = unsafe {
            NSButton::buttonWithTitle_target_action(
                ns_string!("交给 Rust 处理"),
                Some(target),
                Some(sel!(processText:)),
                mtm,
            )
        };
        let input_row = horizontal_row(mtm, &[&input, &button]);

        let result = NSTextField::wrappingLabelWithString(ns_string!("结果会显示在这里"), mtm);
        result.widthAnchor().constraintEqualToConstant(CONTENT_WIDTH).setActive(true);

        // SAFETY: as above.
        let slider = unsafe {
            NSSlider::sliderWithValue_minValue_maxValue_target_action(
                100.0,
                super::MIN_OPACITY_PERCENT,
                100.0,
                Some(target),
                Some(sel!(sliderChanged:)),
                mtm,
            )
        };
        slider.setContinuous(true);
        slider.widthAnchor().constraintEqualToConstant(200.0).setActive(true);
        let opacity = NSTextField::labelWithString(
            &NSString::from_str(&opacity_label(1.0)),
            mtm,
        );
        let slider_row = horizontal_row(mtm, &[&slider, &opacity]);

        let on_top = NSSwitch::new(mtm);
        on_top.setState(NSControlStateValueOn);
        // SAFETY: as above.
        unsafe {
            on_top.setTarget(Some(target));
            on_top.setAction(Some(sel!(toggleOnTop:)));
        }
        let on_top_label = NSTextField::labelWithString(ns_string!("保持在最前"), mtm);
        let on_top_row = horizontal_row(mtm, &[&on_top, &on_top_label]);

        let counter = NSTextField::labelWithString(
            &NSString::from_str(&interaction_label(0)),
            mtm,
        );
        counter.setTextColor(Some(&NSColor::secondaryLabelColor()));

        let stack = NSStackView::new(mtm);
        stack.setOrientation(NSUserInterfaceLayoutOrientation::Vertical);
        stack.setAlignment(NSLayoutAttribute::Leading);
        stack.setSpacing(14.0);
        // Top inset clears the transparent full-size title bar.
        stack.setEdgeInsets(NSEdgeInsets {
            top: 44.0,
            left: 28.0,
            bottom: 24.0,
            right: 28.0,
        });
        for view in [
            &*title as &NSView,
            &subtitle,
            &input_row,
            &result,
            &slider_row,
            &on_top_row,
            &counter,
        ] {
            stack.addArrangedSubview(view);
        }

        let frame = NSRect::new(NSPoint::new(0.0, 0.0), WINDOW_SIZE);
        let background = NSVisualEffectView::new(mtm);
        background.setFrame(frame);
        background.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
        background.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        background.setState(NSVisualEffectState::Active);
        stack.setFrame(frame);
        stack.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        background.addSubview(&stack);

        // SAFETY: release-on-close is disabled right after creation; the
        // controller keeps the only owning reference.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Titled
                    | NSWindowStyleMask::Closable
                    | NSWindowStyleMask::Miniaturizable
                    | NSWindowStyleMask::Resizable
                    | NSWindowStyleMask::FullSizeContentView,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setTitle(ns_string!("vPaste 原生窗口实验"));
        window.setTitlebarAppearsTransparent(true);
        window.setContentView(Some(&background));
        window.setContentMinSize(WINDOW_SIZE);
        window.setLevel(FLOATING_LEVEL);
        window.setInitialFirstResponder(Some(&input));
        window.setDelegate(Some(ProtocolObject::from_ref(self)));

        let _ = ivars.input.set(input);
        let _ = ivars.result.set(result);
        let _ = ivars.slider.set(slider);
        let _ = ivars.opacity.set(opacity);
        let _ = ivars.on_top.set(on_top);
        let _ = ivars.counter.set(counter);
        let _ = ivars.window.set(window);
    }
}

fn horizontal_row(mtm: MainThreadMarker, views: &[&NSView]) -> Retained<NSStackView> {
    let row = NSStackView::new(mtm);
    row.setOrientation(NSUserInterfaceLayoutOrientation::Horizontal);
    row.setSpacing(10.0);
    for view in views {
        row.addArrangedSubview(view);
    }
    row
}
