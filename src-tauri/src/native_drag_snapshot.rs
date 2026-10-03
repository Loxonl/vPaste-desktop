use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub corner_radius: f64,
}

impl CardRect {
    pub fn validate(self) -> Result<(), String> {
        if ![self.x, self.y, self.width, self.height, self.corner_radius]
            .into_iter()
            .all(f64::is_finite)
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.width > 256.0
            || self.height > 256.0
            || self.corner_radius < 0.0
            || self.corner_radius > self.width.min(self.height) / 2.0
        {
            return Err("invalid drag card snapshot rectangle".into());
        }
        Ok(())
    }
}

use cocoa::base::{id, nil, BOOL, NO, YES};
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
use objc::{class, msg_send, sel, sel_impl};

/// Called by Tauri's with_webview on the AppKit main thread.
pub unsafe fn capture(
    view: id,
    rect: CardRect,
    complete: impl Fn(Result<Vec<u8>, String>) + 'static,
) {
    let bounds: NSRect = msg_send![view, bounds];
    if rect.x + rect.width > bounds.size.width || rect.y + rect.height > bounds.size.height {
        complete(Err("drag card snapshot is outside the webview".into()));
        return;
    }
    let flipped: BOOL = msg_send![view, isFlipped];
    let y = if flipped == YES {
        rect.y
    } else {
        bounds.size.height - rect.y - rect.height
    };
    let config: id = msg_send![class!(WKSnapshotConfiguration), new];
    let config = objc::rc::StrongPtr::new(config);
    let region = NSRect::new(
        NSPoint::new(rect.x, y),
        NSSize::new(rect.width, rect.height),
    );
    let _: () = msg_send![*config, setRect:region];
    let width: id = msg_send![class!(NSNumber), numberWithDouble:rect.width];
    let _: () = msg_send![*config, setSnapshotWidth:width];
    let _: () = msg_send![*config, setAfterScreenUpdates:YES];
    let callback = block::ConcreteBlock::new(move |image: id, error: id| {
        if image == nil || error != nil {
            complete(Err("WebKit could not capture the drag card".into()));
        } else {
            complete(png_from_snapshot(image, rect.corner_radius));
        }
    })
    .copy();
    let _: () = msg_send![view, takeSnapshotWithConfiguration:*config completionHandler:&*callback];
}

unsafe fn png_from_snapshot(image: id, corner_radius: f64) -> Result<Vec<u8>, String> {
    let tiff: id = msg_send![image, TIFFRepresentation];
    if tiff == nil {
        return Err("drag card snapshot has no bitmap".into());
    }
    let source: id = msg_send![class!(NSBitmapImageRep), imageRepWithData:tiff];
    if source == nil {
        return Err("drag card snapshot bitmap is invalid".into());
    }
    let width: isize = msg_send![source, pixelsWide];
    let height: isize = msg_send![source, pixelsHigh];
    if width <= 0 || height <= 0 || width > 1024 || height > 1024 {
        return Err("drag card snapshot exceeds its pixel budget".into());
    }
    let size: NSSize = msg_send![image, size];
    let color_space =
        objc::rc::StrongPtr::new(NSString::alloc(nil).init_str("NSDeviceRGBColorSpace"));
    let bitmap: id = msg_send![class!(NSBitmapImageRep), alloc];
    let bitmap: id = msg_send![bitmap,
        initWithBitmapDataPlanes:std::ptr::null_mut::<*mut u8>()
        pixelsWide:width pixelsHigh:height bitsPerSample:8isize samplesPerPixel:4isize
        hasAlpha:YES isPlanar:NO colorSpaceName:*color_space bytesPerRow:0isize bitsPerPixel:0isize
    ];
    let bitmap = objc::rc::StrongPtr::new(bitmap);
    if *bitmap == nil {
        return Err("create transparent drag card bitmap failed".into());
    }
    let bytes: *mut u8 = msg_send![*bitmap, bitmapData];
    let row_bytes: isize = msg_send![*bitmap, bytesPerRow];
    if bytes.is_null() || row_bytes <= 0 {
        return Err("drag card bitmap has no pixel storage".into());
    }
    std::slice::from_raw_parts_mut(bytes, (row_bytes * height) as usize).fill(0);
    let context: id =
        msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep:*bitmap];
    if context == nil {
        return Err("create drag card drawing context failed".into());
    }
    // WKWebView snapshots include the backdrop outside CSS rounded corners.
    // Draw into a transparent bitmap with the same clip before giving it to AppKit.
    let pixels = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(width as f64, height as f64),
    );
    let clip: id = msg_send![class!(NSBezierPath), bezierPathWithRoundedRect:pixels
        xRadius:corner_radius * width as f64 / size.width
        yRadius:corner_radius * height as f64 / size.height
    ];
    let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
    let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext:context];
    let _: () = msg_send![context, setShouldAntialias:YES];
    let _: () = msg_send![clip, addClip];
    let source_rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
    let _: () =
        msg_send![image, drawInRect:pixels fromRect:source_rect operation:1usize fraction:1.0f64];
    let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
    // Preserve logical dimensions on Retina displays when the PNG is loaded by AppKit again.
    let _: () = msg_send![*bitmap, setSize:size];
    let properties: id = msg_send![class!(NSDictionary), dictionary];
    let png: id = msg_send![*bitmap, representationUsingType:4usize properties:properties];
    if png == nil {
        return Err("encode drag card snapshot failed".into());
    }
    let length: usize = msg_send![png, length];
    let bytes: *const u8 = msg_send![png, bytes];
    if bytes.is_null() || length == 0 || length > 1024 * 1024 {
        return Err("drag card snapshot exceeds its byte budget".into());
    }
    Ok(std::slice::from_raw_parts(bytes, length).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_rounds_all_four_corners_without_changing_retina_size_or_card_contents() {
        use image::{ImageFormat, Rgba, RgbaImage};
        use std::io::Cursor;
        for scale in [1, 2] {
            unsafe {
                let pool: id = msg_send![class!(NSAutoreleasePool), new];
                let pixels = RgbaImage::from_fn(132 * scale, 138 * scale, |_, y| {
                    if y < 30 * scale {
                        Rgba([255, 0, 0, 255])
                    } else {
                        Rgba([0, 128, 255, 255])
                    }
                });
                let mut input = Vec::new();
                pixels
                    .write_to(&mut Cursor::new(&mut input), ImageFormat::Png)
                    .unwrap();
                let data: id =
                    msg_send![class!(NSData), dataWithBytes:input.as_ptr() length:input.len()];
                let image: id = msg_send![class!(NSImage), alloc];
                let image: id = msg_send![image, initWithData:data];
                let _: () = msg_send![image, setSize:NSSize::new(132.0, 138.0)];
                let output = png_from_snapshot(image, 8.4).unwrap();
                let result = image::load_from_memory(&output).unwrap().to_rgba8();
                let (w, h) = result.dimensions();
                assert_eq!((w, h), (132 * scale, 138 * scale));
                for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
                    assert_eq!(
                        result.get_pixel(x, y)[3],
                        0,
                        "corner ({x},{y}) captures the background at scale {scale}"
                    );
                }
                assert_eq!(
                    *result.get_pixel(66 * scale, 15 * scale),
                    Rgba([255, 0, 0, 255])
                );
                assert_eq!(
                    *result.get_pixel(66 * scale, 80 * scale),
                    Rgba([0, 128, 255, 255])
                );
                assert_eq!(result.get_pixel(w / 2, 0)[3], 255);
                assert!(
                    result.pixels().any(|pixel| pixel[3] > 0 && pixel[3] < 255),
                    "rounded edges must stay antialiased"
                );
                let data: id =
                    msg_send![class!(NSData), dataWithBytes:output.as_ptr() length:output.len()];
                let reloaded: id = msg_send![class!(NSImage), alloc];
                let reloaded: id = msg_send![reloaded, initWithData:data];
                let logical: NSSize = msg_send![reloaded, size];
                assert_eq!(logical.width, 132.0);
                assert_eq!(logical.height, 138.0);
                let _: () = msg_send![reloaded, release];
                let _: () = msg_send![image, release];
                let _: () = msg_send![pool, drain];
            }
        }
    }

    #[test]
    fn snapshot_rejects_invalid_or_unbounded_crop_rectangles() {
        let valid = CardRect {
            x: 20.0,
            y: 80.0,
            width: 132.0,
            height: 138.0,
            corner_radius: 8.4,
        };
        assert!(valid.validate().is_ok());
        for rect in [
            CardRect { x: -1.0, ..valid },
            CardRect {
                corner_radius: -1.0,
                ..valid
            },
            CardRect {
                corner_radius: f64::NAN,
                ..valid
            },
            CardRect {
                corner_radius: 200.0,
                ..valid
            },
            CardRect {
                y: f64::NAN,
                ..valid
            },
            CardRect {
                width: 2000.0,
                ..valid
            },
            CardRect {
                height: 0.0,
                ..valid
            },
        ] {
            assert!(rect.validate().is_err());
        }
    }
}
