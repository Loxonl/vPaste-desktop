@preconcurrency import AppKit

private struct TrayMenuContent: Decodable {
  struct RecordingStatus: Decodable {
    let paused: Bool
    let label: String
  }

  struct Row: Decodable {
    let id: Int32
    let title: String
    let recording: RecordingStatus?
  }

  let title: String
  let rows: [Row]
}

private func recordingDot(_ color: NSColor) -> NSImage {
  let image = NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
    color.setFill()
    NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
    return true
  }
  image.isTemplate = false
  return image
}

private final class TrayMenuSelection: NSObject {
  private(set) var action: Int32 = 0

  @objc func select(_ sender: NSMenuItem) {
    guard action == 0, sender.isEnabled, let id = Int32(exactly: sender.tag), id > 0 else { return }
    action = id
  }
}

@_cdecl("vpaste_show_macos_tray_menu")
public func vpasteShowMacOSTrayMenu(
  _ statusItem: UnsafeRawPointer, _ bytes: UnsafePointer<UInt8>, _ length: Int,
  _ displayID: UnsafeMutablePointer<UInt32>
) -> Int32 {
  // The Rust bridge dispatches to AppKit without requiring Swift Concurrency on macOS 11.
  guard Thread.isMainThread else { return -1 }
  let item = Unmanaged<NSStatusItem>.fromOpaque(statusItem).takeUnretainedValue()
  guard let button = item.button, let screen = button.window?.screen, item.isVisible else { return 0 }
  defer { button.highlight(false) }
  guard let content = try? JSONDecoder().decode(TrayMenuContent.self, from: Data(bytes: bytes, count: length))
  else { return -1 }

  displayID.pointee = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
    .uint32Value ?? 0
  let selection = TrayMenuSelection()
  let menu = NSMenu(title: content.title)
  menu.autoenablesItems = false
  for row in content.rows {
    let entry = NSMenuItem(title: row.title, action: #selector(TrayMenuSelection.select(_:)), keyEquivalent: "")
    entry.tag = Int(row.id)
    entry.target = selection
    if let recording = row.recording {
      entry.offStateImage = recordingDot(.systemGreen)
      entry.onStateImage = recordingDot(.systemRed)
      entry.state = recording.paused ? .on : .off
      let fullTitle = "\(row.title) — \(recording.label)"
      if #available(macOS 14.0, *) {
        entry.badge = NSMenuItemBadge(string: recording.label)
        entry.setAccessibilityLabel(fullTitle)
      } else {
        entry.title = fullTitle
      }
    }
    menu.addItem(entry)
  }

  // The status item supplies the system menu's material and menu-bar placement.
  item.menu = menu
  defer { item.menu = nil }
  button.performClick(nil)
  return selection.action
}
