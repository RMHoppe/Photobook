use printpdf::{
    Color, ImageRotation, ImageTransform, Line, Mm, Px, PdfDocument, PdfLayerReference, Point, Rgb,
    path,
};
use crate::bsp::{BspKind, BspTree};
use crate::layout::{resolve_backgrounds_mm, resolve_mm, Border, Rect};
use crate::page::{PhotobookDocument, SpreadKind};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ImageEntry {
    pub id: String,
    pub data_base64: String,
    pub width_px: u32,
    pub height_px: u32,
}

/// One output PDF page derived from a spread.
struct OutputPage<'a> {
    tree: &'a BspTree,
    /// Which horizontal slice of the spread (in spread-mm) this page covers.
    region: Rect,
    /// Trimmed page size on paper.
    out_w: f32,
    out_h: f32,
    /// Full spread width in mm (needed for resolve_mm / resolve_backgrounds_mm).
    spread_w: f32,
}

pub fn export_pdf(doc: &PhotobookDocument, images_json: &str) -> Vec<u8> {
    let image_entries: Vec<ImageEntry> = serde_json::from_str(images_json).unwrap_or_default();

    let ph = doc.page_size.height_mm;
    let bleed = doc.bleed_mm;

    // Build list of output pages (one per spread).
    let mut out_pages: Vec<OutputPage> = Vec::new();

    for spread in &doc.spreads {
        let spread_w = doc.spread_width_mm(spread);
        out_pages.push(OutputPage {
            tree: &spread.tree,
            region: Rect::new(0.0, 0.0, spread_w, ph),
            out_w: spread_w,
            out_h: ph,
            spread_w,
        });
        // Both Cover and Content are now exported as one wide page per spread.
        let _ = SpreadKind::Content; // suppress unused warning
    }

    if out_pages.is_empty() {
        return Vec::new();
    }

    let first = &out_pages[0];
    let (pdf_doc, first_pi, first_li) = PdfDocument::new(
        "Photobook",
        Mm(first.out_w + 2.0 * bleed),
        Mm(first.out_h + 2.0 * bleed),
        "Layer 1",
    );

    let mut page_layer_pairs = vec![(first_pi, first_li)];
    for p in out_pages.iter().skip(1) {
        let (pi, li) = pdf_doc.add_page(
            Mm(p.out_w + 2.0 * bleed),
            Mm(p.out_h + 2.0 * bleed),
            "Layer 1",
        );
        page_layer_pairs.push((pi, li));
    }

    for (i, p) in out_pages.iter().enumerate() {
        let (pi, li) = page_layer_pairs[i];
        let layer = pdf_doc.get_page(pi).get_layer(li);
        let total_w = p.out_w + 2.0 * bleed;
        let total_h = p.out_h + 2.0 * bleed;

        // White base background (covers bleed area too).
        layer.set_fill_color(Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None)));
        fill_rect(&layer, 0.0, 0.0, total_w, total_h);

        // Node backgrounds (in tree-walk / parent-first order, bleed-extended).
        for bg in resolve_backgrounds_mm(p.tree, p.spread_w, p.out_h, bleed) {
            let (r, g, b) = parse_hex_color(&bg.color);
            layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
            // Convert from top-left origin (layout) to PDF bottom-left origin.
            let pdf_x = bg.rect.x + bleed;
            let pdf_y = p.out_h + bleed - bg.rect.y - bg.rect.h;
            fill_rect(&layer, pdf_x, pdf_y, bg.rect.w, bg.rect.h);
        }

        draw_crop_marks(&layer, bleed, p.out_w, p.out_h);

        // Resolve all leaves for the full spread in mm.
        let leaves_mm = resolve_mm(p.tree, p.spread_w, ph, bleed);

        for (node_id, spread_rect) in &leaves_mm {
            // Only render leaves that intersect this page's region.
            let Some(_clipped) = intersect_rect(spread_rect, &p.region) else { continue };

            let Some(node) = p.tree.get(*node_id) else { continue };
            let BspKind::Leaf(ref leaf) = node.kind else { continue };

            // frame_rect in page-local mm coords (subtract region x offset).
            let frame_page = Rect::new(
                spread_rect.x - p.region.x,
                spread_rect.y,
                spread_rect.w,
                spread_rect.h,
            );

            // Place image if one is assigned.
            if let Some(ref img_id) = leaf.image_id {
                if let Some(entry) = image_entries.iter().find(|e| e.id == *img_id) {
                    place_image(
                        &layer, entry, &frame_page, bleed, p.out_h,
                        leaf.pan_x, leaf.pan_y, leaf.scale, leaf.rotation_deg,
                    );
                }
            }

            // Draw frame border if one is configured.
            let border = &node.box_model.border;
            if border.width > 0.0 {
                draw_border_rect(&layer, &frame_page, bleed, p.out_h, border);
            }
        }
    }

    let mut buf = std::io::BufWriter::new(Vec::new());
    let _ = pdf_doc.save(&mut buf);
    buf.into_inner().unwrap_or_default()
}

fn intersect_rect(a: &Rect, b: &Rect) -> Option<Rect> {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.w).min(b.x + b.w);
    let y2 = (a.y + a.h).min(b.y + b.h);
    if x2 > x1 && y2 > y1 { Some(Rect::new(x1, y1, x2 - x1, y2 - y1)) } else { None }
}

/// Parse "#RRGGBB" to linear (0..1) RGB floats. Falls back to white on errors.
fn parse_hex_color(hex: &str) -> (f32, f32, f32) {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return (1.0, 1.0, 1.0); }
    let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(255) as f32 / 255.0;
    let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(255) as f32 / 255.0;
    let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(255) as f32 / 255.0;
    (r, g, b)
}

/// Fill a rectangle with the layer's current fill colour (PDF bottom-left coords).
fn fill_rect(layer: &PdfLayerReference, x: f32, y: f32, w: f32, h: f32) {
    if w <= 0.0 || h <= 0.0 { return; }
    layer.add_rect(printpdf::Rect {
        ll: Point::new(Mm(x), Mm(y)),
        ur: Point::new(Mm(x + w), Mm(y + h)),
        mode: path::PaintMode::Fill,
        winding: path::WindingOrder::NonZero,
    });
}

fn draw_crop_marks(layer: &PdfLayerReference, bleed: f32, pw: f32, ph: f32) {
    let mark_len = 5.0_f32;
    let offset = bleed;
    let total_w = pw + 2.0 * bleed;
    let total_h = ph + 2.0 * bleed;
    layer.set_outline_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));
    layer.set_outline_thickness(0.25);

    for (cx, cy) in [(offset, offset), (offset + pw, offset), (offset, offset + ph), (offset + pw, offset + ph)] {
        let h_start = if cx <= offset { (cx - mark_len).max(0.0) } else { cx };
        let h_end   = if cx <= offset { cx } else { (cx + mark_len).min(total_w) };
        layer.add_line(Line {
            points: vec![
                (Point::new(Mm(h_start), Mm(cy)), false),
                (Point::new(Mm(h_end),   Mm(cy)), false),
            ],
            is_closed: false,
        });
        let v_start = if cy <= offset { (cy - mark_len).max(0.0) } else { cy };
        let v_end   = if cy <= offset { cy } else { (cy + mark_len).min(total_h) };
        layer.add_line(Line {
            points: vec![
                (Point::new(Mm(cx), Mm(v_start)), false),
                (Point::new(Mm(cx), Mm(v_end)),   false),
            ],
            is_closed: false,
        });
    }
}

/// Draw a stroked border rectangle around a frame (PDF bottom-left coords).
/// `border.width` is in mm; `set_outline_thickness` takes pt (1mm = 72/25.4 pt).
fn draw_border_rect(
    layer: &PdfLayerReference,
    frame: &Rect,
    bleed: f32,
    page_h_mm: f32,
    border: &Border,
) {
    let hw = border.width / 2.0;
    let (fx, fy, fw, fh) = match border.position.as_str() {
        "inner" => (
            frame.x + hw, frame.y + hw,
            (frame.w - border.width).max(0.0),
            (frame.h - border.width).max(0.0),
        ),
        "outer" => (
            frame.x - hw, frame.y - hw,
            frame.w + border.width,
            frame.h + border.width,
        ),
        _ => (frame.x, frame.y, frame.w, frame.h), // centered
    };

    let (r, g, b) = parse_hex_color(&border.color);
    layer.set_outline_color(Color::Rgb(Rgb::new(r, g, b, None)));
    // set_outline_thickness expects pt; convert from mm (1 mm = 72/25.4 pt)
    layer.set_outline_thickness(border.width * 72.0 / 25.4);

    // PDF y-axis: origin at bottom-left, y increases upward.
    let x1 = fx + bleed;
    let y1 = page_h_mm + bleed - fy - fh; // PDF bottom of rect
    let x2 = x1 + fw;
    let y2 = y1 + fh;                     // PDF top of rect

    // Use add_line with a closed path — add_rect PaintMode::Stroke is unreliable
    // in some printpdf versions.
    layer.add_line(Line {
        points: vec![
            (Point::new(Mm(x1), Mm(y1)), false),
            (Point::new(Mm(x2), Mm(y1)), false),
            (Point::new(Mm(x2), Mm(y2)), false),
            (Point::new(Mm(x1), Mm(y2)), false),
        ],
        is_closed: true,
    });
}

/// Place an image in a frame with full pan / scale / rotation support.
#[allow(clippy::too_many_arguments)]
fn place_image(
    layer: &PdfLayerReference,
    entry: &ImageEntry,
    frame_rect: &Rect,
    bleed: f32,
    page_h_mm: f32,
    pan_x: f32,
    pan_y: f32,
    user_scale: f32,
    rotation_deg: f32,
) {
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&entry.data_base64) {
        Ok(b) => b,
        Err(_) => return,
    };

    let format = match image::guess_format(&bytes) {
        Ok(f) => f,
        Err(_) => return,
    };

    let cursor = std::io::Cursor::new(bytes.as_slice());

    let pdf_img = match format {
        image::ImageFormat::Jpeg => {
            use image::codecs::jpeg::JpegDecoder;
            match JpegDecoder::new(cursor).ok().and_then(|d| printpdf::Image::try_from(d).ok()) {
                Some(i) => i,
                None => return,
            }
        }
        image::ImageFormat::Png => {
            use image::codecs::png::PngDecoder;
            match PngDecoder::new(cursor).ok().and_then(|d| printpdf::Image::try_from(d).ok()) {
                Some(i) => i,
                None => return,
            }
        }
        _ => return,
    };

    let dpi = 300.0_f32;
    let nat_w_mm = entry.width_px as f32 / dpi * 25.4;
    let nat_h_mm = entry.height_px as f32 / dpi * 25.4;
    if nat_w_mm <= 0.0 || nat_h_mm <= 0.0 { return; }

    // 1. Minimum cover scale (ignoring rotation).
    let cover_scale = (frame_rect.w / nat_w_mm).max(frame_rect.h / nat_h_mm);

    // 2. Rotation compensation.
    let rad = rotation_deg.to_radians();
    let cos_a = rad.cos().abs();
    let sin_a = rad.sin().abs();
    let sw0 = nat_w_mm * cover_scale;
    let sh0 = nat_h_mm * cover_scale;
    let rot_factor = if sw0 > 0.0 && sh0 > 0.0 {
        ((frame_rect.w * cos_a + frame_rect.h * sin_a) / sw0)
            .max((frame_rect.w * sin_a + frame_rect.h * cos_a) / sh0)
            .max(1.0)
    } else {
        1.0
    };

    // 3. Total scale.
    let total_scale = cover_scale * rot_factor * user_scale.max(1.0);
    let sw = nat_w_mm * total_scale;
    let sh = nat_h_mm * total_scale;

    // 4. Pan offsets.
    let overflow_x = sw - frame_rect.w;
    let overflow_y = sh - frame_rect.h;
    let x_mm = frame_rect.x + bleed - overflow_x * pan_x;
    let frame_cy_pdf = page_h_mm + bleed - frame_rect.y - frame_rect.h / 2.0;
    let y_img_center = frame_cy_pdf + (pan_y - 0.5) * overflow_y;
    let y_mm = y_img_center - sh / 2.0;

    let rotate = if rotation_deg.abs() > 0.001 {
        Some(ImageRotation {
            angle_ccw_degrees: rotation_deg,
            rotation_center_x: Px((entry.width_px / 2) as usize),
            rotation_center_y: Px((entry.height_px / 2) as usize),
        })
    } else {
        None
    };

    let clip = [
        Mm(frame_rect.x + bleed),
        Mm(page_h_mm + bleed - frame_rect.y - frame_rect.h),
        Mm(frame_rect.x + bleed + frame_rect.w),
        Mm(page_h_mm + bleed - frame_rect.y),
    ];

    pdf_img.add_to_layer(
        layer.clone(),
        ImageTransform {
            translate_x: Some(Mm(x_mm)),
            translate_y: Some(Mm(y_mm)),
            scale_x: Some(total_scale),
            scale_y: Some(total_scale),
            rotate,
            dpi: Some(dpi),
            clip_rect: Some(clip),
        },
    );
}
