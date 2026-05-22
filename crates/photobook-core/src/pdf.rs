use printpdf::{
    BuiltinFont, Color, Image, ImageFilter, ImageRotation, ImageXObject, IndirectFontRef,
    Line, Mm, Px, PdfDocument, PdfDocumentReference, PdfLayerReference, Point, Rgb,
    ColorBits, ColorSpace, CurTransMat, Pt, XObjectRef,
    path,
};
use crate::layout::{Border, BorderPosition, Rect};
use crate::page::{PhotobookDocument, TextElement};
use crate::grid_resolver::resolve_frames_mm;
use crate::utils::image_cover_factors;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize, Serialize)]
pub struct ImageEntry {
    pub id: String,
    pub data_base64: String,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Deserialize)]
pub struct FontEntry {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
    pub data_base64: String,
}

/// Decoded image ready for cropping.
pub(crate) struct DecodedImage {
    img: image::DynamicImage,
    is_jpeg: bool,
}

// ---------------------------------------------------------------------------
// Staged export state
// ---------------------------------------------------------------------------

/// Mutable state shared across the three-phase stateful export:
/// `pdf_export_begin` → N × `pdf_export_spread_one` → `pdf_export_finish`.
/// Stored in `PhotobookEditor` so TypeScript can drive the loop with `await`
/// between spreads, allowing the browser to repaint the progress bar.
pub(crate) struct PdfExportState {
    pub pdf_doc:       PdfDocumentReference,
    pub layers:        Vec<PdfLayerReference>,
    pub decoded:       HashMap<String, DecodedImage>,
    pub font_bytes_map: HashMap<String, Vec<u8>>,
    pub font_cache:    HashMap<String, IndirectFontRef>,
    pub bleed:         f32,
    pub ph:            f32,
    pub print_dpi:     f32,
    pub next_spread:   usize,
    pub total:         usize,
}

/// Phase 1 — decode images/fonts, allocate one PDF page per spread.
/// Returns `None` only if the document has no spreads.
pub(crate) fn pdf_export_begin(
    doc: &PhotobookDocument,
    images_json: &str,
    fonts_json: &str,
) -> Option<PdfExportState> {
    use base64::Engine;

    let font_entries: Vec<FontEntry> = serde_json::from_str(fonts_json).unwrap_or_default();
    let mut font_bytes_map: HashMap<String, Vec<u8>> = HashMap::new();
    for fe in font_entries {
        let key = format!("{}:{}:{}", fe.family, fe.bold as u8, fe.italic as u8);
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&fe.data_base64) {
            font_bytes_map.insert(key, bytes);
        }
    }

    let image_entries: Vec<ImageEntry> = serde_json::from_str(images_json).unwrap_or_default();
    let decoded: HashMap<String, DecodedImage> = image_entries
        .into_iter()
        .filter_map(|e| decode_image(&e.data_base64).map(|d| (e.id, d)))
        .collect();

    let total = doc.spreads.len();
    if total == 0 { return None; }

    let bleed     = doc.bleed_mm;
    let ph        = doc.page_size.height_mm;
    let print_dpi = doc.print_dpi;

    let first_spread_w = doc.spread_width_mm(&doc.spreads[0]);
    let (pdf_doc, first_pi, first_li) = PdfDocument::new(
        "Photobook",
        Mm(first_spread_w + 2.0 * bleed),
        Mm(ph + 2.0 * bleed),
        "Layer 1",
    );
    pdf_doc.get_page(first_pi).extend_with(page_box_extension(first_spread_w, ph, bleed));
    let mut layers = vec![pdf_doc.get_page(first_pi).get_layer(first_li)];

    for spread in doc.spreads.iter().skip(1) {
        let spread_w = doc.spread_width_mm(spread);
        let (pi, li) = pdf_doc.add_page(
            Mm(spread_w + 2.0 * bleed),
            Mm(ph + 2.0 * bleed),
            "Layer 1",
        );
        pdf_doc.get_page(pi).extend_with(page_box_extension(spread_w, ph, bleed));
        layers.push(pdf_doc.get_page(pi).get_layer(li));
    }

    Some(PdfExportState {
        pdf_doc,
        layers,
        decoded,
        font_bytes_map,
        font_cache: HashMap::new(),
        bleed,
        ph,
        print_dpi,
        next_spread: 0,
        total,
    })
}

/// Phase 2 — render the next pending spread into the PDF.
/// Call this `total` times (once per spread).
pub(crate) fn pdf_export_spread_one(state: &mut PdfExportState, doc: &PhotobookDocument) {
    let i = state.next_spread;
    if i >= state.total { return; }

    let spread   = &doc.spreads[i];
    let spread_w = doc.spread_width_mm(spread);
    let bleed    = state.bleed;
    let ph       = state.ph;
    let total_w  = spread_w + 2.0 * bleed;
    let total_h  = ph + 2.0 * bleed;
    let page_w   = doc.page_size.width_mm;

    let layer = state.layers[i].clone();

    // Determine the printable layout region for endpaper spreads.
    // layout_w: width passed to the resolver (one page for endpapers, full spread otherwise).
    // layout_offset_x: x offset to shift resolved frames into the printable half.
    let endpaper_side = doc.endpaper_side(i);
    let (layout_w, layout_offset_x) = match endpaper_side {
        Some("left")  => (page_w, page_w), // right half is printable
        Some("right") => (page_w, 0.0),    // left half is printable
        _             => (spread_w, 0.0),
    };
    let region = Rect::new(layout_offset_x, 0.0, layout_w, ph);

    // White base background.
    layer.set_fill_color(Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None)));
    fill_rect(&layer, 0.0, 0.0, total_w, total_h);

    // Per-page background colors — skip the non-printable side for endpaper spreads.
    let draw_left_bg  = endpaper_side != Some("left");
    let draw_right_bg = endpaper_side != Some("right");
    if draw_left_bg && !spread.left_bg.is_empty() {
        let (r, g, b) = parse_hex_color(&spread.left_bg);
        layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
        fill_rect(&layer, 0.0, 0.0, page_w + bleed, total_h);
    }
    if draw_right_bg && !spread.right_bg.is_empty() {
        let (r, g, b) = parse_hex_color(&spread.right_bg);
        layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
        fill_rect(&layer, total_w - page_w - bleed, 0.0, page_w + bleed, total_h);
    }

    draw_crop_marks(&layer, bleed, spread_w, ph);

    // Resolve frames against the printable page width, then shift into spread-mm space.
    let rooms_mm_raw = resolve_frames_mm(
        &spread.layout, layout_w, ph, bleed,
        spread.margin_top, spread.margin_right,
        spread.margin_bottom, spread.margin_left,
    );
    let rooms_mm: Vec<_> = rooms_mm_raw.iter().map(|(id, r)| {
        (*id, Rect::new(r.x + layout_offset_x, r.y, r.w, r.h))
    }).collect();

    // Pass 1: prepare per-frame placement data and deduplicate crops.
    type CropKey = (String, u32, u32, u32, u32);
    let mut xobj_cache: HashMap<CropKey, XObjectRef> = HashMap::new();
    let mut pending: Vec<(Rect, f32, f32, Prepared)> = Vec::new();

    for (face_id, spread_rect) in &rooms_mm {
        let Some(_clipped) = intersect_rect(spread_rect, &region) else { continue };
        let Some(face) = spread.layout.faces.get(face_id) else { continue };

        let node_rotation    = face.box_model.face_rotation_deg.unwrap_or(0.0);
        let border_radius_mm = face.box_model.border.radius.max(0.0);
        let frame_page       = frame_page_rect(spread_rect, region.x);

        if let Some(ref img_id) = face.image.image_id {
            if let Some(decoded_img) = state.decoded.get(img_id.as_str()) {
                if let Some(prep) = prepare_image(
                    decoded_img, &frame_page, bleed, ph,
                    face.image.pan_x, face.image.pan_y,
                    face.image.scale, face.image.rotation_deg,
                    state.print_dpi,
                ) {
                    let key: CropKey = (
                        img_id.clone(),
                        prep.crop.left, prep.crop.top,
                        prep.crop.width, prep.crop.height,
                    );
                    let xobj_ref = xobj_cache.entry(key).or_insert_with(|| {
                        layer.add_image(prep.xobj.clone())
                    }).clone();
                    pending.push((frame_page, node_rotation, border_radius_mm,
                                  Prepared { xobj_ref: Some(xobj_ref), ..prep }));
                }
            }
        }
    }

    // Pass 2: paint all frames (image then border).
    for (frame_page, node_rotation, border_radius_mm, prep) in &pending {
        if let Some(ref xobj_ref) = prep.xobj_ref {
            paint_image(&layer, xobj_ref.clone(), prep, frame_page,
                        *node_rotation, *border_radius_mm, bleed, ph);
        }
    }
    for (face_id, spread_rect) in &rooms_mm {
        let Some(_clipped) = intersect_rect(spread_rect, &region) else { continue };
        let Some(face) = spread.layout.faces.get(face_id) else { continue };
        let frame_page = frame_page_rect(spread_rect, region.x);
        let border = &face.box_model.border;
        if border.any_nonzero() {
            let node_rotation = face.box_model.face_rotation_deg.unwrap_or(0.0);
            layer.save_graphics_state();
            apply_node_ctm(&layer, node_rotation, &frame_page, bleed, ph);
            draw_border_rect(&layer, &frame_page, bleed, ph, border);
            layer.restore_graphics_state();
        }
    }

    // Pass 3: text elements (skip any that fall on the non-printable page).
    let printable_texts: Vec<_> = spread.text_elements.iter().filter(|t| {
        match endpaper_side {
            Some("left")  => t.x_mm >= page_w,
            Some("right") => t.x_mm < page_w,
            _             => true,
        }
    }).cloned().collect();
    if !printable_texts.is_empty() {
        draw_text_elements(
            &layer, &printable_texts,
            region.x, bleed, ph,
            &state.pdf_doc, &mut state.font_cache, &state.font_bytes_map,
        );
    }

    state.next_spread += 1;
}

/// Phase 3 — serialize the finished PDF to bytes.
pub(crate) fn pdf_export_finish(state: PdfExportState) -> Vec<u8> {
    let mut buf = std::io::BufWriter::new(Vec::new());
    let _ = state.pdf_doc.save(&mut buf);
    buf.into_inner().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Convenience wrapper (used by tests and the old single-call path)
// ---------------------------------------------------------------------------

pub fn export_pdf(doc: &PhotobookDocument, images_json: &str, fonts_json: &str) -> Vec<u8> {
    let Some(mut state) = pdf_export_begin(doc, images_json, fonts_json) else {
        return Vec::new();
    };
    while state.next_spread < state.total {
        pdf_export_spread_one(&mut state, doc);
    }
    pdf_export_finish(state)
}

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

fn decode_image(data_base64: &str) -> Option<DecodedImage> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64).ok()?;
    let format = image::guess_format(&bytes).ok()?;
    let img = image::load_from_memory_with_format(&bytes, format).ok()?;
    let is_jpeg = matches!(format, image::ImageFormat::Jpeg);
    Some(DecodedImage { img, is_jpeg })
}

// ---------------------------------------------------------------------------
// Image placement — crop to visible region, deduplicate, then embed
// ---------------------------------------------------------------------------

/// All data needed to paint one image frame. The `xobj` is the ready-to-embed
/// `ImageXObject`; `xobj_ref` is filled in after deduplication (initially None).
struct Prepared {
    xobj: ImageXObject,
    xobj_ref: Option<XObjectRef>,
    crop: CropRect,
    new_x_mm: f32,
    new_y_mm: f32,
    final_scale_x: f32,
    final_scale_y: f32,
    rotate: Option<ImageRotation>,
    dpi: f32,
}

/// Encode a DynamicImage as an `ImageXObject`.
/// JPEG sources → DCTDecode; PNGs → FlateDecode.
fn image_to_xobject(img: &image::DynamicImage, is_jpeg: bool) -> Option<ImageXObject> {
    if is_jpeg {
        let rgb = img.to_rgb8();
        let mut jpeg_bytes: Vec<u8> = Vec::new();
        {
            use image::codecs::jpeg::JpegEncoder;
            JpegEncoder::new_with_quality(&mut jpeg_bytes, 92)
                .encode_image(&rgb)
                .ok()?;
        }
        Some(ImageXObject {
            width: Px(rgb.width() as usize),
            height: Px(rgb.height() as usize),
            color_space: ColorSpace::Rgb,
            bits_per_component: ColorBits::Bit8,
            interpolate: true,
            image_data: jpeg_bytes,
            image_filter: Some(ImageFilter::DCT),
            smask: None,
            clipping_bbox: None,
        })
    } else {
        Some(Image::from_dynamic_image(img).image)
    }
}

/// Crop rectangle in source-image pixel space (top-left origin).
struct CropRect {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
}

/// Compute the axis-aligned bounding box of frame corners inverse-rotated into image pixel space.
/// Returns a `CropRect` clamped to the image bounds.
fn compute_crop(
    frame_rect: &Rect,
    bleed: f32,
    page_h_mm: f32,
    img_w: u32,
    img_h: u32,
    sw: f32,   // rendered image width in mm
    sh: f32,   // rendered image height in mm
    x_mm: f32, // image left edge in PDF coords (mm, bottom-left origin)
    y_mm: f32, // image bottom edge in PDF coords
    rotation_deg: f32,
) -> CropRect {
    let px_per_mm_x = img_w as f32 / sw;
    let px_per_mm_y = img_h as f32 / sh;

    // Frame rectangle in PDF coords (mm, bottom-left origin).
    let frame_x = frame_rect.x + bleed;
    let frame_y = page_h_mm + bleed - frame_rect.y - frame_rect.h;
    let frame_w = frame_rect.w;
    let frame_h = frame_rect.h;

    // Image centre in PDF coords.
    let cx_pdf = x_mm + sw / 2.0;
    let cy_pdf = y_mm + sh / 2.0;

    let rad = rotation_deg.to_radians();
    let cos_t = rad.cos();
    let sin_t = rad.sin();

    // Helper: map a PDF-space point to image pixel coords via inverse rotation.
    let to_px = |fx: f32, fy: f32| -> (f32, f32) {
        let dx = fx - cx_pdf;
        let dy = fy - cy_pdf;
        // CW rotation by theta (inverse of the CCW rotation applied to the image).
        let dx_rot = dx * cos_t + dy * sin_t;
        let dy_rot = -dx * sin_t + dy * cos_t;
        // Translate to image-space mm (origin at image bottom-left).
        let img_x_mm = dx_rot + sw / 2.0;
        let img_y_mm = dy_rot + sh / 2.0;
        // Convert to pixel coords (top-left origin: flip y).
        let px_x = img_x_mm * px_per_mm_x;
        let px_y = img_h as f32 - img_y_mm * px_per_mm_y;
        (px_x, px_y)
    };

    // Inverse-rotate all four frame corners into image pixel space.
    let corners = [
        to_px(frame_x,          frame_y),
        to_px(frame_x + frame_w, frame_y),
        to_px(frame_x + frame_w, frame_y + frame_h),
        to_px(frame_x,          frame_y + frame_h),
    ];

    let min_x = corners.iter().map(|c| c.0).fold(f32::INFINITY,  f32::min);
    let max_x = corners.iter().map(|c| c.0).fold(f32::NEG_INFINITY, f32::max);
    let min_y = corners.iter().map(|c| c.1).fold(f32::INFINITY,  f32::min);
    let max_y = corners.iter().map(|c| c.1).fold(f32::NEG_INFINITY, f32::max);

    // Add 1-pixel margin for sub-pixel rounding, then clamp to image bounds.
    let left  = ((min_x - 1.0).floor() as i64).clamp(0, img_w as i64) as u32;
    let top   = ((min_y - 1.0).floor() as i64).clamp(0, img_h as i64) as u32;
    let right = ((max_x + 1.0).ceil()  as i64).clamp(0, img_w as i64) as u32;
    let bot   = ((max_y + 1.0).ceil()  as i64).clamp(0, img_h as i64) as u32;

    let width  = right.saturating_sub(left).max(1);
    let height = bot.saturating_sub(top).max(1);

    CropRect { left, top, width, height }
}

/// Compute the crop, resample, and encode the image for one frame.
/// Returns `None` if the image is degenerate. The caller embeds the
/// `ImageXObject` once and may reuse it across frames with the same crop.
#[allow(clippy::too_many_arguments)]
fn prepare_image(
    decoded: &DecodedImage,
    frame_rect: &Rect,
    bleed: f32,
    page_h_mm: f32,
    pan_x: f32,
    pan_y: f32,
    user_scale: f32,
    rotation_deg: f32,
    print_dpi: f32,
) -> Option<Prepared> {
    let img_w = decoded.img.width();
    let img_h = decoded.img.height();
    if img_w == 0 || img_h == 0 { return None; }

    let dpi = 300.0_f32;
    let nat_w_mm = img_w as f32 / dpi * 25.4;
    let nat_h_mm = img_h as f32 / dpi * 25.4;
    if nat_w_mm <= 0.0 || nat_h_mm <= 0.0 { return None; }

    // 1–3. Cover scale, rotation compensation, and total scale via shared helper.
    let (_, _, total_scale) = image_cover_factors(
        frame_rect.w, frame_rect.h, nat_w_mm, nat_h_mm, rotation_deg, user_scale,
    );
    let sw = nat_w_mm * total_scale; // rendered width in mm
    let sh = nat_h_mm * total_scale; // rendered height in mm

    // 4. Pan-offset placement of the original image in PDF coords.
    let overflow_x = sw - frame_rect.w;
    let overflow_y = sh - frame_rect.h;
    let x_mm = frame_rect.x + bleed - overflow_x * pan_x;
    let frame_cy_pdf = page_h_mm + bleed - frame_rect.y - frame_rect.h / 2.0;
    let y_img_center = frame_cy_pdf + (pan_y - 0.5) * overflow_y;
    let y_mm = y_img_center - sh / 2.0;

    // 5. Compute the crop rectangle in image pixel space.
    let crop = compute_crop(
        frame_rect, bleed, page_h_mm,
        img_w, img_h, sw, sh, x_mm, y_mm, rotation_deg,
    );

    // 6. Crop the image.
    let cropped = decoded.img.crop_imm(crop.left, crop.top, crop.width, crop.height);

    // 7. Resample to print_dpi (downsample only — never upsample source pixels).
    //    rendered size of the crop in inches:
    let crop_rendered_w_in = crop.width  as f32 * sw / (img_w as f32 * 25.4);
    let crop_rendered_h_in = crop.height as f32 * sh / (img_h as f32 * 25.4);
    let target_w = ((crop_rendered_w_in * print_dpi).round() as u32).clamp(1, crop.width);
    let target_h = ((crop_rendered_h_in * print_dpi).round() as u32).clamp(1, crop.height);
    let final_img = if target_w < crop.width || target_h < crop.height {
        cropped.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3)
    } else {
        cropped
    };

    // 8. Build ImageXObject (JPEG or FlateDecode depending on source format).
    let xobj = image_to_xobject(&final_img, decoded.is_jpeg)?;

    // 9. Adjust placement.
    let new_x_mm = x_mm + crop.left as f32 * sw / img_w as f32;
    let new_y_mm = y_mm + (img_h - crop.top - crop.height) as f32 * sh / img_h as f32;
    let final_scale_x = crop.width  as f32 * total_scale / final_img.width()  as f32;
    let final_scale_y = crop.height as f32 * total_scale / final_img.height() as f32;

    let rot_cx_px = (img_w / 2).saturating_sub(crop.left);
    let rot_cy_px = (img_h / 2).saturating_sub(crop.top);
    let rotate = if rotation_deg.abs() > 0.001 {
        Some(ImageRotation {
            angle_ccw_degrees: rotation_deg,
            rotation_center_x: Px(rot_cx_px as usize),
            rotation_center_y: Px(rot_cy_px as usize),
        })
    } else {
        None
    };

    Some(Prepared {
        xobj,
        xobj_ref: None,
        crop,
        new_x_mm,
        new_y_mm,
        final_scale_x,
        final_scale_y,
        rotate,
        dpi,
    })
}

/// Apply a combined node-transform CTM (CCW rotation + uniform scale) centred on `frame`.
/// Does nothing when the transform is effectively the identity.
/// Must be called inside a `save_graphics_state` / `restore_graphics_state` pair.
fn apply_node_ctm(
    layer: &PdfLayerReference,
    rotation_deg: f32,
    frame: &Rect,
    bleed: f32,
    page_h_mm: f32,
) {
    if rotation_deg.abs() < 0.001 { return; }
    // Frame centre in PDF pt coords (bottom-left origin).
    let cx = mm_to_pt(frame.x + bleed + frame.w / 2.0);
    let cy = mm_to_pt(page_h_mm + bleed - frame.y - frame.h / 2.0);
    let rad = rotation_deg.to_radians();
    let cos_r = rad.cos();
    let sin_r = rad.sin();
    // Rotation CTM centred on (cx, cy): T(cx,cy) · R(θ) · T(-cx,-cy)
    let a = cos_r;
    let b = sin_r;
    let c = -sin_r;
    let d = cos_r;
    let e = cx * (1.0 - cos_r) + cy * sin_r;
    let f = cy * (1.0 - cos_r) - cx * sin_r;
    use printpdf::lopdf::content::Operation;
    use printpdf::lopdf::Object::Real;
    layer.add_operation(Operation::new("cm", vec![Real(a), Real(b), Real(c), Real(d), Real(e), Real(f)]));
}

/// Paint a previously-registered image XObject onto the layer with clipping.
fn paint_image(
    layer: &PdfLayerReference,
    xobj_ref: XObjectRef,
    prep: &Prepared,
    frame_rect: &Rect,
    face_rotation_deg: f32,
    border_radius_mm: f32,
    bleed: f32,
    page_h_mm: f32,
) {
    let img_w = match &prep.xobj.width { Px(w) => *w as f32, };
    let img_h = match &prep.xobj.height { Px(h) => *h as f32, };

    let image_w_pt = img_w / prep.dpi * 72.0 * prep.final_scale_x;
    let image_h_pt = img_h / prep.dpi * 72.0 * prep.final_scale_y;

    let mut transforms: Vec<CurTransMat> = Vec::new();
    transforms.push(CurTransMat::Scale(image_w_pt, image_h_pt));

    if let Some(ref rot) = prep.rotate {
        let cx = rot.rotation_center_x.0 as f32 / prep.dpi * 72.0 * prep.final_scale_x;
        let cy = rot.rotation_center_y.0 as f32 / prep.dpi * 72.0 * prep.final_scale_y;
        transforms.push(CurTransMat::Translate(Pt(-cx), Pt(-cy)));
        transforms.push(CurTransMat::Rotate(rot.angle_ccw_degrees));
        transforms.push(CurTransMat::Translate(Pt(cx), Pt(cy)));
    }

    let tx = prep.new_x_mm * 72.0 / 25.4;
    let ty = prep.new_y_mm * 72.0 / 25.4;
    transforms.push(CurTransMat::Translate(Pt(tx), Pt(ty)));

    // Clip to the frame rectangle.
    let cx = mm_to_pt(frame_rect.x + bleed);
    let cy = mm_to_pt(page_h_mm + bleed - frame_rect.y - frame_rect.h);
    let cw = mm_to_pt(frame_rect.w);
    let ch = mm_to_pt(frame_rect.h);

    use printpdf::lopdf::content::Operation;

    layer.save_graphics_state();
    apply_node_ctm(layer, face_rotation_deg, frame_rect, bleed, page_h_mm);
    add_rounded_rect_path(layer, cx, cy, cw, ch, mm_to_pt(border_radius_mm));
    layer.add_operation(Operation::new("W", vec![]));
    layer.add_operation(Operation::new("n", vec![]));
    layer.use_xobject(xobj_ref, &transforms);
    layer.restore_graphics_state();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn frame_page_rect(spread_rect: &Rect, region_x: f32) -> Rect {
    Rect::new(spread_rect.x - region_x, spread_rect.y, spread_rect.w, spread_rect.h)
}

/// Emit a rounded-rectangle path into the layer (PDF points, Y-up coords).
/// Falls back to the `re` operator when radius ≤ 0 for maximum compatibility.
/// The caller is responsible for the paint/clip operator that follows (S, W+n, etc.).
fn add_rounded_rect_path(layer: &PdfLayerReference, x: f32, y: f32, w: f32, h: f32, r: f32) {
    use printpdf::lopdf::content::Operation;
    use printpdf::lopdf::Object::Real;

    if r <= 0.0 {
        layer.add_operation(Operation::new("re", vec![Real(x), Real(y), Real(w), Real(h)]));
        return;
    }
    // Clamp so opposite corners don't overlap.
    let r = r.min(w / 2.0).min(h / 2.0);
    // Bézier approximation constant for a quarter-circle arc.
    const K: f32 = 0.5523;
    let kr = K * r;

    // Clockwise path starting at the bottom-left of the bottom edge (Y-up coordinates).
    layer.add_operation(Operation::new("m", vec![Real(x + r), Real(y)]));
    layer.add_operation(Operation::new("l", vec![Real(x + w - r), Real(y)]));
    layer.add_operation(Operation::new("c", vec![
        Real(x + w - r + kr), Real(y),
        Real(x + w), Real(y + kr),
        Real(x + w), Real(y + r),
    ]));
    layer.add_operation(Operation::new("l", vec![Real(x + w), Real(y + h - r)]));
    layer.add_operation(Operation::new("c", vec![
        Real(x + w), Real(y + h - r + kr),
        Real(x + w - r + kr), Real(y + h),
        Real(x + w - r), Real(y + h),
    ]));
    layer.add_operation(Operation::new("l", vec![Real(x + r), Real(y + h)]));
    layer.add_operation(Operation::new("c", vec![
        Real(x + r - kr), Real(y + h),
        Real(x), Real(y + h - r + kr),
        Real(x), Real(y + h - r),
    ]));
    layer.add_operation(Operation::new("l", vec![Real(x), Real(y + r)]));
    layer.add_operation(Operation::new("c", vec![
        Real(x), Real(y + r - kr),
        Real(x + r - kr), Real(y),
        Real(x + r), Real(y),
    ]));
    layer.add_operation(Operation::new("h", vec![]));
}

#[inline]
fn mm_to_pt(mm: f32) -> f32 { mm * 72.0 / 25.4 }

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

/// Build a lopdf dictionary that overrides TrimBox and adds BleedBox on a page.
///
/// The printpdf serializer writes TrimBox = MediaBox by default, which incorrectly
/// includes the bleed area. We replace it with the actual trim (content) rectangle and
/// add the BleedBox that preflighting tools use to identify the bleed extent.
///
/// All coordinates are in PDF user-space points (1 pt = 1/72 inch).
///   MediaBox / BleedBox: [0, 0, total_w_pt, total_h_pt]
///   TrimBox:             [bleed_pt, bleed_pt, total_w_pt − bleed_pt, total_h_pt − bleed_pt]
fn page_box_extension(spread_w: f32, ph: f32, bleed: f32) -> printpdf::lopdf::Dictionary {
    const PT_PER_MM: f32 = 72.0 / 25.4;
    let bleed_pt  = bleed * PT_PER_MM;
    let total_w   = (spread_w + 2.0 * bleed) * PT_PER_MM;
    let total_h   = (ph      + 2.0 * bleed) * PT_PER_MM;

    use printpdf::lopdf::Object::{Array, Real};
    let trim_box  = Array(vec![Real(bleed_pt), Real(bleed_pt), Real(total_w - bleed_pt), Real(total_h - bleed_pt)]);
    let bleed_box = Array(vec![Real(0.0),      Real(0.0),      Real(total_w),             Real(total_h)]);

    let mut dict = printpdf::lopdf::Dictionary::new();
    dict.set("TrimBox",  trim_box);
    dict.set("BleedBox", bleed_box);
    dict
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
fn draw_border_rect(
    layer: &PdfLayerReference,
    frame: &Rect,
    bleed: f32,
    page_h_mm: f32,
    border: &Border,
) {
    let (wt, wr, wb, wl) = border.side_widths();
    let (cr, cg, cb) = parse_hex_color(&border.color);
    layer.set_outline_color(Color::Rgb(Rgb::new(cr, cg, cb, None)));

    // When all sides are equal, use the rounded-rect path (supports border_radius).
    if wt == wr && wr == wb && wb == wl {
        let w = wt;
        let hw = w / 2.0;
        let (fx, fy, fw, fh) = match border.position {
            BorderPosition::Inner => (
                frame.x + hw, frame.y + hw,
                (frame.w - w).max(0.0),
                (frame.h - w).max(0.0),
            ),
            BorderPosition::Outer => (
                frame.x - hw, frame.y - hw,
                frame.w + w,
                frame.h + w,
            ),
            BorderPosition::Centered | BorderPosition::Mixed => (frame.x, frame.y, frame.w, frame.h),
        };
        let base_r = border.radius.max(0.0);
        let stroke_r = match border.position {
            BorderPosition::Inner  => (base_r - hw).max(0.0),
            BorderPosition::Outer  => base_r + hw,
            BorderPosition::Centered | BorderPosition::Mixed => base_r,
        };
        use printpdf::lopdf::content::Operation;
        layer.set_outline_thickness(w * 72.0 / 25.4);
        let x1_pt = mm_to_pt(fx + bleed);
        let y1_pt = mm_to_pt(page_h_mm + bleed - fy - fh);
        add_rounded_rect_path(layer, x1_pt, y1_pt, mm_to_pt(fw), mm_to_pt(fh), mm_to_pt(stroke_r));
        layer.add_operation(Operation::new("S", vec![]));
        return;
    }

    // Per-side: draw 4 separate line segments.
    use printpdf::lopdf::content::Operation;
    use printpdf::lopdf::Object::Real;
    let ph = page_h_mm + bleed;

    let draw_line = |lw: f32, x1: f32, y1: f32, x2: f32, y2: f32| {
        if lw <= 0.0 { return; }
        layer.set_outline_thickness(lw * 72.0 / 25.4);
        let (px1, py1) = (mm_to_pt(x1 + bleed), mm_to_pt(ph - y1));
        let (px2, py2) = (mm_to_pt(x2 + bleed), mm_to_pt(ph - y2));
        layer.add_operation(Operation::new("m", vec![Real(px1), Real(py1)]));
        layer.add_operation(Operation::new("l", vec![Real(px2), Real(py2)]));
        layer.add_operation(Operation::new("S", vec![]));
    };

    let (fx, fy, fw, fh) = (frame.x, frame.y, frame.w, frame.h);
    match border.position {
        BorderPosition::Inner => {
            draw_line(wt, fx,        fy + wt/2.0, fx + fw,        fy + wt/2.0);
            draw_line(wr, fx + fw - wr/2.0, fy, fx + fw - wr/2.0, fy + fh);
            draw_line(wb, fx,        fy + fh - wb/2.0, fx + fw,   fy + fh - wb/2.0);
            draw_line(wl, fx + wl/2.0, fy, fx + wl/2.0,           fy + fh);
        }
        BorderPosition::Outer => {
            draw_line(wt, fx,        fy - wt/2.0, fx + fw,        fy - wt/2.0);
            draw_line(wr, fx + fw + wr/2.0, fy, fx + fw + wr/2.0, fy + fh);
            draw_line(wb, fx,        fy + fh + wb/2.0, fx + fw,   fy + fh + wb/2.0);
            draw_line(wl, fx - wl/2.0, fy, fx - wl/2.0,           fy + fh);
        }
        BorderPosition::Centered | BorderPosition::Mixed => {
            draw_line(wt, fx,      fy,      fx + fw, fy);
            draw_line(wr, fx + fw, fy,      fx + fw, fy + fh);
            draw_line(wb, fx,      fy + fh, fx + fw, fy + fh);
            draw_line(wl, fx,      fy,      fx,      fy + fh);
        }
    }
}

// ---------------------------------------------------------------------------
// Text element rendering
// ---------------------------------------------------------------------------

/// Resolve a TextElement's font, preferring an embedded TTF/OTF supplied by the
/// frontend (via queryLocalFonts). Falls back to the nearest PDF built-in font.
fn resolve_font<'a>(
    pdf_doc: &PdfDocumentReference,
    cache: &'a mut HashMap<String, IndirectFontRef>,
    family: &str,
    bold: bool,
    italic: bool,
    font_bytes_map: &HashMap<String, Vec<u8>>,
) -> &'a IndirectFontRef {
    let key = format!("{}:{}:{}", family, bold as u8, italic as u8);
    cache.entry(key).or_insert_with(|| {
        // Try to embed the real font file if the frontend provided it.
        if let Some(bytes) = font_bytes_map.get(&format!("{}:{}:{}", family, bold as u8, italic as u8)) {
            if let Ok(font_ref) = pdf_doc.add_external_font(std::io::Cursor::new(bytes.as_slice())) {
                return font_ref;
            }
        }

        // Fallback: nearest PDF built-in (Latin-1 only).
        let builtin = match family.to_ascii_lowercase().as_str() {
            "times new roman" | "times" | "serif" => match (bold, italic) {
                (true,  true)  => BuiltinFont::TimesBoldItalic,
                (true,  false) => BuiltinFont::TimesBold,
                (false, true)  => BuiltinFont::TimesItalic,
                _              => BuiltinFont::TimesRoman,
            },
            "courier" | "courier new" | "monospace" => match (bold, italic) {
                (true,  true)  => BuiltinFont::CourierBoldOblique,
                (true,  false) => BuiltinFont::CourierBold,
                (false, true)  => BuiltinFont::CourierOblique,
                _              => BuiltinFont::Courier,
            },
            _ => match (bold, italic) {
                (true,  true)  => BuiltinFont::HelveticaBoldOblique,
                (true,  false) => BuiltinFont::HelveticaBold,
                (false, true)  => BuiltinFont::HelveticaOblique,
                _              => BuiltinFont::Helvetica,
            },
        };
        pdf_doc.add_builtin_font(builtin).expect("builtin font")
    })
}

/// Draw all text elements onto `layer`.
///
/// `spread_offset_x` is the left edge of this page's region within the spread
/// (non-zero for the right half of a cover spread split across two pages).
fn draw_text_elements(
    layer: &PdfLayerReference,
    elements: &[TextElement],
    spread_offset_x: f32,
    bleed: f32,
    page_h_mm: f32,
    pdf_doc: &PdfDocumentReference,
    font_cache: &mut HashMap<String, IndirectFontRef>,
    font_bytes_map: &HashMap<String, Vec<u8>>,
) {
    for el in elements {
        let font = resolve_font(pdf_doc, font_cache, &el.font_family, el.bold, el.italic, font_bytes_map).clone();

        let (r, g, b) = parse_hex_color(&el.color);

        let font_size_pt = el.font_size_pt;
        // Line height in mm (1 pt = 1/72 inch = 25.4/72 mm).
        let line_h_mm = font_size_pt * (25.4 / 72.0) * 1.2;

        // Base text origin in PDF coordinate space (mm, y-up, bleed-offset):
        // x: from left side of page (subtract spread offset, add bleed)
        // y: from top of page going down — in PDF y-up, the text baseline of the first
        //    line sits at (page_h + bleed - el.y_mm - first_baseline_below_top).
        let base_x_mm = el.x_mm - spread_offset_x + bleed;
        // PDF y for the top edge of the bounding box:
        let top_y_mm  = page_h_mm + bleed - el.y_mm;
        // First baseline: one line-height below the top edge.
        let baseline_y_mm = top_y_mm - font_size_pt * (25.4 / 72.0);

        // Lines of text.
        let lines: Vec<&str> = el.content.split('\n').collect();

        let rad = el.rotation_deg.to_radians();
        let cos_r = rad.cos();
        let sin_r = rad.sin();

        layer.save_graphics_state();
        layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
        layer.begin_text_section();
        layer.set_font(&font, font_size_pt);

        for (i, line) in lines.iter().enumerate() {
            if line.is_empty() && i == lines.len() - 1 { continue; }

            // Position for this line (advances down by line_h_mm per row).
            let line_offset_mm = i as f32 * line_h_mm;
            // In the text-rotation frame, "down" is perpendicular to the text direction.
            // Unrotated: dx=0, dy=-line_offset_mm.  After CCW rotation by rotation_deg:
            let tx_mm = base_x_mm - line_offset_mm * rad.sin();
            let ty_mm = baseline_y_mm - line_offset_mm * rad.cos();

            let tx_pt = mm_to_pt(tx_mm);
            let ty_pt = mm_to_pt(ty_mm);

            // Tm operator: sets text matrix = rotation + translation.
            use printpdf::lopdf::content::Operation;
            use printpdf::lopdf::Object::Real;
            layer.add_operation(Operation::new("Tm", vec![
                Real(cos_r), Real(sin_r),
                Real(-sin_r), Real(cos_r),
                Real(tx_pt), Real(ty_pt),
            ]));

            // Encode to WinAnsi (Latin-1 subset); replace unsupported chars with '?'.
            let encoded: String = line.chars()
                .map(|c| if (c as u32) < 256 { c } else { '?' })
                .collect();
            layer.write_text(&encoded, &font);
        }

        layer.end_text_section();
        layer.restore_graphics_state();
    }
}

/// Returns (sw, sh, x_mm, y_mm, total_scale) — the fully-resolved placement
/// geometry for an image in a frame. Used by tests to inspect crop inputs.
#[cfg(test)]
fn placement_params(
    frame_rect: &Rect,
    img_w: u32,
    img_h: u32,
    pan_x: f32,
    pan_y: f32,
    user_scale: f32,
    rotation_deg: f32,
    bleed: f32,
    page_h_mm: f32,
) -> (f32, f32, f32, f32, f32) {
    let dpi = 300.0_f32;
    let nat_w_mm = img_w as f32 / dpi * 25.4;
    let nat_h_mm = img_h as f32 / dpi * 25.4;
    let cover_scale = (frame_rect.w / nat_w_mm).max(frame_rect.h / nat_h_mm);
    let rad = rotation_deg.to_radians();
    let cos_a = rad.cos().abs();
    let sin_a = rad.sin().abs();
    let sw0 = nat_w_mm * cover_scale;
    let sh0 = nat_h_mm * cover_scale;
    let rot_factor = if sw0 > 0.0 && sh0 > 0.0 {
        ((frame_rect.w * cos_a + frame_rect.h * sin_a) / sw0)
            .max((frame_rect.w * sin_a + frame_rect.h * cos_a) / sh0)
            .max(1.0)
    } else { 1.0 };
    let total_scale = cover_scale * rot_factor * user_scale.max(1.0);
    let sw = nat_w_mm * total_scale;
    let sh = nat_h_mm * total_scale;
    let overflow_x = sw - frame_rect.w;
    let overflow_y = sh - frame_rect.h;
    let x_mm = frame_rect.x + bleed - overflow_x * pan_x;
    let frame_cy_pdf = page_h_mm + bleed - frame_rect.y - frame_rect.h / 2.0;
    let y_img_center = frame_cy_pdf + (pan_y - 0.5) * overflow_y;
    let y_mm = y_img_center - sh / 2.0;
    (sw, sh, x_mm, y_mm, total_scale)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page::PhotobookDocument;

    fn assert_valid_pdf(bytes: &[u8]) {
        assert!(!bytes.is_empty(), "PDF must not be empty");
        assert!(bytes.starts_with(b"%PDF-"), "PDF must start with %PDF- header");
    }

    /// Build a one-spread document with a single unsplit frame, optionally
    /// with an image assigned.
    fn doc_single_frame(img_id: Option<&str>) -> PhotobookDocument {
        let mut doc = PhotobookDocument::new(210.0, 297.0, 3.0);
        if let Some(id) = img_id {
            let spread = &mut doc.spreads[1];
            let face_id = *spread.layout.faces.keys().next().unwrap();
            spread.layout.faces.get_mut(&face_id).unwrap().image.image_id = Some(id.to_string());
            doc.current_spread = 1;
        }
        doc
    }

    #[test]
    fn pdf_empty_frame_produces_valid_pdf() {
        let doc = doc_single_frame(None);
        let pdf = export_pdf(&doc, "[]", "[]");
        assert_valid_pdf(&pdf);
    }

    #[test]
    fn pdf_single_jpeg_produces_valid_pdf() {
        let (b64, _) = make_jpeg(100, 100);
        let doc = doc_single_frame(Some("img"));
        let pdf = run_export(&doc, "img", &b64, 100, 100);
        assert_valid_pdf(&pdf);
    }

    #[test]
    fn pdf_single_png_produces_valid_pdf() {
        let (b64, _) = make_png(100, 100);
        let doc = doc_single_frame(Some("img"));
        let pdf = run_export(&doc, "img", &b64, 100, 100);
        assert_valid_pdf(&pdf);
    }

    #[test]
    fn pdf_tiny_image_produces_valid_pdf() {
        // 1×1 pixel is the smallest valid image.
        let (b64, _) = make_jpeg(1, 1);
        let doc = doc_single_frame(Some("img"));
        let pdf = run_export(&doc, "img", &b64, 1, 1);
        assert_valid_pdf(&pdf);
    }

    #[test]
    fn pdf_unknown_image_id_produces_valid_pdf() {
        // Frame references an image that isn't in the images JSON → should not
        // crash; the frame is rendered as empty.
        let (b64, _) = make_jpeg(100, 100);
        let doc = doc_single_frame(Some("missing_id"));
        let pdf = run_export(&doc, "other_id", &b64, 100, 100);
        assert_valid_pdf(&pdf);
    }

    #[test]
    fn pdf_single_jpeg_is_larger_than_empty() {
        let (b64, _) = make_jpeg(300, 300);
        let empty_pdf  = export_pdf(&doc_single_frame(None), "[]", "[]");
        let filled_pdf = run_export(&doc_single_frame(Some("img")), "img", &b64, 300, 300);
        assert!(filled_pdf.len() > empty_pdf.len(),
            "PDF with an image should be larger than one without");
    }

    /// Generate a synthetic PNG of size `w × h` pixels and return it as a
    /// base64-encoded string together with the raw byte length.
    fn make_png(w: u32, h: u32) -> (String, usize) {
        use image::{RgbaImage, Rgba};
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, Rgba([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, 128, 255]));
            }
        }
        let mut png_bytes = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png).unwrap();
        let raw_len = png_bytes.len();
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        (b64, raw_len)
    }

    /// Generate a synthetic JPEG of size `w × h` pixels and return it as a
    /// base64-encoded string together with the raw byte length for comparison.
    fn make_jpeg(w: u32, h: u32) -> (String, usize) {
        use image::{RgbImage, Rgb};
        use image::codecs::jpeg::JpegEncoder;

        let mut img = RgbImage::new(w, h);
        // Fill with a simple gradient so JPEG has something real to compress.
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, Rgb([
                    (x * 255 / w) as u8,
                    (y * 255 / h) as u8,
                    128,
                ]));
            }
        }
        let mut jpeg_bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg_bytes, 90)
            .encode_image(&img)
            .unwrap();

        let raw_len = jpeg_bytes.len();
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
        (b64, raw_len)
    }

    /// Build a one-spread document split into `n_cols` equal vertical frames.
    fn doc_with_n_frames(n_cols: usize, img_id: &str) -> PhotobookDocument {
        let mut doc = PhotobookDocument::new(210.0, 297.0, 3.0);
        let spread = &mut doc.spreads[1];
        let layout = &mut spread.layout;

        let mut current_id: u32 = *layout.faces.keys().next().unwrap();
        for i in 0..n_cols.saturating_sub(1) {
            let ratio = 1.0 / (n_cols - i) as f32;
            let (rx, ry, rw, rh) = layout.face_rect(current_id).unwrap();
            let x = rx + ratio * rw;
            layout.split_face(current_id, x, crate::layout::SplitAxis::Vertical);
            if let Some(face) = layout.faces.get_mut(&current_id) {
                face.image.image_id = Some(img_id.to_string());
            }
            let probe_x = (x + rx + rw) / 2.0;
            current_id = layout.face_at(probe_x, ry + rh * 0.5)
                .unwrap_or(current_id);
        }
        if let Some(face) = layout.faces.get_mut(&current_id) {
            face.image.image_id = Some(img_id.to_string());
        }

        doc.current_spread = 1;
        doc
    }

    fn run_export(doc: &PhotobookDocument, img_id: &str, b64: &str, w: u32, h: u32) -> Vec<u8> {
        let entry = ImageEntry {
            id: img_id.to_string(),
            data_base64: b64.to_string(),
            width_px: w,
            height_px: h,
        };
        let images_json = serde_json::to_string(&[entry]).unwrap();
        export_pdf(doc, &images_json, "[]")
    }

    #[test]
    fn pdf_size_scales_with_placement_count() {
        let (b64, src_bytes) = make_jpeg(3000, 2000);
        println!("Source JPEG size: {} KB", src_bytes / 1024);

        let sizes: Vec<(usize, usize)> = (1..=4)
            .map(|n| {
                let doc = doc_with_n_frames(n, "img");
                let pdf = run_export(&doc, "img", &b64, 3000, 2000);
                let kb = pdf.len() / 1024;
                println!("{n} frame(s): {} KB", kb);
                (n, pdf.len())
            })
            .collect();

        // Validate PDFs are non-empty.
        for (n, sz) in &sizes {
            assert!(*sz > 0, "{n} frames produced empty PDF");
        }

        // With cropping + print-DPI resampling the spread width is constant,
        // so N placements should not cost significantly more than 1.
        // Allow up to 1.5× growth from 1 → 4 frames (mostly PDF structure overhead).
        let size_1 = sizes[0].1 as f64;
        let size_4 = sizes[3].1 as f64;
        let ratio = size_4 / size_1;
        println!("Size ratio 4-frame / 1-frame: {:.2}×", ratio);
        assert!(
            ratio < 1.5,
            "4-frame PDF is {:.2}× the 1-frame size — cropping is not working correctly",
            ratio
        );
    }

    /// Verify that TrimBox and BleedBox are correctly set in the exported PDF.
    ///
    /// The exact page width varies per spread (cover includes spine), so we derive
    /// expected values from the MediaBox rather than hard-coding mm arithmetic.
    /// Invariants that must hold for every page:
    ///   BleedBox == MediaBox          (full bleed-extended page)
    ///   TrimBox  == MediaBox inset by bleed_pt on all four sides
    #[test]
    fn pdf_page_boxes_trimbox_and_bleedbox() {
        const PT_PER_MM: f32 = 72.0 / 25.4;
        let bleed_pt = 3.0_f32 * PT_PER_MM; // doc uses 3mm bleed

        let doc = doc_single_frame(None);
        let pdf = export_pdf(&doc, "[]", "[]");

        let parsed = printpdf::lopdf::Document::load_mem(&pdf)
            .expect("PDF should be parseable by lopdf");

        let pages = parsed.get_pages();
        assert!(!pages.is_empty(), "PDF should have at least one page");

        let tol = 0.01_f32;
        for (_page_num, page_id) in pages {
            let page_dict = parsed.get_object(page_id)
                .and_then(|o| o.as_dict())
                .expect("page object should be a dictionary");

            let get_box = |key: &[u8]| -> Vec<f32> {
                page_dict.get(key)
                    .unwrap_or_else(|_| panic!("/{} should be present", String::from_utf8_lossy(key)))
                    .as_array()
                    .unwrap_or_else(|_| panic!("/{} should be an array", String::from_utf8_lossy(key)))
                    .iter()
                    .map(|o| o.as_float().expect("box element should be numeric"))
                    .collect()
            };

            let media  = get_box(b"MediaBox");
            let trim   = get_box(b"TrimBox");
            let bleed  = get_box(b"BleedBox");

            assert_eq!(media.len(), 4);
            assert_eq!(trim.len(),  4);
            assert_eq!(bleed.len(), 4);

            // BleedBox == MediaBox
            for i in 0..4 {
                assert!((bleed[i] - media[i]).abs() < tol,
                    "BleedBox[{i}] ({}) should equal MediaBox[{i}] ({})", bleed[i], media[i]);
            }

            // TrimBox is MediaBox inset by bleed_pt
            assert!((trim[0] - bleed_pt).abs() < tol,          "TrimBox x0 wrong: got {}", trim[0]);
            assert!((trim[1] - bleed_pt).abs() < tol,          "TrimBox y0 wrong: got {}", trim[1]);
            assert!((trim[2] - (media[2] - bleed_pt)).abs() < tol, "TrimBox x1 wrong: got {}", trim[2]);
            assert!((trim[3] - (media[3] - bleed_pt)).abs() < tol, "TrimBox y1 wrong: got {}", trim[3]);
        }
    }

}

