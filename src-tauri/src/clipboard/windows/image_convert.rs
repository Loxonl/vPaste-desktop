use std::io::Cursor;

use image::{ImageFormat, ImageReader, Rgba, RgbaImage};

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const BITMAPINFOHEADER_SIZE: usize = 40;
const BITMAPV5HEADER_SIZE: usize = 124;
const LCS_SRGB: u32 = 0x7352_4742;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct BitmapInfoHeader {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

fn read_u16(data: &[u8], start: usize) -> Result<u16, String> {
    let bytes = data
        .get(start..start + 2)
        .ok_or_else(|| "bitmap header is truncated".to_string())?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], start: usize) -> Result<u32, String> {
    let bytes = data
        .get(start..start + 4)
        .ok_or_else(|| "bitmap header is truncated".to_string())?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_i32(data: &[u8], start: usize) -> Result<i32, String> {
    let bytes = data
        .get(start..start + 4)
        .ok_or_else(|| "bitmap header is truncated".to_string())?;
    Ok(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn parse_bitmap_info_header(data: &[u8]) -> Result<BitmapInfoHeader, String> {
    if data.len() < BITMAPINFOHEADER_SIZE {
        return Err("bitmap data is too short".to_string());
    }

    let header = BitmapInfoHeader {
        bi_size: read_u32(data, 0)?,
        bi_width: read_i32(data, 4)?,
        bi_height: read_i32(data, 8)?,
        bi_planes: read_u16(data, 12)?,
        bi_bit_count: read_u16(data, 14)?,
        bi_compression: read_u32(data, 16)?,
        bi_size_image: read_u32(data, 20)?,
        bi_x_pels_per_meter: read_i32(data, 24)?,
        bi_y_pels_per_meter: read_i32(data, 28)?,
        bi_clr_used: read_u32(data, 32)?,
        bi_clr_important: read_u32(data, 36)?,
    };

    if header.bi_size < BITMAPINFOHEADER_SIZE as u32 {
        return Err(format!(
            "unsupported bitmap header size: {}",
            header.bi_size
        ));
    }
    if data.len() < header.bi_size as usize {
        return Err("bitmap data does not contain the full header".to_string());
    }
    if header.bi_planes != 1 {
        return Err(format!(
            "unsupported bitmap plane count: {}",
            header.bi_planes
        ));
    }
    if header.bi_width <= 0 || header.bi_height == 0 {
        return Err(format!(
            "invalid bitmap dimensions: {}x{}",
            header.bi_width, header.bi_height
        ));
    }
    if !matches!(header.bi_bit_count, 24 | 32) {
        return Err(format!(
            "unsupported bitmap bit depth: {}",
            header.bi_bit_count
        ));
    }
    if !matches!(header.bi_compression, BI_RGB | BI_BITFIELDS) {
        return Err(format!(
            "unsupported bitmap compression: {}",
            header.bi_compression
        ));
    }

    Ok(header)
}

fn color_table_size(header: BitmapInfoHeader) -> usize {
    if header.bi_bit_count > 8 {
        return 0;
    }

    let color_count = if header.bi_clr_used > 0 {
        header.bi_clr_used as usize
    } else {
        1usize << header.bi_bit_count
    };
    color_count * 4
}

fn bitfield_mask_size(header: BitmapInfoHeader) -> usize {
    if header.bi_compression != BI_BITFIELDS {
        return 0;
    }

    // BITMAPV5HEADER embeds the masks in the header. Older headers store them
    // between the header and pixel data.
    if header.bi_size as usize >= BITMAPV5HEADER_SIZE {
        0
    } else {
        12
    }
}

fn convert_bitmap_to_rgba_image(data: &[u8]) -> Result<RgbaImage, String> {
    let header = parse_bitmap_info_header(data)?;
    let width = header.bi_width as u32;
    let height = header.bi_height.unsigned_abs();
    let bytes_per_pixel = (header.bi_bit_count / 8) as usize;
    let row_bytes = width as usize * bytes_per_pixel;
    let stride = (row_bytes + 3) & !3;
    let pixel_data_offset =
        header.bi_size as usize + bitfield_mask_size(header) + color_table_size(header);
    let required_len = pixel_data_offset
        .checked_add(
            stride
                .checked_mul(height as usize)
                .ok_or("bitmap is too large")?,
        )
        .ok_or("bitmap is too large")?;

    if data.len() < required_len {
        return Err(format!(
            "bitmap pixel data is truncated: got {}, need {}",
            data.len(),
            required_len
        ));
    }

    let top_down = header.bi_height < 0;
    let mut img = RgbaImage::new(width, height);
    let mut has_nonzero_alpha = false;

    for y in 0..height {
        let source_y = if top_down { y } else { height - y - 1 };
        let row_start = pixel_data_offset + source_y as usize * stride;

        for x in 0..width {
            let pixel_start = row_start + x as usize * bytes_per_pixel;
            let pixel = &data[pixel_start..pixel_start + bytes_per_pixel];
            let alpha = if bytes_per_pixel == 4 { pixel[3] } else { 255 };

            if alpha != 0 {
                has_nonzero_alpha = true;
            }

            img.put_pixel(x, y, Rgba([pixel[2], pixel[1], pixel[0], alpha]));
        }
    }

    if bytes_per_pixel == 4 && !has_nonzero_alpha {
        for pixel in img.pixels_mut() {
            pixel.0[3] = 255;
        }
    }

    Ok(img)
}

pub fn convert_bitmap_to_png(data: &[u8]) -> Result<Vec<u8>, String> {
    let img = convert_bitmap_to_rgba_image(data)?;

    let mut image_buffer = Vec::new();
    img.write_to(&mut Cursor::new(&mut image_buffer), ImageFormat::Png)
        .map_err(|err| format!("encode png failed: {}", err))?;

    Ok(image_buffer)
}

pub fn convert_bitmap_to_dibv5(data: &[u8]) -> Result<Vec<u8>, String> {
    let rgba = convert_bitmap_to_rgba_image(data)?;
    convert_rgba_image_to_dibv5(&rgba)
}

fn append_u16(buffer: &mut Vec<u8>, value: u16) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn append_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn append_i32(buffer: &mut Vec<u8>, value: i32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn convert_rgba_image_to_dibv5(rgba: &RgbaImage) -> Result<Vec<u8>, String> {
    let width = rgba.width();
    let height = rgba.height();
    let pixel_size = width
        .checked_mul(height)
        .and_then(|size| size.checked_mul(4))
        .ok_or_else(|| "image is too large".to_string())?;

    if width > i32::MAX as u32 || height > i32::MAX as u32 {
        return Err("image dimensions are too large".to_string());
    }

    let mut dib = Vec::with_capacity(BITMAPV5HEADER_SIZE + pixel_size as usize);
    append_u32(&mut dib, BITMAPV5HEADER_SIZE as u32);
    append_i32(&mut dib, width as i32);
    append_i32(&mut dib, -(height as i32));
    append_u16(&mut dib, 1);
    append_u16(&mut dib, 32);
    append_u32(&mut dib, BI_BITFIELDS);
    append_u32(&mut dib, pixel_size);
    append_i32(&mut dib, 0);
    append_i32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0x00ff_0000);
    append_u32(&mut dib, 0x0000_ff00);
    append_u32(&mut dib, 0x0000_00ff);
    append_u32(&mut dib, 0xff00_0000);
    append_u32(&mut dib, LCS_SRGB);
    for _ in 0..9 {
        append_i32(&mut dib, 0);
    }
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);
    debug_assert_eq!(dib.len(), BITMAPV5HEADER_SIZE);

    for pixel in rgba.pixels() {
        dib.push(pixel[2]);
        dib.push(pixel[1]);
        dib.push(pixel[0]);
        dib.push(pixel[3]);
    }

    Ok(dib)
}

#[allow(dead_code)]
pub fn convert_image_file_to_dib(path: &str) -> Result<Vec<u8>, String> {
    let img = ImageReader::open(path)
        .map_err(|err| format!("open image failed: {}", err))?
        .with_guessed_format()
        .map_err(|err| format!("guess image format failed: {}", err))?
        .decode()
        .map_err(|err| format!("decode image failed: {}", err))?;

    convert_dynamic_image_to_dib(img)
}

pub fn convert_image_bytes_to_dib(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img =
        image::load_from_memory(bytes).map_err(|err| format!("decode image failed: {}", err))?;
    convert_dynamic_image_to_dib(img)
}

fn convert_dynamic_image_to_dib(img: image::DynamicImage) -> Result<Vec<u8>, String> {
    let rgba = img.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    let pixel_size = width
        .checked_mul(height)
        .and_then(|size| size.checked_mul(4))
        .ok_or_else(|| "image is too large".to_string())?;

    if width > i32::MAX as u32 || height > i32::MAX as u32 {
        return Err("image dimensions are too large".to_string());
    }

    let mut dib = Vec::with_capacity(BITMAPINFOHEADER_SIZE + pixel_size as usize);
    append_u32(&mut dib, BITMAPINFOHEADER_SIZE as u32);
    append_i32(&mut dib, width as i32);
    append_i32(&mut dib, -(height as i32));
    append_u16(&mut dib, 1);
    append_u16(&mut dib, 32);
    append_u32(&mut dib, BI_RGB);
    append_u32(&mut dib, pixel_size);
    append_i32(&mut dib, 0);
    append_i32(&mut dib, 0);
    append_u32(&mut dib, 0);
    append_u32(&mut dib, 0);

    for pixel in rgba.pixels() {
        dib.push(pixel[2]);
        dib.push(pixel[1]);
        dib.push(pixel[0]);
        dib.push(pixel[3]);
    }

    Ok(dib)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u32_at(data: &[u8], start: usize) -> u32 {
        u32::from_le_bytes([
            data[start],
            data[start + 1],
            data[start + 2],
            data[start + 3],
        ])
    }

    #[test]
    fn converts_dib_to_dibv5_with_alpha_masks() {
        let rgba = RgbaImage::from_pixel(2, 1, Rgba([10, 20, 30, 128]));
        let dib = convert_dynamic_image_to_dib(image::DynamicImage::ImageRgba8(rgba)).unwrap();
        let dibv5 = convert_bitmap_to_dibv5(&dib).unwrap();

        assert_eq!(read_u32_at(&dibv5, 0), BITMAPV5HEADER_SIZE as u32);
        assert_eq!(read_u32_at(&dibv5, 16), BI_BITFIELDS);
        assert_eq!(read_u32_at(&dibv5, 40), 0x00ff_0000);
        assert_eq!(read_u32_at(&dibv5, 44), 0x0000_ff00);
        assert_eq!(read_u32_at(&dibv5, 48), 0x0000_00ff);
        assert_eq!(read_u32_at(&dibv5, 52), 0xff00_0000);
        assert_eq!(dibv5.len(), BITMAPV5HEADER_SIZE + 8);

        let png = convert_bitmap_to_png(&dibv5).unwrap();
        let restored = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(restored.get_pixel(0, 0).0, [10, 20, 30, 128]);
    }
}
