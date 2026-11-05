// Swift version of the DEV native window experiment.
//
// Rust owns the process and the main thread. It calls the C entry point
// `vpaste_native_demo_show` on the main thread; this file only builds the
// AppKit UI and forwards every interaction to the Rust callback table
// declared in ../NativeDemoBridge.h.

import AppKit

@MainActor
private final class NativeDemoController: NSObject, NSWindowDelegate {
    private static let floatingLevel = NSWindow.Level(rawValue: 103)

    private let rust: VPasteRustCallbacks
    private let window: NSWindow
    private let input = NSTextField(string: "")
    private let result = NSTextField(wrappingLabelWithString: "结果会显示在这里")
    private let slider: NSSlider
    private let opacityLabel = NSTextField(labelWithString: "")
    private let onTop = NSSwitch()
    private let counter = NSTextField(labelWithString: "")
    private var interactions: UInt32 = 0

    init(rust: VPasteRustCallbacks) {
        self.rust = rust
        slider = NSSlider(value: 100, minValue: rust.min_opacity_percent, maxValue: 100,
                          target: nil, action: nil)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 340),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        super.init()
        build()
    }

    func present() {
        if !window.isVisible {
            window.center()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let title = NSTextField(labelWithString: "原生 AppKit 窗口（Swift）")
        title.font = .boldSystemFont(ofSize: 18)
        let subtitle = NSTextField(labelWithString: "由 Swift 编写，Rust 主线程通过 C 接口调用")
        subtitle.textColor = .secondaryLabelColor

        input.placeholderString = "输入文字后按回车或点按钮"
        input.target = self
        input.action = #selector(processText(_:))
        input.widthAnchor.constraint(equalToConstant: 240).isActive = true
        let button = NSButton(title: "交给 Rust 处理", target: self, action: #selector(processText(_:)))

        result.widthAnchor.constraint(equalToConstant: 380).isActive = true

        slider.target = self
        slider.action = #selector(sliderChanged(_:))
        slider.isContinuous = true
        slider.widthAnchor.constraint(equalToConstant: 200).isActive = true
        opacityLabel.stringValue = rustString(rust.opacity_label(1.0))

        onTop.state = .on
        onTop.target = self
        onTop.action = #selector(toggleOnTop(_:))

        counter.stringValue = rustString(rust.interaction_label(0))
        counter.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [
            title,
            subtitle,
            row(input, button),
            result,
            row(slider, opacityLabel),
            row(onTop, NSTextField(labelWithString: "保持在最前")),
            counter,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 44, left: 28, bottom: 24, right: 28)
        stack.frame = window.contentLayoutRect
        stack.autoresizingMask = [.width, .height]

        let background = NSVisualEffectView(frame: stack.frame)
        background.material = .underWindowBackground
        background.blendingMode = .behindWindow
        background.state = .active
        background.addSubview(stack)

        window.isReleasedWhenClosed = false
        window.title = "vPaste 原生窗口实验（Swift）"
        window.titlebarAppearsTransparent = true
        window.contentView = background
        window.contentMinSize = NSSize(width: 440, height: 340)
        window.level = Self.floatingLevel
        window.initialFirstResponder = input
        window.delegate = self
    }

    private func row(_ views: NSView...) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.spacing = 10
        return row
    }

    @objc private func processText(_ sender: Any?) {
        result.stringValue = input.stringValue.withCString { rustString(rust.describe_text($0)) }
        recordInteraction()
    }

    @objc private func sliderChanged(_ sender: Any?) {
        let opacity = rust.opacity_for_slider(slider.doubleValue)
        window.alphaValue = opacity
        opacityLabel.stringValue = rustString(rust.opacity_label(opacity))
        recordInteraction()
    }

    @objc private func toggleOnTop(_ sender: Any?) {
        window.level = onTop.state == .on ? Self.floatingLevel : .normal
        recordInteraction()
    }

    private func recordInteraction() {
        interactions &+= 1
        counter.stringValue = rustString(rust.interaction_label(interactions))
    }

    /// Copies a Rust-owned string and hands it back to Rust for release.
    private func rustString(_ pointer: UnsafeMutablePointer<CChar>?) -> String {
        guard let pointer else { return "" }
        defer { rust.free_string(pointer) }
        return String(cString: pointer)
    }

    func windowDidBecomeKey(_ notification: Notification) { rust.set_key_window(true) }
    func windowDidResignKey(_ notification: Notification) { rust.set_key_window(false) }
    func windowWillClose(_ notification: Notification) { rust.set_key_window(false) }
}

@MainActor private var controller: NativeDemoController?

/// Shows the window, creating it on first use. Rust must call this on the
/// main thread; `callbacks` only needs to be valid for the duration of the
/// call because Swift copies the table.
@_cdecl("vpaste_native_demo_show")
public func vpasteNativeDemoShow(_ callbacks: UnsafePointer<VPasteRustCallbacks>) {
    let table = callbacks.pointee
    MainActor.assumeIsolated {
        if controller == nil {
            controller = NativeDemoController(rust: table)
        }
        controller?.present()
    }
}
