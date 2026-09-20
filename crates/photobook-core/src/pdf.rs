use printpdf::{
    BuiltinFont, Color, IccProfile, IccProfileType, Image, ImageFilter, ImageRotation,
    ImageXObject, IndirectFontRef, Line, Mm, OutputIntentDescription, PdfConformance,
    Px, PdfDocument, PdfDocumentReference, PdfLayerReference, Point, Rgb,
    ColorBits, ColorSpace, CurTransMat, Pt, XObjectRef,
    path,
};
use crate::layout::{Border, BorderPosition, Rect};
use crate::page::{PhotobookDocument, SpreadKind, TextElement};
use crate::grid_resolver::resolve_frames_mm;
use crate::utils::image_cover_factors;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Compact sRGB v2 ICC profile (CC0, see assets/README.txt), embedded as the
/// PDF/X-4 output intent so DeviceRGB content is interpreted as sRGB by the
/// print RIP. Tagged sRGB hand-off is the accepted standard for digital photo
/// printing; no client-side CMYK conversion is attempted.
const SRGB_ICC: &[u8] = include_bytes!("../assets/sRGB-v2-magic.icc");

// ---------------------------------------------------------------------------
// Wall-clock helper — js_sys::Date::now() in WASM, SystemTime otherwise
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 { js_sys::Date::now() }

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Per-spread phase timing — returned from pdf_export_spread_one
// ---------------------------------------------------------------------------

#[derive(Default, Serialize)]
pub(crate) struct SpreadTimes {
    pub decode_ms:   f64,
    pub crop_ms:     f64,
    pub resample_ms: f64,
    pub color_ms:    f64,
    pub encode_ms:   f64,
    pub image_count: u32,
}

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
/// `orig_w`/`orig_h` are the full-resolution source dimensions — equal to
/// `img.width()`/`img.height()` for a full decode, smaller when a JPEG
/// scale-factor decode was used. All geometry computation uses these values
/// so that placement and crop math is independent of the chosen scale.
pub(crate) struct DecodedImage {
    img: image::DynamicImage,
    is_jpeg: bool,
    orig_w: u32,
    orig_h: u32,
    icc_profile: Option<Vec<u8>>,
}

// ---------------------------------------------------------------------------
// Export targets and page jobs
// ---------------------------------------------------------------------------

/// Which part of the document an export pass covers. Cover/Body allow the
/// frontend to produce the separate cover and interior PDFs print shops expect.
#[derive(Clone, Copy, PartialEq)]
pub enum ExportTarget {
    /// Every spread in one PDF (cover first).
    All,
    /// Cover spread only (with the wrap allowance applied).
    Cover,
    /// Interior spreads only.
    Body,
}

/// One output PDF page: a full spread, or one half of a spread when the
/// interior is exported as single pages (perfect binding).
pub(crate) struct PageJob {
    pub spread_idx: usize,
    /// Spread-space x of this page's trim-left edge (page width for the right
    /// half of a split spread, 0 otherwise).
    pub origin_x_mm: f32,
    /// Trim width of the output page.
    pub trim_w_mm: f32,
    /// Extra media allowance beyond the bleed on every side (hardcover wrap).
    pub wrap_mm: f32,
}

fn build_jobs(doc: &PhotobookDocument, target: ExportTarget) -> Vec<PageJob> {
    let page_w = doc.page_size.width_mm;
    let mut jobs = Vec::new();
    // Legacy path: a wraparound cover with cover-as-pages still set (documents
    // not yet normalized into CoverFront/CoverBack spreads). The back cover
    // becomes the LAST page of the file — held back until the end. Normalized
    // documents already store the back cover as the last spread.
    let mut back_cover: Option<PageJob> = None;

    for (i, spread) in doc.spreads.iter().enumerate() {
        let is_cover = spread.kind.is_cover();
        match target {
            ExportTarget::Cover if !is_cover => continue,
            ExportTarget::Body if is_cover => continue,
            _ => {}
        }
        let spread_w = doc.spread_width_mm(spread);
        if spread.kind == SpreadKind::Cover && doc.export_cover_pages {
            let wrap = doc.cover_wrap_mm.max(0.0);
            // Front cover is the right half of the cover spread (beyond the
            // spine, which shops in this mode generate themselves).
            jobs.push(PageJob { spread_idx: i, origin_x_mm: spread_w - page_w, trim_w_mm: page_w, wrap_mm: wrap });
            back_cover = Some(PageJob { spread_idx: i, origin_x_mm: 0.0, trim_w_mm: page_w, wrap_mm: wrap });
        } else if !is_cover && doc.export_body_pages {
            // Endpaper halves are non-printable and not part of the file —
            // shops that need blanks insert them in their own imposition.
            let endpaper_side = doc.endpaper_side(i);
            if endpaper_side != Some("left") {
                jobs.push(PageJob { spread_idx: i, origin_x_mm: 0.0,    trim_w_mm: page_w, wrap_mm: 0.0 });
            }
            if endpaper_side != Some("right") {
                jobs.push(PageJob { spread_idx: i, origin_x_mm: page_w, trim_w_mm: page_w, wrap_mm: 0.0 });
            }
        } else {
            jobs.push(PageJob {
                spread_idx: i,
                origin_x_mm: 0.0,
                trim_w_mm: spread_w,
                wrap_mm: if is_cover { doc.cover_wrap_mm.max(0.0) } else { 0.0 },
            });
        }
    }
    if let Some(back) = back_cover { jobs.push(back); }
    jobs
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
    /// Raw encoded image bytes, decoded on demand (keyed by image id).
    pub(crate) image_src: HashMap<String, Vec<u8>>,
    /// LRU cache of decoded images, bounded by `DECODED_IMAGE_BUDGET_BYTES`.
    decoded:           HashMap<String, DecodedImage>,
    decoded_order:     std::collections::VecDeque<String>,
    decoded_bytes:     usize,
    pub font_bytes_map: HashMap<String, Vec<u8>>,
    pub font_cache:    HashMap<String, IndirectFontRef>,
    pub bleed:         f32,
    pub ph:            f32,
    pub print_dpi:     f32,
    /// One entry per output PDF page (pre-allocated in the same order as `layers`).
    pub(crate) jobs:   Vec<PageJob>,
    pub next_job:      usize,
}

/// Budget for decoded (uncompressed) images held in memory during export.
/// Images are decoded lazily per spread and evicted LRU to stay under this.
const DECODED_IMAGE_BUDGET_BYTES: usize = 384 * 1024 * 1024;

impl PdfExportState {
    /// Ensure `id` is decoded at a resolution sufficient for `need_w × need_h`
    /// output pixels. For JPEG sources this picks the coarsest 1/N scale factor
    /// that still exceeds the needed dimensions, saving significant decode time.
    /// If a cached entry already has sufficient resolution it is reused as-is;
    /// if it is too small (image used at larger size on a later spread) it is
    /// evicted and re-decoded at the higher scale.
    fn ensure_decoded_scaled(&mut self, id: &str, need_w: u32, need_h: u32) {
        if let Some(cached) = self.decoded.get(id) {
            if cached.img.width() >= need_w && cached.img.height() >= need_h {
                self.touch_decoded(id);
                return;
            }
            // Cached version too small — evict before re-decoding at higher res.
            let sz = decoded_size_bytes(cached);
            self.decoded_bytes = self.decoded_bytes.saturating_sub(sz);
            self.decoded.remove(id);
            if let Some(pos) = self.decoded_order.iter().position(|x| x == id) {
                self.decoded_order.remove(pos);
            }
        }
        let Some(bytes) = self.image_src.get(id) else { return; };
        let decoded = jpeg_scaled_decode(bytes, need_w, need_h)
            .or_else(|| decode_image_bytes(bytes));
        let Some(decoded) = decoded else { return; };
        let sz = decoded_size_bytes(&decoded);
        self.decoded.insert(id.to_string(), decoded);
        self.decoded_order.push_back(id.to_string());
        self.decoded_bytes += sz;
        self.evict_decoded();
    }

    fn touch_decoded(&mut self, id: &str) {
        if let Some(pos) = self.decoded_order.iter().position(|x| x == id) {
            if let Some(s) = self.decoded_order.remove(pos) {
                self.decoded_order.push_back(s);
            }
        }
    }

    fn evict_decoded(&mut self) {
        while self.decoded_bytes > DECODED_IMAGE_BUDGET_BYTES && self.decoded_order.len() > 1 {
            let Some(old) = self.decoded_order.pop_front() else { break; };
            if let Some(d) = self.decoded.remove(&old) {
                self.decoded_bytes = self.decoded_bytes.saturating_sub(decoded_size_bytes(&d));
            }
        }
    }
}

/// Phase 1 — allocate one PDF page per page job using pre-decoded byte maps.
/// The fast path: callers have already decoded base64 or provided raw bytes.
/// Returns `None` only if the target selects no spreads (empty document).
pub(crate) fn pdf_export_begin_with_bytes(
    doc: &PhotobookDocument,
    image_src: HashMap<String, Vec<u8>>,
    font_bytes_map: HashMap<String, Vec<u8>>,
    target: ExportTarget,
) -> Option<PdfExportState> {
    let jobs = build_jobs(doc, target);
    if jobs.is_empty() { return None; }

    let bleed     = doc.bleed_mm;
    let ph        = doc.page_size.height_mm;
    let print_dpi = doc.print_dpi;

    let title = match target {
        ExportTarget::All   => "Photobook",
        ExportTarget::Cover => "Photobook Cover",
        ExportTarget::Body  => "Photobook Body",
    };
    let page_dims = |job: &PageJob| {
        let b = bleed + job.wrap_mm;
        (Mm(job.trim_w_mm + 2.0 * b), Mm(ph + 2.0 * b))
    };

    let (first_w, first_h) = page_dims(&jobs[0]);
    let (pdf_doc, first_pi, first_li) = PdfDocument::new(title, first_w, first_h, "Layer 1");
    // PDF/X-4 with an sRGB output intent: all content stays DeviceRGB and the
    // embedded intent tells the press RIP to interpret it as sRGB.
    let pdf_doc = pdf_doc
        .with_conformance(PdfConformance::X4_2010_PDF_1_4)
        .with_creator("Photobook Editor")
        .with_producer("Photobook Editor")
        .with_target_icc_profile(
            IccProfile::new(SRGB_ICC.to_vec(), IccProfileType::Rgb)
                .with_alternate_profile(false)
                .with_range(false),
        )
        .with_output_intent(OutputIntentDescription {
            output_condition_identifier: "Custom".into(),
            output_condition: "sRGB digital printing".into(),
            registry_name: None,
            info: "sRGB IEC61966-2.1".into(),
        });
    pdf_doc.get_page(first_pi)
        .extend_with(page_box_extension(jobs[0].trim_w_mm, ph, bleed, jobs[0].wrap_mm));
    let mut layers = vec![pdf_doc.get_page(first_pi).get_layer(first_li)];

    for job in jobs.iter().skip(1) {
        let (w, h) = page_dims(job);
        let (pi, li) = pdf_doc.add_page(w, h, "Layer 1");
        pdf_doc.get_page(pi)
            .extend_with(page_box_extension(job.trim_w_mm, ph, bleed, job.wrap_mm));
        layers.push(pdf_doc.get_page(pi).get_layer(li));
    }

    Some(PdfExportState {
        pdf_doc,
        layers,
        image_src,
        decoded: HashMap::new(),
        decoded_order: std::collections::VecDeque::new(),
        decoded_bytes: 0,
        font_bytes_map,
        font_cache: HashMap::new(),
        bleed,
        ph,
        print_dpi,
        jobs,
        next_job: 0,
    })
}

/// Phase 1 — decode images/fonts from base64 JSON, allocate one PDF page per spread.
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
    // Base64-decode (cheap) up front; full image decode is deferred to the
    // spread that actually uses each image (see `ensure_decoded`).
    let mut image_src: HashMap<String, Vec<u8>> = HashMap::new();
    for e in image_entries {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&e.data_base64) {
            image_src.insert(e.id, bytes);
        }
    }

    pdf_export_begin_with_bytes(doc, image_src, font_bytes_map, ExportTarget::All)
}

/// Phase 2 — render the next pending page job into the PDF.
/// Call this `jobs.len()` times (once per output page). Returns per-phase timing data.
pub(crate) fn pdf_export_spread_one(state: &mut PdfExportState, doc: &PhotobookDocument) -> SpreadTimes {
    let i = state.next_job;
    if i >= state.jobs.len() { return SpreadTimes::default(); }
    let job = &state.jobs[i];
    let (spread_idx, origin_x, trim_w, wrap) =
        (job.spread_idx, job.origin_x_mm, job.trim_w_mm, job.wrap_mm);

    let spread   = &doc.spreads[spread_idx];
    let spread_w = doc.spread_width_mm(spread);
    // Media margin around the trim: bleed, plus the cover wrap allowance.
    let bleed    = state.bleed + wrap;
    let ph       = state.ph;
    let total_w  = trim_w + 2.0 * bleed;
    let total_h  = ph + 2.0 * bleed;
    let page_w   = doc.page_size.width_mm;

    let layer = state.layers[i].clone();

    // Spread-space x → page-media x for this job's page.
    let to_page_x = |spread_x: f32| spread_x - origin_x + bleed;

    // Determine the printable layout region for endpaper spreads.
    // layout_w: width passed to the resolver (one page for endpapers, full spread otherwise).
    // layout_offset_x: x offset to shift resolved frames into the printable half.
    let endpaper_side = doc.endpaper_side(spread_idx);
    let (layout_w, layout_offset_x) = match endpaper_side {
        Some("left")  => (page_w, page_w), // right half is printable
        Some("right") => (page_w, 0.0),    // left half is printable
        _             => (spread_w, 0.0),
    };
    // Visible region in spread space: the printable layout area clipped to this
    // page's media window. Frames outside it are skipped entirely — for split
    // spreads the other half's images are never decoded or encoded.
    let printable = Rect::new(layout_offset_x, 0.0, layout_w, ph);
    let window = Rect::new(origin_x - bleed, -bleed, trim_w + 2.0 * bleed, ph + 2.0 * bleed);
    let region = intersect_rect(&printable, &window)
        .unwrap_or(Rect::new(0.0, 0.0, 0.0, 0.0));

    // White base background.
    layer.set_fill_color(Color::Rgb(Rgb::new(1.0, 1.0, 1.0, None)));
    fill_rect(&layer, 0.0, 0.0, total_w, total_h);

    // Per-page background colors — skip the non-printable side for endpaper spreads.
    // Off-page fills are clipped away by the page's MediaBox.
    let draw_left_bg  = endpaper_side != Some("left");
    let draw_right_bg = endpaper_side != Some("right");
    if draw_left_bg && !spread.left_bg.is_empty() {
        let (r, g, b) = parse_hex_color(&spread.left_bg);
        layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
        fill_rect(&layer, to_page_x(-bleed), 0.0, page_w + bleed, total_h);
    }
    if draw_right_bg && !spread.right_bg.is_empty() {
        let (r, g, b) = parse_hex_color(&spread.right_bg);
        layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
        fill_rect(&layer, to_page_x(spread_w - page_w), 0.0, page_w + bleed, total_h);
    }

    if doc.export_crop_marks {
        draw_crop_marks(&layer, bleed, trim_w, ph);
    }

    // Resolve frames against the printable page width, then shift into spread-mm space.
    let rooms_mm_raw = resolve_frames_mm(
        &spread.layout, layout_w, ph, bleed,
    );
    // Sort by z_index so lower-z frames are painted first.
    let mut rooms_mm: Vec<_> = rooms_mm_raw.iter().map(|(id, r)| {
        (*id, Rect::new(r.x + layout_offset_x, r.y, r.w, r.h))
    }).collect();
    rooms_mm.sort_by_key(|(face_id, _)| {
        spread.layout.faces.get(face_id).map(|f| f.z_index).unwrap_or(0)
    });

    // Pre-pass: compute the minimum decoded resolution needed for each image on
    // this spread so the JPEG scale-factor decode uses the right 1/N.
    // Safety factor 1.5× covers cover-scale overflow and moderate rotation.
    let mut image_need: HashMap<&str, (u32, u32)> = HashMap::new();
    for (face_id, spread_rect) in &rooms_mm {
        let Some(_clipped) = intersect_rect(spread_rect, &region) else { continue };
        let Some(face) = spread.layout.faces.get(face_id) else { continue };
        if let Some(ref img_id) = face.image.image_id {
            let fp = frame_page_rect(spread_rect, origin_x);
            let need_w = ((fp.w / 25.4 * state.print_dpi) * 1.5).ceil() as u32;
            let need_h = ((fp.h / 25.4 * state.print_dpi) * 1.5).ceil() as u32;
            let e = image_need.entry(img_id.as_str()).or_insert((0, 0));
            e.0 = e.0.max(need_w);
            e.1 = e.1.max(need_h);
        }
    }

    // Pass 1: prepare per-frame placement data and deduplicate crops.
    // Images are decoded on demand immediately before use so the LRU budget
    // never evicts an image before it has been rendered.
    type CropKey = (String, u32, u32, u32, u32);
    let mut xobj_cache: HashMap<CropKey, XObjectRef> = HashMap::new();
    let mut prepared: HashMap<u32, (Rect, f32, f32, Prepared)> = HashMap::new();
    let mut times = SpreadTimes::default();

    for (face_id, spread_rect) in &rooms_mm {
        let Some(_clipped) = intersect_rect(spread_rect, &region) else { continue };
        let Some(face) = spread.layout.faces.get(face_id) else { continue };

        let node_rotation    = face.box_model.face_rotation_deg;
        let (crtl, crtr, crbr, crbl) = face.box_model.border.corner_radii();
        let border_radius_mm = crtl.max(crtr).max(crbr).max(crbl).max(0.0);
        let frame_page       = frame_page_rect(spread_rect, origin_x);

        if let Some(ref img_id) = face.image.image_id {
            let (need_w, need_h) = image_need.get(img_id.as_str()).copied().unwrap_or((0, 0));
            let t = now_ms();
            state.ensure_decoded_scaled(img_id, need_w, need_h);
            times.decode_ms += now_ms() - t;

            if let Some(decoded_img) = state.decoded.get(img_id.as_str()) {
                if let Some(prep) = prepare_image(
                    decoded_img, &frame_page, bleed, ph,
                    face.image.pan_x, face.image.pan_y,
                    face.image.scale, face.image.rotation_deg,
                    face.image.flip_h, face.image.flip_v,
                    state.print_dpi,
                    &mut times,
                ) {
                    let key: CropKey = (
                        img_id.clone(),
                        prep.crop.left, prep.crop.top,
                        prep.crop.width, prep.crop.height,
                    );
                    let xobj_ref = xobj_cache.entry(key).or_insert_with(|| {
                        layer.add_image(prep.xobj.clone())
                    }).clone();
                    prepared.insert(*face_id, (frame_page, node_rotation, border_radius_mm,
                                   Prepared { xobj_ref: Some(xobj_ref), ..prep }));
                    times.image_count += 1;
                }
            }
        }
    }

    // Pass 2: paint frames in z-order — image then border per frame — so that a
    // frame's border is never drawn on top of a higher-z-index frame's image.
    for (face_id, spread_rect) in &rooms_mm {
        let Some(_clipped) = intersect_rect(spread_rect, &region) else { continue };
        let Some(face) = spread.layout.faces.get(face_id) else { continue };
        let frame_page = frame_page_rect(spread_rect, origin_x);

        if let Some((_, node_rotation, border_radius_mm, prep)) = prepared.get(face_id) {
            if let Some(ref xobj_ref) = prep.xobj_ref {
                paint_image(&layer, xobj_ref.clone(), prep, &frame_page,
                            *node_rotation, *border_radius_mm, bleed, ph);
            }
        }

        let border = &face.box_model.border;
        if border.any_nonzero() {
            let node_rotation = face.box_model.face_rotation_deg;
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
            origin_x, bleed, ph,
            &state.pdf_doc, &mut state.font_cache, &state.font_bytes_map,
        );
    }

    state.next_job += 1;
    times
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
    while state.next_job < state.jobs.len() {
        let _ = pdf_export_spread_one(&mut state, doc);
    }
    pdf_export_finish(state)
}

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

fn decode_image_bytes(bytes: &[u8]) -> Option<DecodedImage> {
    use image::ImageDecoder;
    use std::io::Cursor;
    let format = image::guess_format(bytes).ok()?;
    // Keep the source profile alongside unconverted pixels. Conversion belongs
    // after the frame crop and print-size resampling, not at full resolution.
    let (img, icc_profile) = match format {
        image::ImageFormat::Jpeg => {
            let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).ok()?;
            let profile = decoder.icc_profile();
            (image::DynamicImage::from_decoder(decoder).ok()?, profile)
        }
        image::ImageFormat::Png => {
            let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes)).ok()?;
            let profile = decoder.icc_profile();
            (image::DynamicImage::from_decoder(decoder).ok()?, profile)
        }
        _ => (image::load_from_memory_with_format(bytes, format).ok()?, None),
    };
    let is_jpeg = matches!(format, image::ImageFormat::Jpeg);
    let (orig_w, orig_h) = (img.width(), img.height());
    Some(DecodedImage { img, is_jpeg, orig_w, orig_h, icc_profile })
}

/// Attempt a scale-factor JPEG decode. Returns `None` for non-JPEG bytes,
/// unreadable files, or when no scale reduction is useful (denom would be 1).
fn jpeg_scaled_decode(bytes: &[u8], need_w: u32, need_h: u32) -> Option<DecodedImage> {
    use jpeg_decoder::PixelFormat;

    if image::guess_format(bytes).ok() != Some(image::ImageFormat::Jpeg) {
        return None;
    }

    // Read just the JPEG header to get source dimensions.
    let mut hdr = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
    hdr.read_info().ok()?;
    let info = hdr.info()?;
    let (orig_w, orig_h) = (info.width as u32, info.height as u32);

    // Pick the coarsest 1/N that still delivers >= need_w × need_h decoded pixels.
    let denom = pick_scale_denom(orig_w, orig_h, need_w, need_h);
    if denom == 1 { return None; } // no benefit — caller will do a full decode

    let mut dec = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
    dec.scale(1u16, denom).ok()?;
    let pixels = dec.decode().ok()?;
    let scaled_info = dec.info()?;
    let (sw, sh) = (scaled_info.width as u32, scaled_info.height as u32);

    let img = match scaled_info.pixel_format {
        PixelFormat::RGB24 => image::DynamicImage::ImageRgb8(
            image::RgbImage::from_raw(sw, sh, pixels)?,
        ),
        PixelFormat::L8 => image::DynamicImage::ImageLuma8(
            image::GrayImage::from_raw(sw, sh, pixels)?,
        ),
        _ => return None, // CMYK or other — caller falls back to full decode
    };
    Some(DecodedImage { img, is_jpeg: true, orig_w, orig_h, icc_profile: dec.icc_profile() })
}

/// Convert only the final print-sized pixels. Untagged images keep the existing
/// sRGB assumption; malformed/unsupported profiles retain the decoder's output.
/// In particular, do not apply a CMYK profile to pixels already decoded as RGB.
fn convert_to_srgb(img: image::DynamicImage, icc: Option<&[u8]>) -> image::DynamicImage {
    use moxcms::{ColorProfile, DataColorSpace, Layout, TransformOptions};
    let converted = (|| {
        let source = ColorProfile::new_from_slice(icc?).ok()?;
        let (layout, pixels) = match source.color_space {
            DataColorSpace::Rgb => (Layout::Rgba, img.to_rgba8().into_raw()),
            DataColorSpace::Gray => (Layout::GrayAlpha, img.to_luma_alpha8().into_raw()),
            _ => return None,
        };
        let destination = ColorProfile::new_srgb();
        let transform = source.create_transform_8bit(
            layout, &destination, Layout::Rgba, TransformOptions::default(),
        ).ok()?;
        let mut output = vec![0; img.width() as usize * img.height() as usize * 4];
        transform.transform(&pixels, &mut output).ok()?;
        let rgba = image::RgbaImage::from_raw(img.width(), img.height(), output)?;
        let converted = image::DynamicImage::ImageRgba8(rgba);
        Some(if img.color().has_alpha() { converted } else {
            image::DynamicImage::ImageRgb8(converted.to_rgb8())
        })
    })();
    converted.unwrap_or(img)
}

/// Largest power-of-2 denominator such that `src / denom >= need` on both axes.
fn pick_scale_denom(src_w: u32, src_h: u32, need_w: u32, need_h: u32) -> u16 {
    let mut best = 1u16;
    for d in [2u16, 4, 8] {
        let d32 = d as u32;
        if src_w / d32 >= need_w && src_h / d32 >= need_h {
            best = d;
        }
    }
    best
}

/// Approximate retained bytes for a decoded image (RGBA, 4 bytes/px).
fn decoded_size_bytes(d: &DecodedImage) -> usize {
    (d.img.width() as usize)
        .saturating_mul(d.img.height() as usize)
        .saturating_mul(4)
        .saturating_add(d.icc_profile.as_ref().map_or(0, Vec::len))
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
    flip_h: bool,
    flip_v: bool,
    print_dpi: f32,
    times: &mut SpreadTimes,
) -> Option<Prepared> {
    let img_w = decoded.img.width();
    let img_h = decoded.img.height();
    if img_w == 0 || img_h == 0 { return None; }

    // Use the original source dimensions for all physical-size and geometry
    // computations. For a scale-factor JPEG decode orig_w/orig_h are larger
    // than img_w/img_h; for a full decode they are equal.
    let orig_w = decoded.orig_w;
    let orig_h = decoded.orig_h;

    let dpi = 300.0_f32;
    let nat_w_mm = orig_w as f32 / dpi * 25.4;
    let nat_h_mm = orig_h as f32 / dpi * 25.4;
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

    // 5. Compute the crop rectangle in original-image pixel coords.
    let crop = compute_crop(
        frame_rect, bleed, page_h_mm,
        orig_w, orig_h, sw, sh, x_mm, y_mm, rotation_deg,
    );

    // 6. Map the original-coord crop into decoded-image pixel coords, then crop.
    //    When scale_factor == 1 (full decode) these are identical.
    let t = now_ms();
    let sc_left   = (crop.left as u64 * img_w as u64 / orig_w as u64) as u32;
    let sc_top    = (crop.top  as u64 * img_h as u64 / orig_h as u64) as u32;
    let sc_right  = ((crop.left + crop.width)  as u64 * img_w as u64).div_ceil(orig_w as u64) as u32;
    let sc_bottom = ((crop.top  + crop.height) as u64 * img_h as u64).div_ceil(orig_h as u64) as u32;
    let sc_right  = sc_right.min(img_w);
    let sc_bottom = sc_bottom.min(img_h);
    let sc_w = sc_right.saturating_sub(sc_left).max(1);
    let sc_h = sc_bottom.saturating_sub(sc_top).max(1);
    let cropped = decoded.img.crop_imm(sc_left, sc_top, sc_w, sc_h);
    times.crop_ms += now_ms() - t;

    // 7. Resample to print_dpi — use original-coord crop extents for the size
    //    calculation so the result is correct regardless of decode scale.
    let crop_rendered_w_in = crop.width  as f32 * sw / (orig_w as f32 * 25.4);
    let crop_rendered_h_in = crop.height as f32 * sh / (orig_h as f32 * 25.4);
    let target_w = ((crop_rendered_w_in * print_dpi).round() as u32).clamp(1, sc_w);
    let target_h = ((crop_rendered_h_in * print_dpi).round() as u32).clamp(1, sc_h);
    let t = now_ms();
    let final_img = if target_w < sc_w || target_h < sc_h {
        cropped.resize_exact(target_w, target_h, image::imageops::FilterType::Triangle)
    } else {
        cropped
    };
    times.resample_ms += now_ms() - t;

    let t = now_ms();
    let final_img = convert_to_srgb(final_img, decoded.icc_profile.as_deref());
    times.color_ms += now_ms() - t;

    let final_img = match (flip_h, flip_v) {
        (true,  true)  => final_img.fliph().flipv(),
        (true,  false) => final_img.fliph(),
        (false, true)  => final_img.flipv(),
        (false, false) => final_img,
    };

    // 8. Build ImageXObject (JPEG or FlateDecode depending on source format).
    let t = now_ms();
    let xobj = image_to_xobject(&final_img, decoded.is_jpeg)?;
    times.encode_ms += now_ms() - t;

    // 9. Adjust placement — all in original-coord space so scaling is transparent.
    let new_x_mm = x_mm + crop.left as f32 * sw / orig_w as f32;
    let new_y_mm = y_mm + (orig_h - crop.top - crop.height) as f32 * sh / orig_h as f32;
    let final_scale_x = crop.width  as f32 * total_scale / final_img.width()  as f32;
    let final_scale_y = crop.height as f32 * total_scale / final_img.height() as f32;

    // Rotation centre in original-image pixel space (relative to crop origin).
    let rot_cx_px = (orig_w / 2).saturating_sub(crop.left);
    let rot_cy_px = (orig_h / 2).saturating_sub(crop.top);
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
/// When a cover wrap allowance is present the media extends `wrap` beyond the
/// BleedBox on every side (MediaBox ⊇ BleedBox ⊇ TrimBox).
///
/// All coordinates are in PDF user-space points (1 pt = 1/72 inch).
///   MediaBox / BleedBox: [0, 0, total_w_pt, total_h_pt]
///   TrimBox:             [bleed_pt, bleed_pt, total_w_pt − bleed_pt, total_h_pt − bleed_pt]
fn page_box_extension(trim_w: f32, ph: f32, bleed: f32, wrap: f32) -> printpdf::lopdf::Dictionary {
    const PT_PER_MM: f32 = 72.0 / 25.4;
    let margin_pt = (bleed + wrap) * PT_PER_MM;  // trim inset from the media edge
    let wrap_pt   = wrap * PT_PER_MM;            // bleed-box inset from the media edge
    let total_w   = (trim_w + 2.0 * (bleed + wrap)) * PT_PER_MM;
    let total_h   = (ph     + 2.0 * (bleed + wrap)) * PT_PER_MM;

    use printpdf::lopdf::Object::{Array, Real};
    let trim_box  = Array(vec![Real(margin_pt), Real(margin_pt), Real(total_w - margin_pt), Real(total_h - margin_pt)]);
    let bleed_box = Array(vec![Real(wrap_pt),   Real(wrap_pt),   Real(total_w - wrap_pt),   Real(total_h - wrap_pt)]);

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
            BorderPosition::Centered => (frame.x, frame.y, frame.w, frame.h),
        };
        let (cr0, cr1, cr2, cr3) = border.corner_radii();
        let base_r = cr0.max(cr1).max(cr2).max(cr3).max(0.0);
        let stroke_r = match border.position {
            BorderPosition::Inner  => (base_r - hw).max(0.0),
            BorderPosition::Outer  => base_r + hw,
            BorderPosition::Centered => base_r,
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
        BorderPosition::Centered => {
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

        // Pre-encode all lines (WinAnsi, Latin-1 subset).
        let encoded_lines: Vec<String> = lines.iter()
            .map(|line| line.chars().map(|c| if (c as u32) < 256 { c } else { '?' }).collect())
            .collect();

        use printpdf::lopdf::content::Operation;
        use printpdf::lopdf::Object::Real;

        layer.save_graphics_state();
        layer.set_fill_color(Color::Rgb(Rgb::new(r, g, b, None)));
        layer.begin_text_section();
        layer.set_font(&font, font_size_pt);

        for (i, encoded) in encoded_lines.iter().enumerate() {
            if encoded.is_empty() && i == encoded_lines.len() - 1 { continue; }

            let line_offset_mm = i as f32 * line_h_mm;
            let tx_mm = base_x_mm - line_offset_mm * rad.sin();
            let ty_mm = baseline_y_mm - line_offset_mm * rad.cos();

            layer.add_operation(Operation::new("Tm", vec![
                Real(cos_r), Real(sin_r),
                Real(-sin_r), Real(cos_r),
                Real(mm_to_pt(tx_mm)), Real(mm_to_pt(ty_mm)),
            ]));
            layer.write_text(encoded, &font);
        }

        layer.end_text_section();

        if el.underline {
            // Approximate character width: 0.5 em for proportional fonts, drawn along text direction.
            let avg_char_w_mm = font_size_pt * (25.4 / 72.0) * 0.5;
            // Underline sits ~15% of font height below the baseline.
            let ul_below_mm = font_size_pt * (25.4 / 72.0) * 0.15;
            let ul_thickness = mm_to_pt(font_size_pt * (25.4 / 72.0) * 0.07);
            layer.add_operation(Operation::new("RG", vec![Real(r), Real(g), Real(b)]));
            layer.add_operation(Operation::new("w",  vec![Real(ul_thickness)]));
            for (i, encoded) in encoded_lines.iter().enumerate() {
                if encoded.is_empty() && i == encoded_lines.len() - 1 { continue; }
                if encoded.is_empty() { continue; }
                let line_w_mm = encoded.chars().count() as f32 * avg_char_w_mm;
                let line_offset_mm = i as f32 * line_h_mm;
                let ul_x_mm = base_x_mm - line_offset_mm * rad.sin();
                let ul_y_mm = baseline_y_mm - line_offset_mm * rad.cos() - ul_below_mm;
                let ul_x_pt = mm_to_pt(ul_x_mm);
                let ul_y_pt = mm_to_pt(ul_y_mm);
                let ul_ex_pt = ul_x_pt + mm_to_pt(line_w_mm) * cos_r;
                let ul_ey_pt = ul_y_pt + mm_to_pt(line_w_mm) * sin_r;
                layer.add_operation(Operation::new("m", vec![Real(ul_x_pt), Real(ul_y_pt)]));
                layer.add_operation(Operation::new("l", vec![Real(ul_ex_pt), Real(ul_ey_pt)]));
                layer.add_operation(Operation::new("S", vec![]));
            }
        }

        layer.restore_graphics_state();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page::PhotobookDocument;

    fn adobe_profile() -> Vec<u8> {
        moxcms::ColorProfile::new_adobe_rgb().encode().unwrap()
    }

    fn tagged_jpeg(profile: &[u8]) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(256, 256, image::Rgb([128, 64, 32]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 100)
            .encode_image(&img).unwrap();
        let mut tagged = vec![0xff, 0xd8, 0xff, 0xe2];
        tagged.extend_from_slice(&((profile.len() + 16) as u16).to_be_bytes());
        tagged.extend_from_slice(b"ICC_PROFILE\0\x01\x01");
        tagged.extend_from_slice(profile);
        tagged.extend_from_slice(&jpeg[2..]);
        tagged
    }

    fn assert_adobe_sample(pixel: &[u8]) {
        // Adobe RGB (gamma 563/256) -> XYZ -> sRGB, independently calculated.
        // Allow for 8-bit rounding and JPEG quantisation.
        for (&actual, expected) in pixel.iter().zip([146u8, 62, 23]) {
            assert!(actual.abs_diff(expected) <= 3, "unexpected colour: {pixel:?}");
        }
    }

    #[test]
    fn export_converts_adobe_rgb_after_print_resampling() {
        let profile = adobe_profile();
        let pixels = image::RgbImage::from_pixel(256, 256, image::Rgb([128, 64, 32]));
        let mut png_bytes = Vec::new();
        let mut info = png::Info::with_size(256, 256);
        info.color_type = png::ColorType::Rgb;
        info.icc_profile = Some(std::borrow::Cow::Borrowed(&profile));
        png::Encoder::with_info(&mut png_bytes, info).unwrap().write_header().unwrap()
            .write_image_data(pixels.as_raw()).unwrap();

        // Exercise PNG, full JPEG, and scale-factor JPEG profile extraction.
        let jpeg = tagged_jpeg(&profile);
        let decoded_images = [
            decode_image_bytes(&png_bytes).unwrap(),
            decode_image_bytes(&jpeg).unwrap(),
            jpeg_scaled_decode(&jpeg, 24, 24).unwrap(),
        ];
        for decoded in decoded_images {
            assert_eq!(decoded.icc_profile.as_deref(), Some(profile.as_slice()));
            // Decoding must retain the source colour values, not convert early.
            assert!(decoded.img.to_rgb8().get_pixel(0, 0)[0].abs_diff(128) <= 1);
            let prepared = prepare_image(
                &decoded, &Rect::new(0.0, 0.0, 25.4, 25.4), 0.0, 25.4,
                0.0, 0.0, 1.0, 0.0, false, false, 24.0, &mut SpreadTimes::default(),
            ).unwrap();
            assert_eq!((prepared.xobj.width.0, prepared.xobj.height.0), (24, 24));
            if decoded.is_jpeg {
                let rgb = image::load_from_memory(&prepared.xobj.image_data).unwrap().to_rgb8();
                assert_adobe_sample(&rgb.get_pixel(0, 0).0);
            } else {
                assert_adobe_sample(&prepared.xobj.image_data[..3]);
                assert!(prepared.xobj.smask.is_none());
            }
        }
    }

    #[test]
    fn colour_conversion_preserves_alpha_and_srgb_colours() {
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2, 3, image::Rgba([128, 64, 32, 79]),
        ));
        let converted = convert_to_srgb(img.clone(), Some(&adobe_profile())).to_rgba8();
        assert_eq!(converted.dimensions(), (2, 3));
        for pixel in converted.pixels() {
            assert_adobe_sample(&pixel.0[..3]);
            assert_eq!(pixel[3], 79);
        }
        let converted = convert_to_srgb(img.clone(), Some(SRGB_ICC)).to_rgba8();
        for (actual, expected) in converted.as_raw().iter().zip(img.as_bytes()) {
            assert!(actual.abs_diff(*expected) <= 1);
        }
        for profile in [None, Some(b"invalid ICC".as_slice())] {
            assert_eq!(convert_to_srgb(img.clone(), profile).as_bytes(), img.as_bytes());
        }
    }

    #[test]
    fn colour_conversion_handles_greyscale_profile() {
        let profile = moxcms::ColorProfile::new_gray_with_gamma(1.0).encode().unwrap();
        let img = image::DynamicImage::ImageLumaA8(image::GrayAlphaImage::from_pixel(
            1, 1, image::LumaA([128, 79]),
        ));
        let converted = convert_to_srgb(img, Some(&profile)).to_rgba8();
        // Linear-light 0.5 is approximately 188 in sRGB.
        let pixel = converted.get_pixel(0, 0);
        for channel in &pixel.0[..3] { assert!(channel.abs_diff(188) <= 1); }
        assert_eq!(pixel[3], 79);
    }

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

    fn export_with_target(doc: &PhotobookDocument, target: ExportTarget) -> Vec<u8> {
        let mut state = pdf_export_begin_with_bytes(doc, HashMap::new(), HashMap::new(), target)
            .expect("export should produce at least one page");
        while state.next_job < state.jobs.len() {
            let _ = pdf_export_spread_one(&mut state, doc);
        }
        pdf_export_finish(state)
    }

    fn page_dicts(parsed: &printpdf::lopdf::Document) -> Vec<printpdf::lopdf::Dictionary> {
        parsed.get_pages().values()
            .map(|id| parsed.get_object(*id).and_then(|o| o.as_dict()).unwrap().clone())
            .collect()
    }

    fn box_array(dict: &printpdf::lopdf::Dictionary, key: &[u8]) -> Vec<f32> {
        dict.get(key).unwrap().as_array().unwrap()
            .iter().map(|o| o.as_float().unwrap()).collect()
    }

    /// The exported PDF must identify as PDF/X-4: PDF 1.6 header, GTS_PDFX
    /// output intent with an embedded RGB destination profile (under the
    /// spec-correct /DestOutputProfile key), XMP metadata, and a document ID.
    #[test]
    fn pdf_is_pdfx4_with_srgb_output_intent() {
        let doc = doc_single_frame(None);
        let pdf = export_pdf(&doc, "[]", "[]");
        assert!(pdf.starts_with(b"%PDF-1.6"), "PDF/X-4 export should be PDF 1.6");

        let parsed = printpdf::lopdf::Document::load_mem(&pdf).expect("parseable PDF");
        let catalog = parsed.catalog().expect("catalog");

        let intents = catalog.get(b"OutputIntents").expect("OutputIntents present")
            .as_array().expect("OutputIntents is an array");
        assert_eq!(intents.len(), 1);
        let intent = intents[0].as_dict().expect("output intent dictionary");
        assert_eq!(intent.get(b"S").unwrap().as_name().unwrap(), b"GTS_PDFX");
        let profile_id = intent.get(b"DestOutputProfile")
            .expect("DestOutputProfile present (not the misspelled long form)")
            .as_reference().unwrap();
        let profile = parsed.get_object(profile_id).unwrap().as_stream().unwrap();
        assert_eq!(profile.dict.get(b"N").unwrap().as_i64().unwrap(), 3,
            "destination profile should be 3-component (RGB)");
        assert!(!profile.content.is_empty(), "ICC profile bytes should be embedded");

        assert!(catalog.has(b"Metadata"), "XMP metadata stream should be referenced");
        assert!(parsed.trailer.has(b"ID"), "trailer should carry a document ID");

        // The XMP packet must be scannable in the raw bytes (uncompressed).
        let needle = b"pdfxid:GTS_PDFXVersion";
        assert!(pdf.windows(needle.len()).any(|w| w == needle),
            "uncompressed XMP packet with pdfxid:GTS_PDFXVersion should be present");
    }

    #[test]
    fn build_jobs_cover_body_split_and_single_pages() {
        let mut doc = doc_single_frame(None); // cover + 1 content spread
        doc.export_body_pages = true;

        let cover = build_jobs(&doc, ExportTarget::Cover);
        assert_eq!(cover.len(), 1);
        assert!((cover[0].trim_w_mm - doc.spread_width_mm(&doc.spreads[0])).abs() < 1e-4);

        let body = build_jobs(&doc, ExportTarget::Body);
        assert_eq!(body.len(), 2, "one content spread → two single pages");
        assert_eq!(body[0].origin_x_mm, 0.0);
        assert!((body[1].origin_x_mm - 210.0).abs() < 1e-4);
        assert!((body[0].trim_w_mm - 210.0).abs() < 1e-4);

        doc.export_body_pages = false;
        let all = build_jobs(&doc, ExportTarget::All);
        assert_eq!(all.len(), 2, "spread mode: one page per spread");
    }

    /// Body-as-single-pages export: each output page is one trim page wide.
    #[test]
    fn pdf_body_pages_have_single_page_media() {
        const PT_PER_MM: f32 = 72.0 / 25.4;
        let mut doc = doc_single_frame(None);
        doc.export_body_pages = true;

        let pdf = export_with_target(&doc, ExportTarget::Body);
        let parsed = printpdf::lopdf::Document::load_mem(&pdf).unwrap();
        let pages = page_dicts(&parsed);
        assert_eq!(pages.len(), 2);
        for page in &pages {
            let media = box_array(page, b"MediaBox");
            let expected_w = (210.0 + 2.0 * 3.0) * PT_PER_MM;
            assert!((media[2] - expected_w).abs() < 0.01,
                "single-page media width: got {}, want {}", media[2], expected_w);
        }
    }

    /// Cover wrap allowance: MediaBox ⊇ BleedBox ⊇ TrimBox with the wrap
    /// between media and bleed, and the bleed between bleed-box and trim.
    #[test]
    fn pdf_cover_wrap_extends_media_beyond_bleed() {
        const PT_PER_MM: f32 = 72.0 / 25.4;
        let mut doc = doc_single_frame(None);
        doc.cover_wrap_mm = 15.0;

        let pdf = export_with_target(&doc, ExportTarget::Cover);
        let parsed = printpdf::lopdf::Document::load_mem(&pdf).unwrap();
        let pages = page_dicts(&parsed);
        assert_eq!(pages.len(), 1);

        let media = box_array(&pages[0], b"MediaBox");
        let bleed = box_array(&pages[0], b"BleedBox");
        let trim  = box_array(&pages[0], b"TrimBox");

        let wrap_pt  = 15.0 * PT_PER_MM;
        let bleed_pt = 3.0 * PT_PER_MM;
        let tol = 0.01;
        assert!((bleed[0] - (media[0] + wrap_pt)).abs() < tol, "BleedBox inset by wrap");
        assert!((trim[0]  - (bleed[0] + bleed_pt)).abs() < tol, "TrimBox inset by bleed inside BleedBox");

        // Cover trim width = 2 pages + spine (minimum 5mm applies here).
        let spine = doc.spine_mm();
        let expected_trim_w = (2.0 * 210.0 + spine) * PT_PER_MM;
        assert!(((trim[2] - trim[0]) - expected_trim_w).abs() < tol,
            "cover trim width: got {}, want {}", trim[2] - trim[0], expected_trim_w);
    }

    /// Peecho-style export: one file of single pages where the front cover
    /// (right half of the cover spread) comes first and the back cover
    /// (left half) comes last; endpaper blanks are not emitted.
    #[test]
    fn build_jobs_cover_pages_orders_front_first_back_last() {
        let mut doc = doc_single_frame(None); // cover + 1 content spread
        doc.add_spread();                     // need ≥2 content spreads for endpapers
        doc.export_cover_pages = true;
        doc.export_body_pages = true;
        doc.endpapers = true;

        let jobs = build_jobs(&doc, ExportTarget::All);
        let cover_w = doc.spread_width_mm(&doc.spreads[0]);

        // front cover, 1 page (left endpaper skipped), 2 pages, 1 page
        // (right endpaper skipped), back cover
        assert_eq!(jobs.len(), 1 + 1 + 1 + 1);
        assert_eq!(jobs[0].spread_idx, 0);
        assert!((jobs[0].origin_x_mm - (cover_w - 210.0)).abs() < 1e-4,
            "front cover is the right half of the cover spread");
        assert!((jobs[0].trim_w_mm - 210.0).abs() < 1e-4);
        // Spread 1 has a left endpaper: only its right page is emitted.
        assert_eq!(jobs[1].spread_idx, 1);
        assert!((jobs[1].origin_x_mm - 210.0).abs() < 1e-4);
        // Spread 2 has a right endpaper: only its left page is emitted.
        assert_eq!(jobs[2].spread_idx, 2);
        assert_eq!(jobs[2].origin_x_mm, 0.0);
        // Back cover last.
        let back = jobs.last().unwrap();
        assert_eq!(back.spread_idx, 0);
        assert_eq!(back.origin_x_mm, 0.0);
        assert!((back.trim_w_mm - 210.0).abs() < 1e-4);
    }

    #[test]
    fn page_count_rules_enforce_min_and_block_removal() {
        let mut doc = doc_single_frame(None); // 1 content spread = 2 pages
        doc.page_rule_min = 16;
        doc.page_rule_max = 120;
        doc.page_rule_multiple = 2;
        let added = doc.enforce_page_count_rules();
        assert_eq!(added, 7, "2 → 16 pages needs 7 more spreads");
        assert_eq!(doc.interior_page_count(), 16);
        assert!(!doc.can_remove_spreads(doc.spread_step()), "at the minimum, removal is blocked");
        assert!(doc.can_add_spreads(doc.spread_step()));

        doc.page_rule_max = 16;
        assert!(!doc.can_add_spreads(doc.spread_step()), "at the maximum, adding is blocked");
    }

    /// Crop marks are opt-in: the default export must not contain the mark
    /// strokes, the opted-in export must paint more content.
    #[test]
    fn crop_marks_are_off_by_default() {
        let mut doc = doc_single_frame(None);
        let without = export_pdf(&doc, "[]", "[]");
        doc.export_crop_marks = true;
        let with = export_pdf(&doc, "[]", "[]");
        assert!(with.len() > without.len(),
            "enabling crop marks should add content ({} vs {} bytes)", with.len(), without.len());
    }
}
