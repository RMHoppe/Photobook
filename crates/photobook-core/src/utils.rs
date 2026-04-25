/// Compute cover-fit scale factors for image placement.
/// Works in any consistent unit (both frame and image dimensions must use the same unit).
///
/// Returns `(cover_scale, rot_factor, total_scale)`:
/// - `cover_scale`  — minimum scale to fully cover the frame (ignoring rotation)
/// - `rot_factor`   — additional multiplier to maintain coverage under rotation (≥ 1.0)
/// - `total_scale`  — `cover_scale × rot_factor × user_scale.max(1.0)`
pub fn image_cover_factors(
    frame_w: f32, frame_h: f32,
    img_w: f32, img_h: f32,
    rotation_deg: f32,
    user_scale: f32,
) -> (f32, f32, f32) {
    if img_w <= 0.0 || img_h <= 0.0 || frame_w <= 0.0 || frame_h <= 0.0 {
        return (1.0, 1.0, 1.0);
    }
    let img_ratio   = img_w / img_h;
    let frame_ratio = frame_w / frame_h;
    // Minimum scale to cover the frame in the non-rotated case.
    let cover_scale = if img_ratio > frame_ratio { frame_h / img_h } else { frame_w / img_w };

    // Extra scale needed so the rotated image still covers the frame.
    let rad   = rotation_deg.to_radians();
    let cos_a = rad.cos().abs();
    let sin_a = rad.sin().abs();
    let sw0 = img_w * cover_scale;
    let sh0 = img_h * cover_scale;
    let rot_factor = if sw0 > 0.0 && sh0 > 0.0 {
        ((frame_w * cos_a + frame_h * sin_a) / sw0)
            .max((frame_w * sin_a + frame_h * cos_a) / sh0)
            .max(1.0)
    } else {
        1.0
    };

    let total_scale = cover_scale * rot_factor * user_scale.max(1.0);
    (cover_scale, rot_factor, total_scale)
}

/// Convert millimetres to pixels at a given DPI.
pub fn mm_to_px(mm: f32, dpi: f32) -> f32 {
    mm / 25.4 * dpi
}

/// Convert pixels to millimetres at a given DPI.
pub fn px_to_mm(px: f32, dpi: f32) -> f32 {
    px / dpi * 25.4
}

/// Scale factor from screen (96dpi) px to physical mm.
pub fn screen_px_to_mm(px: f32) -> f32 {
    px_to_mm(px, 96.0)
}

/// Scale a canvas coordinate (0..canvas_w) to page coordinates (0..page_w_mm).
pub fn canvas_to_page_x(cx: f32, canvas_w: f32, page_w_mm: f32) -> f32 {
    cx / canvas_w * page_w_mm
}

pub fn canvas_to_page_y(cy: f32, canvas_h: f32, page_h_mm: f32) -> f32 {
    cy / canvas_h * page_h_mm
}
