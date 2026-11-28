import AppKit
import SwiftUI

struct PanelOnboardingMotion: Decodable {
  struct Durations: Decodable { let quick: Double; let fast: Double; let standard: Double; let slow: Double }
  struct Distances: Decodable { let subtle: Double; let standard: Double; let emphasis: Double }
  struct Easing: Decodable { let enter: [Double]; let exit: [Double]; let standard: [Double] }
  let duration: Durations
  let distance: Distances
  let easing: Easing
  static let standard = Self(duration: .init(quick: 0.12, fast: 0.18, standard: 0.24, slow: 0.32),
    distance: .init(subtle: 6, standard: 10, emphasis: 16),
    easing: .init(enter: [0.22, 1, 0.36, 1], exit: [0.4, 0, 1, 1], standard: [0.4, 0, 0.2, 1]))
  var welcomeDuration: Double { max(duration.slow, duration.quick + duration.standard) + 0.9 + duration.standard }
  var shortcutDuration: Double { 3 * duration.slow + duration.fast }
  func curve(_ points: [Double], _ duration: Double) -> Animation {
    guard points.count == 4 else { return .linear(duration: duration) }
    return .timingCurve(points[0], points[1], points[2], points[3], duration: duration)
  }
}
struct PanelOnboardingPermissions: Decodable {
  struct Permission: Decodable { let done: Bool }
  let background: Permission
  let paste: Permission
}
struct PanelOnboardingState: Decodable {
  let id: UInt64
  let revision: UInt64
  let step: Int
  let filters: [Bool]
  let shortcut: String
  let assets: [String: String]
  let permissions: PanelOnboardingPermissions
  let motion: PanelOnboardingMotion
}

@MainActor
final class PanelOnboardingModel: ObservableObject {
  @Published private(set) var state: PanelOnboardingState
  @Published var entered = false
  @Published var copyEntered = false
  @Published var items = Array(repeating: false, count: 5)
  @Published var welcomeLeaving = false
  @Published var keyScale: CGFloat = 1
  @Published var keyY: CGFloat = 0
  @Published var pulseScale: CGFloat = 0.94
  @Published var pulseOpacity: Double = 0
  @Published var successLift: CGFloat = 0
  @Published var successFlash: Double = 0
  @Published var successScale: CGFloat = 1
  @Published var successfulIDs: Set<String> = []
  @Published var busy = false
  @Published var message = ""
  let chinese: Bool
  let scale: CGFloat
  let images: [String: NSImage]
  var onAction: ((String, [String: Any]) -> Void)?
  private var work: [DispatchWorkItem] = []
  private var generation = 0
  private var closed = false
  private var reduced = false
  var scheduledCount: Int { work.count }
  init(state: PanelOnboardingState, chinese: Bool, scale: CGFloat) {
    self.state = state; self.chinese = chinese; self.scale = scale
    images = state.assets.compactMapValues { NSImage(contentsOfFile: $0) }
  }
  func local(_ en: String, _ zh: String) -> String { chinese ? zh : en }
  func filterTitle(_ index: Int) -> String {
    [local("📝 Text", "📝 文本"), local("🖼️ Image", "🖼️ 图片"), local("🔗 Link", "🔗 链接"),
      local("📁 File", "📁 文件"), local("🎨 Color", "🎨 颜色")][index]
  }
  var shortcut: String {
    let labels = ["alt": "Option", "control": "Ctrl", "ctrl": "Ctrl", "shift": "Shift",
      "command": "Command", "cmd": "Command", "meta": "Command", "super": "Command",
      "win": "Command", "windows": "Command", "enter": "Enter", "return": "Enter", "escape": "Esc", "esc": "Esc"]
    return state.shortcut.split(separator: "+").map { part in
      let value = part.trimmingCharacters(in: .whitespaces)
      return labels[value.lowercased()] ?? (value.count == 1 ? value.uppercased() : value.capitalized)
    }.joined(separator: "+")
  }
  func perform(_ action: String, _ args: [String: Any] = [:]) {
    guard !closed, !busy, let onAction else { return }
    busy = true
    var payload = args
    payload["onboardingId"] = state.id
    payload["step"] = state.step
    payload["target"] = action
    onAction(action, payload)
  }
  func complete(_ result: Result<Any, Error>) {
    guard !closed else { return }
    busy = false
    do {
      guard !(try result.get() is NSNull) else { return }
      apply(try panelDecode(PanelOnboardingState.self, result.get()))
    } catch { message = error.localizedDescription }
  }
  func apply(_ next: PanelOnboardingState) {
    guard !closed, next.id == state.id, next.revision >= state.revision,
      (0...3).contains(next.step), next.filters.count == 5 else { return }
    let previous = state
    let permissionChanged = previous.step == next.step && next.step == 1 &&
      (previous.permissions.background.done != next.permissions.background.done ||
        previous.permissions.paste.done != next.permissions.paste.done)
    if permissionChanged {
      withAnimation(next.motion.curve(next.motion.easing.standard, next.motion.duration.quick)) { state = next }
    } else { state = next }
    busy = false
    if previous.step != next.step { play(reduced: reduced) }
    else if next.step == 1 {
      let changed = [(!previous.permissions.background.done && next.permissions.background.done, "background"),
        (!previous.permissions.paste.done && next.permissions.paste.done, "paste")].filter { $0.0 }.map { $0.1 }
      guard !changed.isEmpty, !reduced else { return }
      successfulIDs = Set(changed)
      successScale = 0.86; successFlash = 0.75
      withAnimation(.interpolatingSpring(mass: 0.8, stiffness: 420, damping: 32)) { successScale = 1 }
      withAnimation(state.motion.curve(state.motion.easing.enter, state.motion.duration.slow / 2)) {
        successLift = -CGFloat(state.motion.distance.subtle) * scale
        successFlash = 0
      }
      after(state.motion.duration.slow / 2) { model in
        withAnimation(model.state.motion.curve(model.state.motion.easing.enter, model.state.motion.duration.slow / 2)) {
          model.successLift = 0
        }
      }
    }
  }
  private func after(_ delay: Double, _ action: @escaping (PanelOnboardingModel) -> Void) {
    let epoch = generation
    let item = DispatchWorkItem { [weak self] in
      guard let self, !self.closed, self.generation == epoch else { return }
      action(self)
    }
    work.append(item)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }
  private func cancel() {
    generation &+= 1
    work.forEach { $0.cancel() }; work.removeAll()
  }
  func play(reduced: Bool) {
    guard !closed else { return }
    cancel(); self.reduced = reduced
    entered = reduced; copyEntered = reduced
    items = Array(repeating: reduced, count: 5)
    welcomeLeaving = false; keyScale = 1; keyY = 0
    pulseScale = 0.94; pulseOpacity = 0; successLift = 0; successFlash = 0
    let motion = state.motion
    if reduced {
      if state.step == 0 { after(0.9) { $0.perform("next") } }
      return
    }
    after(0) { model in
      withAnimation(motion.curve(motion.easing.enter, motion.duration.slow)) { model.entered = true }
      withAnimation(motion.curve(motion.easing.enter, motion.duration.standard)) { model.copyEntered = true }
    }
    if state.step == 0 {
      for index in 0..<2 {
        after(Double(index) * motion.duration.quick) { model in
          withAnimation(motion.curve(motion.easing.enter, motion.duration.standard)) { model.items[index] = true }
        }
      }
      after(motion.welcomeDuration - motion.duration.standard) { model in
        withAnimation(motion.curve(motion.easing.exit, motion.duration.standard)) { model.welcomeLeaving = true }
      }
      after(motion.welcomeDuration) { $0.perform("next") }
    } else if state.step == 1 || state.step == 2 {
      let count = state.step == 1 ? 2 : 5
      let duration = state.step == 1 ? motion.duration.slow : motion.duration.standard
      for index in 0..<count {
        after(Double(index) * motion.duration.quick) { model in
          withAnimation(motion.curve(motion.easing.enter, duration)) { model.items[index] = true }
        }
      }
    } else {
      after(2 * motion.duration.slow) { model in
        withAnimation(motion.curve(motion.easing.standard, motion.duration.fast)) {
          model.keyY = CGFloat(motion.distance.subtle) * model.scale; model.keyScale = 0.97
        }
        model.pulseOpacity = 0
        withAnimation(motion.curve(motion.easing.enter, motion.duration.slow / 2)) {
          model.pulseOpacity = 0.72; model.pulseScale = 1.06
        }
      }
      after(2.5 * motion.duration.slow) { model in
        withAnimation(motion.curve(motion.easing.enter, motion.duration.slow / 2)) {
          model.pulseOpacity = 0; model.pulseScale = 1.12
        }
      }
      after(3 * motion.duration.slow) { model in
        withAnimation(motion.curve(motion.easing.enter, motion.duration.fast)) { model.keyY = 0; model.keyScale = 1 }
      }
    }
  }
  func pause() { cancel() }
  func close() { closed = true; cancel(); onAction = nil }
}

@MainActor
final class PanelOnboardingHost: NSHostingView<PanelOnboardingView> {
  let model: PanelOnboardingModel
  override var acceptsFirstResponder: Bool { false }
  override var canBecomeKeyView: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  init(state: PanelOnboardingState, chinese: Bool, scale: CGFloat) {
    model = PanelOnboardingModel(state: state, chinese: chinese, scale: scale)
    super.init(rootView: PanelOnboardingView(model: model))
  }
  required init(rootView: PanelOnboardingView) { fatalError("Use the configured initializer") }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

@MainActor
private final class PanelOnboardingPointerButton: PanelPointerButton {
  var invoke: (() -> Void)?
  override var acceptsFirstResponder: Bool { false }
  override init(frame: NSRect) {
    super.init(frame: frame)
    title = ""; isBordered = false; focusRingType = .none
    setButtonType(.momentaryChange)
    target = self; action = #selector(performClickAction)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  @objc private func performClickAction() { invoke?() }
}
private struct PanelOnboardingClick: NSViewRepresentable {
  let label: String
  let enabled: Bool
  let action: () -> Void
  func makeNSView(context: Context) -> PanelOnboardingPointerButton { PanelOnboardingPointerButton() }
  func updateNSView(_ view: PanelOnboardingPointerButton, context: Context) {
    view.invoke = action; view.isEnabled = enabled; view.setAccessibilityLabel(label)
  }
  static func dismantleNSView(_ view: PanelOnboardingPointerButton, coordinator: ()) { view.invoke = nil }
}

private struct PanelOnboardingCursor: NSViewRepresentable {
  let enabled: Bool
  func makeNSView(context: Context) -> PanelCursorRegion { PanelCursorRegion(cursor: .pointingHand) }
  func updateNSView(_ view: PanelCursorRegion, context: Context) { view.isEnabled = enabled }
  static func dismantleNSView(_ view: PanelCursorRegion, coordinator: ()) { view.isEnabled = false }
}

@MainActor
struct PanelOnboardingView: View {
  @ObservedObject var model: PanelOnboardingModel
  @Environment(\.accessibilityReduceMotion) private var reduced
  @Environment(\.colorScheme) private var scheme
  private var s: CGFloat { model.scale }
  private var accent: Color { Color(PanelStyle.rgb(scheme == .dark ? 0x8ab7ff : 0x2466d8)) }
  private var fill: Color { scheme == .dark ? Color.black.opacity(0.22) : Color.white.opacity(0.76) }
  private var border: Color { scheme == .dark ? Color.white.opacity(0.17) : Color.black.opacity(0.09) }
  private var distance: CGFloat { CGFloat(model.state.motion.distance.standard) * s }
  var body: some View {
    GeometryReader { geometry in
      let narrow = geometry.size.width < 760 * s
      Group {
        if model.state.step == 0 { welcome }
        else if narrow {
          ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 14 * s) { copy; content; navigation }
              .padding(16 * s)
          }
        } else {
          HStack(spacing: 14 * s) {
            copy.frame(width: 190 * s, alignment: .leading)
            content.frame(maxWidth: .infinity)
            navigation.frame(width: 106 * s)
          }
          .frame(maxWidth: 1080 * s).padding(.horizontal, 17 * s).padding(.vertical, 7 * s)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .opacity(model.state.step == 0 ? 1 : model.entered ? 1 : 0)
      .offset(x: model.state.step == 0 || model.entered ? 0 : distance)
    }
    .overlay(VStack { Spacer(); if !model.message.isEmpty {
      Text(model.message).font(.system(size: 11 * s)).foregroundColor(.red).padding(8 * s)
    } })
    .onAppear { model.play(reduced: reduced) }
    .onChange(of: reduced) { model.play(reduced: $0) }
    .onDisappear { model.pause() }
  }
  private var welcome: some View {
    HStack(spacing: 30 * s) {
      art("logo").frame(width: 118 * s, height: 118 * s)
        .opacity(model.copyEntered ? 1 : 0).offset(y: model.copyEntered ? 0 : distance)
      VStack(alignment: .leading, spacing: 12 * s) {
        Text(model.local("Welcome to vPaste", "欢迎使用 vPaste"))
          .font(.system(size: 42 * s, weight: .bold))
          .opacity(model.items[0] ? 1 : 0).offset(y: model.items[0] ? 0 : distance)
        Text(model.local("Your clipboard, always one shortcut away", "剪贴捷径，一键即达"))
          .font(.system(size: 18 * s)).foregroundColor(.secondary)
          .opacity(model.items[1] ? 1 : 0).offset(y: model.items[1] ? 0 : distance)
        Capsule().fill(accent).frame(width: 86 * s, height: 4 * s)
          .scaleEffect(x: model.copyEntered ? 1 : 0, y: 1)
      }
    }
    .padding(24 * s)
    .opacity(model.welcomeLeaving ? 0 : model.entered ? 1 : 0)
    .offset(x: model.welcomeLeaving ? -CGFloat(model.state.motion.distance.emphasis) * s :
      model.entered ? 0 : CGFloat(model.state.motion.distance.emphasis) * s)
  }
  private var copy: some View {
    VStack(alignment: .leading, spacing: 7 * s) {
      Text(String(format: "%02d", model.state.step)).font(.system(size: 12 * s, weight: .bold))
        .padding(.horizontal, 10 * s).padding(.vertical, 4 * s)
        .background(Capsule().fill(fill)).overlay(Capsule().stroke(border))
      Text(title).font(.system(size: 20 * s, weight: .bold)).fixedSize(horizontal: false, vertical: true)
      Text(description).font(.system(size: 13 * s)).foregroundColor(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if model.state.step > 1 { button(model.local("Back", "上一步"), primary: false) { model.perform("back") } }
    }
    .opacity(model.copyEntered ? 1 : 0)
    .offset(x: model.copyEntered ? 0 : -CGFloat(model.state.motion.distance.subtle) * s)
  }
  private var title: String {
    switch model.state.step {
    case 1: return model.local("Enable the essentials", "开启必要能力")
    case 2: return model.local("Add filters", "添加筛选标签")
    default: return model.local("Keep the shortcut close", "记住默认快捷键")
    }
  }
  private var description: String {
    switch model.state.step {
    case 1: return model.local("Enable these now for the best experience, or continue and finish them later in Settings", "建议现在开启这些能力；也可以先继续，之后在设置里补充")
    case 2: return model.local("Quickly find copied content by type", "按类型快速查找复制内容")
    default: return model.local("Press once to summon vPaste, then again to tuck it away", "按一次呼出窗口，再按一次收起")
    }
  }
  private var navigation: some View {
    button(model.state.step == 3 ? model.local("Finish", "完成") : model.local("Continue", "下一步"), primary: true) {
      model.perform(model.state.step == 3 ? "finish" : "next")
    }
    .opacity(model.copyEntered ? 1 : 0)
    .offset(x: model.copyEntered ? 0 : CGFloat(model.state.motion.distance.subtle) * s)
  }
  @ViewBuilder private var content: some View {
    switch model.state.step {
    case 1:
      HStack(alignment: .top, spacing: 12 * s) {
        permission("background", index: 0, done: model.state.permissions.background.done)
        permission("paste", index: 1, done: model.state.permissions.paste.done)
      }
    case 2:
      HStack(spacing: 10 * s) {
        ForEach(0..<5) { index in
          VStack(spacing: 10 * s) {
            Text(filterTitle(index)).font(.system(size: 14 * s, weight: .semibold)).multilineTextAlignment(.center)
            Toggle(filterTitle(index), isOn: Binding(get: { model.state.filters[index] }, set: {
              model.perform("toggle", ["start": index, "enabled": $0])
            })).labelsHidden().toggleStyle(SwitchToggleStyle(tint: accent)).disabled(model.busy)
              .background(PanelOnboardingCursor(enabled: !model.busy).accessibilityHidden(true))
          }
          .padding(12 * s).frame(maxWidth: .infinity, minHeight: 112 * s)
          .background(RoundedRectangle(cornerRadius: 18 * s).fill(fill))
          .overlay(RoundedRectangle(cornerRadius: 18 * s).stroke(model.state.filters[index] ? accent.opacity(0.35) : border))
          .opacity(model.items[index] ? 1 : 0).offset(y: model.items[index] ? 0 : distance)
        }
      }
    default:
      HStack(spacing: 14 * s) {
        art("shortcut").frame(maxWidth: .infinity, maxHeight: 180 * s)
          .offset(x: model.entered ? 0 : -distance)
        VStack(spacing: 8 * s) {
          Text(model.local("Default shortcut", "默认快捷键")).font(.system(size: 12 * s, weight: .semibold)).foregroundColor(.secondary)
          Text(model.shortcut).font(.system(size: 42 * s, weight: .bold)).minimumScaleFactor(0.45).lineLimit(1)
        }
        .padding(20 * s).frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 18 * s).fill(fill))
        .overlay(RoundedRectangle(cornerRadius: 18 * s).stroke(border))
        .overlay(RoundedRectangle(cornerRadius: 24 * s).stroke(accent, lineWidth: 2 * s)
          .padding(-6 * s).scaleEffect(model.pulseScale).opacity(model.pulseOpacity))
        .scaleEffect(model.keyScale).offset(x: model.entered ? 0 : distance, y: model.keyY)
      }
    }
  }
  private func permission(_ id: String, index: Int, done: Bool) -> some View {
    VStack(alignment: .leading, spacing: 9 * s) {
      ZStack(alignment: .bottomLeading) {
        art(id).frame(maxWidth: .infinity).frame(height: 92 * s)
        art("logo").frame(width: 22 * s, height: 22 * s).padding(9 * s)
      }
      .background(RoundedRectangle(cornerRadius: 12 * s).fill(fill))
      .overlay(VStack { HStack { Spacer();
        ZStack {
          Text(model.local("Not yet", "待开启")).opacity(done ? 0 : 1)
          Text("✓ " + model.local("Enabled", "已开启")).opacity(done ? 1 : 0)
        }
          .font(.system(size: 11 * s, weight: .semibold)).padding(6 * s)
          .background(Capsule().fill(fill)).overlay(Capsule().stroke(done ? accent.opacity(0.5) : border))
          .overlay(Capsule().stroke(accent).opacity(model.successfulIDs.contains(id) ? model.successFlash : 0))
          .scaleEffect(model.successfulIDs.contains(id) ? model.successScale : 1)
      }; Spacer() }.padding(7 * s))
      Text(id == "background" ? model.local("Run in background", "后台运行授权") : model.local("Auto-paste permission", "自动粘贴权限"))
        .font(.system(size: 14 * s, weight: .bold))
      Text(id == "background" ? model.local("Keep monitoring after the window closes", "允许 vPaste 在窗口关闭后继续监听剪贴板") : model.local("Paste into the app you're using", "允许 vPaste 粘贴到当前应用"))
        .font(.system(size: 12 * s)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      if !done { button(id == "background" ? model.local("Enable ↗", "开启 ↗") : model.local("Open settings ↗", "打开设置 ↗"), primary: true, height: 34) {
        model.perform("permission", ["kind": id])
      } }
    }
    .padding(9 * s).frame(maxWidth: .infinity, minHeight: 216 * s, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 18 * s).fill(fill))
    .overlay(RoundedRectangle(cornerRadius: 18 * s).stroke(done ? accent.opacity(0.4) : border))
    .opacity(model.items[index] ? 1 : 0)
    .offset(y: (model.items[index] ? 0 : distance) + (model.successfulIDs.contains(id) ? model.successLift : 0))
  }
  private func filterTitle(_ index: Int) -> String { model.filterTitle(index) }
  private func button(_ title: String, primary: Bool, height: CGFloat? = nil, action: @escaping () -> Void) -> some View {
    Text(title).font(.system(size: 13 * s, weight: .semibold))
      .foregroundColor(primary ? .white : .primary)
      .frame(maxWidth: .infinity, minHeight: (height ?? (primary ? 44 : 32)) * s)
      .background(Capsule().fill(primary ? accent : fill)).opacity(model.busy ? 0.55 : 1)
      .accessibilityHidden(true)
      .overlay(PanelOnboardingClick(label: title, enabled: !model.busy, action: action))
  }
  @ViewBuilder private func art(_ name: String) -> some View {
    if let image = model.images[name] { Image(nsImage: image).resizable().scaledToFit().accessibilityHidden(true) }
    else { Color.clear }
  }
}
