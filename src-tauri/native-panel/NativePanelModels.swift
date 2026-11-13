import AppKit

struct PanelFrame: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  var rect: NSRect { NSRect(x: x, y: y, width: width, height: height) }
}
struct PanelConfiguration: Decodable {
  let session: UInt64
  let pasteQueue: PanelPasteQueueStatus?
  let sizePreview: Bool
  let language: String
  let theme: String
  let scale: Double
  let mousePasteMode: String
  let hoverPreviewEnabled: Bool
  let tabQuickSelectEnabled: Bool
  let dockedFrame: PanelFrame?
  let panelHeight: Double
  let horizontalBleed: Double
  let showDuration: Double
  let hideDuration: Double
  let showCurve: [Double]
  let hideCurve: [Double]
  var chinese: Bool { language == "Chinese" || language.hasPrefix("zh") }
}
// Queue selection carries metadata and hashes, never card/image payloads.
struct PanelPasteQueueStatus: Decodable {
  let active: Bool
  let revision: UInt64
  let activationEpoch: UInt64
  let selectedHashes: [String]
  let selectionRevision: UInt64
  let selectionBusy: Bool
}
struct PanelPasteQueueIndicator {
  private(set) var active = false
  private var revision: UInt64?
  private(set) var activationEpoch: UInt64 = 0
  private(set) var selectedHashes: [String] = []
  private(set) var selectionRevision: UInt64 = 0
  private(set) var selectionBusy = false
  private(set) var error: String?
  mutating func reportError(_ message: String) { error = message }
  mutating func clearError() { error = nil }
  mutating func apply(active: Bool, revision: UInt64) -> Bool {
    guard self.revision.map({ revision >= $0 }) ?? true else { return false }
    self.revision = revision
    self.active = active
    return true
  }
  mutating func apply(_ status: PanelPasteQueueStatus) -> Bool {
    guard status.activationEpoch >= activationEpoch, status.selectionRevision >= selectionRevision,
      apply(active: status.active, revision: status.revision) else { return false }
    if !status.active || status.activationEpoch != activationEpoch { clearError() }
    activationEpoch = status.activationEpoch
    selectedHashes = status.active ? status.selectedHashes : []
    selectionRevision = status.selectionRevision
    selectionBusy = status.selectionBusy && status.active
    return true
  }
}

struct PanelToken: Decodable {
  let viewId: String
  let revision: UInt64
}
struct PanelTag: Decodable, Equatable {
  let id: Int64
  let name: String
}
// A dynamic toolbar tab after All and Favorites: a filter tab or a record tag,
// already ordered, with the history query label it selects.
struct PanelTab: Decodable, Equatable {
  let id: String
  let name: String
  let label: String
  let record: Bool
}
struct PanelRef: Decodable {
  let hash: String
  let itemType: String
  let time: UInt64
  let label: UInt64
  let appSource: String
  let titleColor: String
}
struct PanelPage: Decodable {
  let token: PanelToken
  let pageIndex: Int
  let startIndex: Int
  let items: [PanelRef]
  let knownCount: Int
  let hasMore: Bool
}
// Local deletion over the loaded page window. Refs after the removed one move
// forward and pages are re-chunked at the 36-item boundaries, so the collection
// view only needs to delete one item.
enum PanelPageSplice {
  static let pageSize = 36
  struct Result {
    let pages: [Int: [PanelRef]]
    let endPage: Int
    // First logical index not covered by the shifted loaded window.
    let coveredEnd: Int
    let runEndWasFull: Bool
  }
  static func remove(
    hash: String, at index: Int, pages: [Int: [PanelRef]]
  ) -> Result? {
    let page = index / pageSize
    let slot = index % pageSize
    guard index >= 0, let loaded = pages[page], slot < loaded.count,
      loaded[slot].hash == hash
    else { return nil }
    var flat = loaded
    var endPage = page
    while let next = pages[endPage + 1] {
      flat.append(contentsOf: next)
      endPage += 1
    }
    let runEndWasFull = (pages[endPage]?.count ?? 0) >= pageSize
    guard slot < flat.count, flat[slot].hash == hash else { return nil }
    flat.remove(at: slot)
    var shifted = pages
    for current in page...endPage {
      let start = (current - page) * pageSize
      shifted[current] = Array(flat.dropFirst(start).prefix(pageSize))
    }
    return Result(
      pages: shifted, endPage: endPage, coveredEnd: page * pageSize + flat.count,
      runEndWasFull: runEndWasFull)
  }
}
struct PanelRun: Decodable {
  let text: String
  let bold: Bool
  let italic: Bool
  let underline: Bool
  let mono: Bool
  let color: String
  let background: String
  let size: Double
  let image: String
}
struct PanelBlock: Decodable {
  let runs: [PanelRun]
  let rows: [[[PanelRun]]]
}
struct PanelCard: Decodable {
  let hash: String
  let itemType: String
  let text: String
  let source: String
  let sourceIcon: String
  let remote: Bool
  let time: UInt64
  let color: String
  let favorite: Bool
  let tags: [PanelTag]
  let assetPath: String
  let animationPath: String
  let dimensions: String
  let mediaWidth: Int
  let mediaHeight: Int
  let displayTitle: String
  let displaySubtitle: String
  let displaySymbol: String
  let fileFormat: String
  let isGif: Bool
  let rich: [PanelBlock]
  // Image, or a File holding exactly one image path (WebView imageExportSourcePath).
  var exportImage = false
}
struct PanelCards: Decodable { let cards: [PanelCard] }

func panelDecode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
  try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
}
func panelColor(_ raw: String) -> NSColor? {
  let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if value.hasPrefix("#") {
    var hex = String(value.dropFirst())
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { return nil }
    return NSColor(
      srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
      blue: CGFloat(rgb & 255) / 255, alpha: 1)
  }
  if value.hasPrefix("rgb") {
    let numbers = value.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
      .compactMap(Double.init)
    if numbers.count >= 3 {
      return NSColor(
        srgbRed: numbers[0] / 255, green: numbers[1] / 255,
        blue: numbers[2] / 255, alpha: numbers.count > 3 ? numbers[3] : 1)
    }
  }
  return [
    "red": NSColor.systemRed, "blue": .systemBlue, "green": .systemGreen,
    "black": .black, "white": .white, "gray": .gray, "orange": .systemOrange,
    "yellow": .systemYellow, "purple": .systemPurple,
  ][value]
}

@MainActor
final class PanelBridge {
  private let callbacks: VPastePanelCallbacks
  let session: UInt64
  private var next: UInt64 = 0
  private var pending: [UInt64: (Result<Any, Error>) -> Void] = [:]
  private(set) var closed = false
  var changed: (() -> Void)?
  var event: ((String, [String: Any]) -> Void)?
  init(_ callbacks: VPastePanelCallbacks, session: UInt64) {
    self.callbacks = callbacks
    self.session = session
  }
  func send(
    _ op: String, _ args: [String: Any] = [:], completion: ((Result<Any, Error>) -> Void)? = nil
  ) {
    guard !closed else { return }
    next &+= 1
    var request = args
    request["id"] = next
    request["session"] = session
    request["op"] = op
    guard let data = try? JSONSerialization.data(withJSONObject: request) else { return }
    if let completion { pending[next] = completion }
    data.withUnsafeBytes { bytes in
      callbacks.request(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count)
    }
  }
  func receive(_ value: [String: Any]) {
    guard !closed, (value["session"] as? NSNumber)?.uint64Value == session else { return }
    if let name = value["event"] as? String {
      if name == "changed" { changed?() } else { event?(name, value) }
      return
    }
    guard let id = (value["id"] as? NSNumber)?.uint64Value,
      let completion = pending.removeValue(forKey: id)
    else { return }
    if let error = value["error"] as? String {
      completion(
        .failure(NSError(domain: "vPaste", code: 1, userInfo: [NSLocalizedDescriptionKey: error])))
    } else {
      completion(.success(value["data"] ?? NSNull()))
    }
  }
  func setKey(_ key: Bool) { callbacks.set_key(key) }
  func close() {
    guard !closed else { return }
    send("close")
    closed = true
    pending.removeAll()
    changed = nil
    event = nil
  }
}
