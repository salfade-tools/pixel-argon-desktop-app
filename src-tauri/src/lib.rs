use base64::Engine;
use image::{DynamicImage, GenericImageView, ImageEncoder, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PixelateStroke {
    pub points: Vec<(f64, f64)>,
    pub radius: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BgRemovalSettings {
    pub enabled: bool,
    pub color: (u8, u8, u8),
    pub tolerance: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportPayload {
    pub source_path: String,
    pub output_path: String,
    pub output_format: String,
    pub jpeg_quality: u8,
    pub target_width: u32,
    pub target_height: u32,
    pub crop: Option<CropRect>,
    pub rotation: i32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub grayscale: bool,
    pub brightness: f64,
    pub contrast: f64,
    pub pixelate_strokes: Vec<PixelateStroke>,
    pub pixelate_block_size: u32,
    pub bg_removal: Option<BgRemovalSettings>,
    pub mode: String,
}

#[tauri::command]
fn open_image(path: String) -> Result<ImageInfo, String> {
    let img = image::open(&path).map_err(|e| format!("Failed to open image: {}", e))?;
    let (width, height) = img.dimensions();

    let rgba = img.to_rgba8();
    let mut png_buf = std::io::Cursor::new(Vec::new());
    rgba.write_to(&mut png_buf, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview: {}", e))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(png_buf.into_inner());
    let data_url = format!("data:image/png;base64,{}", b64);

    Ok(ImageInfo {
        width,
        height,
        data_url,
    })
}

#[tauri::command]
fn export_image(payload: ExportPayload) -> Result<String, String> {
    let mut img =
        image::open(&payload.source_path).map_err(|e| format!("Failed to open image: {}", e))?;

    // 1. Rotate
    img = match payload.rotation {
        90 | -270 => DynamicImage::ImageRgba8(image::imageops::rotate90(&img.to_rgba8())),
        180 | -180 => DynamicImage::ImageRgba8(image::imageops::rotate180(&img.to_rgba8())),
        270 | -90 => DynamicImage::ImageRgba8(image::imageops::rotate270(&img.to_rgba8())),
        _ => img,
    };

    // 2. Flip
    if payload.flip_h {
        img = DynamicImage::ImageRgba8(image::imageops::flip_horizontal(&img.to_rgba8()));
    }
    if payload.flip_v {
        img = DynamicImage::ImageRgba8(image::imageops::flip_vertical(&img.to_rgba8()));
    }

    // 3. Grayscale
    if payload.grayscale {
        img = DynamicImage::ImageLuma8(img.to_luma8()).to_rgba8().into();
    }

    // 4. Brightness & Contrast
    if payload.brightness != 0.0 || payload.contrast != 0.0 {
        let mut rgba = img.to_rgba8();
        apply_brightness_contrast(&mut rgba, payload.brightness, payload.contrast);
        img = DynamicImage::ImageRgba8(rgba);
    }

    // 5. Pixelate strokes
    if !payload.pixelate_strokes.is_empty() {
        let mut rgba = img.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        let block_size = payload.pixelate_block_size.max(4);
        for stroke in &payload.pixelate_strokes {
            for &(nx, ny) in &stroke.points {
                let cx = (nx * w as f64) as i32;
                let cy = (ny * h as f64) as i32;
                let r = (stroke.radius * w.max(h) as f64) as i32;
                pixelate_region(&mut rgba, cx, cy, r, block_size);
            }
        }
        img = DynamicImage::ImageRgba8(rgba);
    }

    // 6. Background removal (chroma key)
    if let Some(ref bg) = payload.bg_removal {
        if bg.enabled {
            let mut rgba = img.to_rgba8();
            chroma_key(&mut rgba, bg.color, bg.tolerance);
            img = DynamicImage::ImageRgba8(rgba);
        }
    }

    // 7. Crop & Scale
    let (iw, ih) = img.dimensions();
    if let Some(ref crop) = payload.crop {
        let cx = (crop.x * iw as f64).round() as u32;
        let cy = (crop.y * ih as f64).round() as u32;
        let cw = (crop.width * iw as f64).round().max(1.0) as u32;
        let ch = (crop.height * ih as f64).round().max(1.0) as u32;
        let cx = cx.min(iw.saturating_sub(1));
        let cy = cy.min(ih.saturating_sub(1));
        let cw = cw.min(iw - cx);
        let ch = ch.min(ih - cy);
        img = img.crop_imm(cx, cy, cw, ch);
    }

    if payload.target_width > 0 && payload.target_height > 0 {
        if payload.mode == "scale_then_crop" {
            img = scale_then_crop(img, payload.target_width, payload.target_height);
        } else {
            img = img.resize_exact(
                payload.target_width,
                payload.target_height,
                image::imageops::FilterType::Lanczos3,
            );
        }
    }

    // 8. Save
    let output_path = PathBuf::from(&payload.output_path);
    match payload.output_format.as_str() {
        "jpeg" | "jpg" => {
            let rgb = img.to_rgb8();
            let mut writer =
                std::io::BufWriter::new(fs::File::create(&output_path).map_err(|e| e.to_string())?);
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut writer,
                payload.jpeg_quality,
            );
            encoder
                .write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e: image::ImageError| e.to_string())?;
        }
        _ => {
            img.save_with_format(&output_path, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(payload.output_path)
}

fn scale_then_crop(img: DynamicImage, tw: u32, th: u32) -> DynamicImage {
    let (iw, ih) = img.dimensions();
    let scale = (tw as f64 / iw as f64).max(th as f64 / ih as f64);
    let sw = (iw as f64 * scale).round() as u32;
    let sh = (ih as f64 * scale).round() as u32;
    let scaled = img.resize_exact(sw, sh, image::imageops::FilterType::Lanczos3);
    let ox = (sw.saturating_sub(tw)) / 2;
    let oy = (sh.saturating_sub(th)) / 2;
    scaled.crop_imm(ox, oy, tw.min(sw), th.min(sh))
}

fn apply_brightness_contrast(img: &mut RgbaImage, brightness: f64, contrast: f64) {
    let b = (brightness * 255.0) as i32;
    let c = contrast + 1.0;
    for pixel in img.pixels_mut() {
        for i in 0..3 {
            let v = pixel[i] as f64;
            let v = ((v - 128.0) * c + 128.0 + b as f64).clamp(0.0, 255.0);
            pixel[i] = v as u8;
        }
    }
}

fn pixelate_region(img: &mut RgbaImage, cx: i32, cy: i32, radius: i32, block_size: u32) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let x1 = (cx - radius).max(0);
    let y1 = (cy - radius).max(0);
    let x2 = (cx + radius).min(w);
    let y2 = (cy + radius).min(h);

    let bs = block_size as i32;
    let mut bx = x1;
    while bx < x2 {
        let mut by = y1;
        while by < y2 {
            let bx2 = (bx + bs).min(x2);
            let by2 = (by + bs).min(y2);
            let mut r_sum: u64 = 0;
            let mut g_sum: u64 = 0;
            let mut b_sum: u64 = 0;
            let mut a_sum: u64 = 0;
            let mut count: u64 = 0;
            for py in by..by2 {
                for px in bx..bx2 {
                    let p = img.get_pixel(px as u32, py as u32);
                    r_sum += p[0] as u64;
                    g_sum += p[1] as u64;
                    b_sum += p[2] as u64;
                    a_sum += p[3] as u64;
                    count += 1;
                }
            }
            if count > 0 {
                let avg = Rgba([
                    (r_sum / count) as u8,
                    (g_sum / count) as u8,
                    (b_sum / count) as u8,
                    (a_sum / count) as u8,
                ]);
                for py in by..by2 {
                    for px in bx..bx2 {
                        img.put_pixel(px as u32, py as u32, avg);
                    }
                }
            }
            by += bs;
        }
        bx += bs;
    }
}

fn chroma_key(img: &mut RgbaImage, color: (u8, u8, u8), tolerance: f64) {
    let tol = (tolerance * 255.0) as i32;
    for pixel in img.pixels_mut() {
        let dr = (pixel[0] as i32 - color.0 as i32).abs();
        let dg = (pixel[1] as i32 - color.1 as i32).abs();
        let db = (pixel[2] as i32 - color.2 as i32).abs();
        let dist = dr + dg + db;
        if dist <= tol {
            pixel[3] = 0;
        } else if dist <= tol * 2 {
            let factor = (dist - tol) as f64 / tol as f64;
            pixel[3] = (pixel[3] as f64 * factor).clamp(0.0, 255.0) as u8;
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApplyPayload {
    pub source_path: String,
    pub crop: Option<CropRect>,
    pub rotation: i32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub grayscale: bool,
    pub brightness: f64,
    pub contrast: f64,
    pub pixelate_strokes: Vec<PixelateStroke>,
    pub pixelate_block_size: u32,
    pub resize_width: u32,
    pub resize_height: u32,
}

#[tauri::command]
fn apply_edits(app: tauri::AppHandle, payload: ApplyPayload) -> Result<ImageInfo, String> {
    let mut img =
        image::open(&payload.source_path).map_err(|e| format!("Failed to open image: {}", e))?;

    // Rotate
    img = match payload.rotation {
        90 | -270 => DynamicImage::ImageRgba8(image::imageops::rotate90(&img.to_rgba8())),
        180 | -180 => DynamicImage::ImageRgba8(image::imageops::rotate180(&img.to_rgba8())),
        270 | -90 => DynamicImage::ImageRgba8(image::imageops::rotate270(&img.to_rgba8())),
        _ => img,
    };

    // Flip
    if payload.flip_h {
        img = DynamicImage::ImageRgba8(image::imageops::flip_horizontal(&img.to_rgba8()));
    }
    if payload.flip_v {
        img = DynamicImage::ImageRgba8(image::imageops::flip_vertical(&img.to_rgba8()));
    }

    // Grayscale
    if payload.grayscale {
        img = DynamicImage::ImageLuma8(img.to_luma8()).to_rgba8().into();
    }

    // Brightness & Contrast
    if payload.brightness != 0.0 || payload.contrast != 0.0 {
        let mut rgba = img.to_rgba8();
        apply_brightness_contrast(&mut rgba, payload.brightness, payload.contrast);
        img = DynamicImage::ImageRgba8(rgba);
    }

    // Pixelate strokes
    if !payload.pixelate_strokes.is_empty() {
        let mut rgba = img.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        let block_size = payload.pixelate_block_size.max(4);
        for stroke in &payload.pixelate_strokes {
            for &(nx, ny) in &stroke.points {
                let cx = (nx * w as f64) as i32;
                let cy = (ny * h as f64) as i32;
                let r = (stroke.radius * w.max(h) as f64) as i32;
                pixelate_region(&mut rgba, cx, cy, r, block_size);
            }
        }
        img = DynamicImage::ImageRgba8(rgba);
    }

    // Crop
    if let Some(ref crop) = payload.crop {
        let (iw, ih) = img.dimensions();
        let cx = (crop.x * iw as f64).round() as u32;
        let cy = (crop.y * ih as f64).round() as u32;
        let cw = (crop.width * iw as f64).round().max(1.0) as u32;
        let ch = (crop.height * ih as f64).round().max(1.0) as u32;
        let cx = cx.min(iw.saturating_sub(1));
        let cy = cy.min(ih.saturating_sub(1));
        let cw = cw.min(iw - cx);
        let ch = ch.min(ih - cy);
        img = img.crop_imm(cx, cy, cw, ch);
    }

    // Resize
    if payload.resize_width > 0 && payload.resize_height > 0 {
        let (cw, ch) = img.dimensions();
        if payload.resize_width != cw || payload.resize_height != ch {
            img = img.resize_exact(
                payload.resize_width,
                payload.resize_height,
                image::imageops::FilterType::Lanczos3,
            );
        }
    }

    // Save to temp file
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let temp_path = data_dir.join("_applied.png");
    img.save_with_format(&temp_path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to save applied image: {}", e))?;

    let (width, height) = img.dimensions();
    let rgba = img.to_rgba8();
    let mut png_buf = std::io::Cursor::new(Vec::new());
    rgba.write_to(&mut png_buf, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png_buf.into_inner());
    let data_url = format!("data:image/png;base64,{}", b64);

    Ok(ImageInfo {
        width,
        height,
        data_url,
    })
}

#[tauri::command]
fn get_applied_path(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let temp_path = data_dir.join("_applied.png");
    Ok(temp_path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_recent_files(app: tauri::AppHandle) -> Vec<String> {
    let data_dir = app.path().app_data_dir().ok();
    if let Some(dir) = data_dir {
        let path = dir.join("recent_files.json");
        if path.exists() {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(files) = serde_json::from_str::<Vec<String>>(&data) {
                    return files;
                }
            }
        }
    }
    vec![]
}

#[tauri::command]
fn set_recent_files(app: tauri::AppHandle, files: Vec<String>) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("recent_files.json");
    let json = serde_json::to_string(&files).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_image,
            export_image,
            apply_edits,
            get_applied_path,
            get_recent_files,
            set_recent_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
