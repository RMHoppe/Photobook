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
