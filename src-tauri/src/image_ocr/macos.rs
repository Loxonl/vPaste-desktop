use cocoa::base::{id, nil, BOOL, YES};
use cocoa::foundation::{NSArray, NSAutoreleasePool, NSData, NSString};
use image::RgbaImage;
use objc::{class, msg_send, sel, sel_impl};

use super::super::OcrError;
use super::MAX_TEXT_BYTES;

// VNRequestTextRecognitionLevelAccurate = 0; Fast = 1 in the Vision SDK.
const ACCURATE_RECOGNITION_LEVEL: usize = 0;

#[link(name = "Vision", kind = "framework")]
extern "C" {}

// All Objective-C objects belong to this worker's autorelease pool. Vision's
// synchronous request runs outside AppKit and never touches a window.
pub(super) fn recognize(image: RgbaImage) -> Result<String, OcrError> {
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| OcrError::Failed)?;
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = recognize_data(png.get_ref());
        let _: () = msg_send![pool, drain];
        result
    }
}

unsafe fn recognize_data(bytes: &[u8]) -> Result<String, OcrError> {
    let data = NSData::dataWithBytes_length_(nil, bytes.as_ptr().cast(), bytes.len() as u64);
    let request: id = msg_send![class!(VNRecognizeTextRequest), new];
    let request: id = msg_send![request, autorelease];
    let _: () = msg_send![request, setRecognitionLevel: ACCURATE_RECOGNITION_LEVEL];
    let _: () = msg_send![request, setUsesLanguageCorrection: YES];
    // Available on macOS 13 / Vision revision 3; retain the macOS 11 path.
    let detects_language: BOOL =
        msg_send![request, respondsToSelector: sel!(setAutomaticallyDetectsLanguage:)];
    if detects_language == YES {
        let _: () = msg_send![request, setAutomaticallyDetectsLanguage: YES];
    }
    let revision: usize = msg_send![request, revision];
    let mut error: id = nil;
    // This class method supports the project's macOS 11 minimum. Filter the
    // preferred CJK/English languages against the installed Vision revision.
    let supported: id = msg_send![class!(VNRecognizeTextRequest), supportedRecognitionLanguagesForTextRecognitionLevel: ACCURATE_RECOGNITION_LEVEL revision: revision error: &mut error];
    if supported == nil {
        return Err(OcrError::LanguageUnavailable);
    }
    let preferred: id = msg_send![class!(NSLocale), preferredLanguages];
    let mut languages: Vec<id> = Vec::new();
    for index in 0..NSArray::count(supported) {
        let language = NSArray::objectAtIndex(supported, index);
        let value = NSString::UTF8String(language);
        let value = std::ffi::CStr::from_ptr(value).to_string_lossy();
        let mut wanted = value.starts_with("en") || value.starts_with("zh");
        for preferred_index in 0..NSArray::count(preferred) {
            let user_language = NSArray::objectAtIndex(preferred, preferred_index);
            let user_language =
                std::ffi::CStr::from_ptr(NSString::UTF8String(user_language)).to_string_lossy();
            wanted |= user_language.split('-').next() == value.split('-').next();
        }
        if wanted {
            languages.push(language);
        }
    }
    if !languages.is_empty() {
        let languages = NSArray::arrayWithObjects(nil, &languages);
        let _: () = msg_send![request, setRecognitionLanguages: languages];
    }
    let options: id = msg_send![class!(NSDictionary), dictionary];
    let handler: id = msg_send![class!(VNImageRequestHandler), alloc];
    let handler: id = msg_send![handler, initWithData: data options: options];
    let handler: id = msg_send![handler, autorelease];
    let requests = NSArray::arrayWithObjects(nil, &[request]);
    let success: BOOL = msg_send![handler, performRequests: requests error: &mut error];
    if success != YES {
        return Err(OcrError::Failed);
    }
    let results: id = msg_send![request, results];
    let mut text = String::new();
    for index in 0..NSArray::count(results) {
        let observation = NSArray::objectAtIndex(results, index);
        let candidates: id = msg_send![observation, topCandidates: 1usize];
        if NSArray::count(candidates) == 0 {
            continue;
        }
        let candidate = NSArray::objectAtIndex(candidates, 0);
        let line: id = msg_send![candidate, string];
        let line = std::ffi::CStr::from_ptr(NSString::UTF8String(line)).to_string_lossy();
        if text.len() + line.len() + 1 > MAX_TEXT_BYTES {
            return Err(OcrError::ResourceLimit);
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&line);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_ocr_reads_simplified_traditional_and_english_pixels() {
        // Self-authored, high-contrast fixture rendered with the system font.
        let image = image::load_from_memory(include_bytes!("fixtures/chinese-and-english.png"))
            .unwrap()
            .into_rgba8();
        let text = recognize(image).unwrap();
        assert!(text.contains("图片文字识别测试"), "{text}");
        assert!(text.contains("繁體中文測試"), "{text}");
        let compact: String = text.split_whitespace().collect();
        assert!(compact.contains("Invoice2048"), "{text}");
    }
}
