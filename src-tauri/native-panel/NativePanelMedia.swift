import AppKit
import ImageIO

// The disk thumbnails are produced by Rust. This loader owns only bounded decoded
// surfaces. No full-image Data/base64 copies, image-name global cache, or WebKit.
@MainActor
final class PanelMedia {
  private struct Entry {
    let image: NSImage
    let bytes: Int
  }
  private var images: [String: Entry] = [:]
  private var order: [String] = []
  private var bytes = 0
  private let limit = 16 * 1024 * 1024
  var changed: (() -> Void)?
  private var generation = 0
  private var pending: [String: [(NSImage?) -> Void]] = [:]
  private let queue: OperationQueue = {
    let value = OperationQueue()
    value.maxConcurrentOperationCount = 2
    value.qualityOfService = .userInitiated
    return value
  }()
  func load(_ path: String, pixels: Int, completion: @escaping (NSImage?) -> Void) {
    guard !path.isEmpty else {
      completion(nil)
      return
    }
    let key = "\(pixels):\(path)"
    if let value = images[key] {
      order.removeAll { $0 == key }
      order.append(key)
      completion(value.image)
      return
    }
    if pending[key] != nil {
      pending[key]?.append(completion)
      return
    }
    pending[key] = [completion]
    let epoch = generation
    queue.addOperation { [weak self] in
      let image: CGImage? = autoreleasepool {
        guard
          let source = CGImageSourceCreateWithURL(
            URL(fileURLWithPath: path) as CFURL,
            [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(
          source, 0,
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels,
            kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary)
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, self.generation == epoch else { return }
        let callbacks = self.pending.removeValue(forKey: key) ?? []
        let value = image.map {
          NSImage(cgImage: $0, size: NSSize(width: $0.width, height: $0.height))
        }
        if let image, let value {
          let size = image.bytesPerRow * image.height
          if size <= self.limit {
            while self.bytes + size > self.limit || self.order.count >= 48,
              let oldest = self.order.first
            {
              self.order.removeFirst()
              if let entry = self.images.removeValue(forKey: oldest) { self.bytes -= entry.bytes }
            }
            self.images[key] = Entry(image: value, bytes: size)
            self.order.append(key)
            self.bytes += size
          }
        }
        for callback in callbacks { callback(value) }
        self.changed?()
      }
    }
  }
  func clear() {
    generation &+= 1
    queue.cancelAllOperations()
    pending.removeAll()
    images.removeAll()
    order.removeAll()
    bytes = 0
  }
  var decodedBytes: Int { bytes }
}

// One decoded GIF frame at a time, only for a visible selected/hovered card.
// Closing or recycling cancels the timer and releases the CGImageSource.
@MainActor
final class PanelGIF {
  private var source: CGImageSource?
  private var timer: Timer?
  private var index = 0
  private var epoch = 0
  private let queue = DispatchQueue(label: "vpaste.native.gif", qos: .userInitiated)
  func stop() {
    epoch &+= 1
    timer?.invalidate()
    timer = nil
    source = nil
  }
  func start(path: String, pixels: Int, update: @escaping (NSImage) -> Void) {
    stop()
    guard
      let source = CGImageSourceCreateWithURL(
        URL(fileURLWithPath: path) as CFURL,
        [kCGImageSourceShouldCache: false] as CFDictionary), CGImageSourceGetCount(source) > 1
    else { return }
    self.source = source
    index = 0
    next(pixels: pixels, update: update)
  }
  private func next(pixels: Int, update: @escaping (NSImage) -> Void) {
    guard let source else { return }
    let frame = index
    let generation = epoch
    index = (index + 1) % CGImageSourceGetCount(source)
    queue.async { [weak self] in
      let result: (CGImage?, Double) = autoreleasepool {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, frame, nil) as? [CFString: Any]
        let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let delay =
          (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
          ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
        let image = CGImageSourceCreateThumbnailAtIndex(
          source, frame,
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels, kCGImageSourceShouldCache: false,
          ] as CFDictionary)
        return (image, max(0.02, delay))
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, self.epoch == generation, self.source != nil else { return }
        if let image = result.0 {
          update(NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height)))
        }
        self.timer = Timer.scheduledTimer(withTimeInterval: result.1, repeats: false) {
          [weak self] _ in
          MainActor.assumeIsolated { self?.next(pixels: pixels, update: update) }
        }
      }
    }
  }
}
