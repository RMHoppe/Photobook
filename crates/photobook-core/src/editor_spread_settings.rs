use wasm_bindgen::prelude::*;
use crate::page::SpreadKind;
use crate::layout::SplitAxis;
use crate::grid_layout::GridLayout;
use crate::PhotobookEditor;

/// Kind string crossing the WASM boundary (mirrored in web/types.ts).
fn kind_str(kind: SpreadKind) -> &'static str {
    match kind {
        SpreadKind::Cover      => "cover",
        SpreadKind::CoverFront => "cover-front",
        SpreadKind::CoverBack  => "cover-back",
        SpreadKind::Content    => "content",
    }
}

impl PhotobookEditor {
    /// When `endpapers` is on, normalise the first and last content spread layouts
    /// after any structural change (add/remove spread). Rules for spreads with no images:
    /// - endpaper (first or last content, single printable page) → 1 frame
    /// - regular content spread → 2 frames (fold split)
    pub(crate) fn adjust_endpaper_layouts(&mut self) {
        if !self.doc.endpapers { return; }
        let content_idxs: Vec<usize> = self.doc.spreads.iter()
            .enumerate()
            .filter(|(_, s)| s.kind == SpreadKind::Content)
            .map(|(i, _)| i)
            .collect();
        let n = content_idxs.len();
        for (pos, &spread_idx) in content_idxs.iter().enumerate() {
            let is_endpaper = pos == 0 || pos == n - 1;
            let spread = &mut self.doc.spreads[spread_idx];
            let all_empty = spread.layout.faces.values().all(|f| f.image.image_id.is_none());
            if !all_empty { continue; }
            if is_endpaper && spread.layout.faces.len() == 2 {
                spread.layout = GridLayout::new();
            } else if !is_endpaper && spread.layout.faces.len() == 1 {
                let face_id = *spread.layout.faces.keys().next().unwrap();
                spread.layout.split_face(face_id, 0.5, SplitAxis::Vertical);
            }
        }
    }
}

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Spreads
    // -----------------------------------------------------------------------

    /// Add content spreads (one, or more when the print spec demands a page
    /// multiple). Returns false when the spec's maximum page count blocks it.
    pub fn add_page(&mut self) -> bool {
        let step = self.doc.spread_step();
        if !self.doc.can_add_spreads(step) { return false; }
        for _ in 0..step {
            self.doc.add_spread(); // inserts a settings-cloned spread after the current one
        }
        let new_idx = (self.doc.current_spread + 1).min(self.doc.last_content_idx());
        // Navigate to the freshly inserted spread.
        self.doc.current_spread = new_idx;
        // Normalise endpaper frame counts after the structural change.
        self.adjust_endpaper_layouts();
        // Indices shifted by the mid-insert; repaint all thumbnails.
        self.mark_all_thumbs_dirty();
        self.mark_structure_dirty();
        true
    }

    /// Whether the spread at `spread_idx` can be removed without violating any
    /// structural or spec-defined minimum. Mirrors the check inside `remove_page`.
    pub fn can_remove_page(&self, spread_idx: u32) -> bool {
        if self.doc.spreads.get(spread_idx as usize)
            .is_none_or(|s| s.kind != SpreadKind::Content) { return false; }
        self.doc.can_remove_spreads(self.doc.spread_step())
    }

    /// Remove the given spread (plus trailing spreads when the print spec
    /// demands a page multiple). Returns false when the spec's minimum page
    /// count or the structural minimum blocks it.
    pub fn remove_page(&mut self, spread_idx: u32) -> bool {
        // Cover spreads (wraparound or standalone front/back page) are fixed.
        if self.doc.spreads.get(spread_idx as usize)
            .is_none_or(|s| s.kind != SpreadKind::Content) { return false; }
        let step = self.doc.spread_step();
        if !self.doc.can_remove_spreads(step) { return false; }
        self.doc.remove_spread(spread_idx as usize);
        // Keep the interior page count on the spec's multiple by also
        // dropping content spreads from the end of the book.
        for _ in 1..step {
            let last = self.doc.last_content_idx();
            self.doc.remove_spread(last);
        }
        // Normalise endpaper frame counts after the structural change.
        self.adjust_endpaper_layouts();
        self.mark_all_thumbs_dirty();
        self.mark_structure_dirty();
        true
    }

    /// Store the page-count rules of the selected print-shop spec
    /// (0 disables a rule) and append blank spreads until the document
    /// satisfies the minimum and multiple.
    pub fn set_page_count_rules(&mut self, min_pages: u32, max_pages: u32, multiple_of: u32) {
        self.doc.page_rule_min      = min_pages;
        self.doc.page_rule_max      = max_pages;
        self.doc.page_rule_multiple = multiple_of;
        if self.doc.enforce_page_count_rules() > 0 {
            self.adjust_endpaper_layouts();
            self.mark_all_thumbs_dirty();
            self.mark_structure_dirty();
        }
    }

    pub fn move_spread(&mut self, from_idx: u32, to_idx: u32) {
        let from = from_idx as usize;
        let to   = to_idx   as usize;
        let n    = self.doc.spreads.len();
        if from == 0 || to == 0 || from == to || from >= n || to >= n { return; }
        // Only content spreads move, and never past the back cover.
        let last_content = self.doc.last_content_idx();
        if self.doc.spreads[from].kind != SpreadKind::Content
            || from > last_content || to > last_content { return; }

        let spread = self.doc.spreads.remove(from);
        self.doc.spreads.insert(to, spread);

        // Keep current_spread pointing at the same spread after the move.
        let cur = self.doc.current_spread;
        self.doc.current_spread = if cur == from {
            to
        } else if from < to && cur > from && cur <= to {
            cur - 1
        } else if from > to && cur >= to && cur < from {
            cur + 1
        } else {
            cur
        };

        // The strip is addressed by position — reordering shifts every index.
        self.mark_all_thumbs_dirty();
        self.mark_structure_dirty();
    }

    pub fn set_current_spread(&mut self, spread_idx: u32) {
        let idx = spread_idx as usize;
        if idx < self.doc.spreads.len() {
            self.doc.current_spread = idx;
            self.selection.clear();
            self.mark_structure_dirty();
        }
    }

    pub fn get_spread_count(&self) -> u32 {
        self.doc.spreads.len() as u32
    }

    pub fn get_current_spread_index(&self) -> u32 {
        self.doc.current_spread as u32
    }

    pub fn get_spreads_info(&self) -> String {
        #[derive(serde::Serialize)]
        struct SpreadInfo<'a> { id: u32, label: &'a str, kind: &'static str, width_mm: f32, height_mm: f32, endpaper_side: Option<&'static str> }
        let h = self.doc.page_size.height_mm;
        let info: Vec<_> = self.doc.spreads.iter().enumerate().map(|(i, s)| SpreadInfo {
            id: s.id,
            label: &s.label,
            kind: kind_str(s.kind),
            width_mm: self.doc.spread_width_mm(s),
            height_mm: h,
            endpaper_side: self.doc.endpaper_side(i),
        }).collect();
        serde_json::to_string(&info).unwrap_or_default()
    }

    pub fn get_current_spread_info(&self) -> String {
        let idx    = self.doc.current_spread;
        let spread = self.doc.current_spread();
        let w = self.doc.spread_width_mm(spread);
        let h = self.doc.page_size.height_mm;
        let spine = if spread.kind == SpreadKind::Cover { self.doc.spine_mm() } else { 0.0 };
        #[derive(serde::Serialize)]
        struct Info<'a> { kind: &'static str, width_mm: f32, height_mm: f32, spine_mm: f32, page_width_mm: f32, left_bg: &'a str, right_bg: &'a str, endpaper_side: Option<&'static str> }
        let info = Info {
            kind: kind_str(spread.kind),
            width_mm: w,
            height_mm: h,
            spine_mm: spine,
            page_width_mm: self.doc.page_size.width_mm,
            left_bg: &spread.left_bg,
            right_bg: &spread.right_bg,
            endpaper_side: self.doc.endpaper_side(idx),
        };
        serde_json::to_string(&info).unwrap_or_default()
    }

    pub fn get_endpapers(&self) -> bool {
        self.doc.endpapers
    }

    pub fn set_endpapers(&mut self, enabled: bool) {
        self.doc.endpapers = enabled;
        if enabled {
            if self.doc.content_spread_count() < 2 {
                self.doc.add_spread();
            }
            // When endpapers are first enabled, reset the layout of the first and
            // last content spreads to a single frame if they're still in the default
            // two-frame (fold-split) state with no images placed. The endpaper overlay
            // renders one page at a time, so a two-frame split looks wrong.
            let content_idxs: Vec<usize> = self.doc.spreads.iter()
                .enumerate()
                .filter(|(_, s)| s.kind == SpreadKind::Content)
                .map(|(i, _)| i)
                .collect();
            let endpaper_idxs: Vec<usize> = content_idxs.first().copied().into_iter()
                .chain(content_idxs.last().copied())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            for idx in endpaper_idxs {
                let spread = &mut self.doc.spreads[idx];
                let is_default = spread.layout.faces.len() == 2
                    && spread.layout.faces.values().all(|f| f.image.image_id.is_none());
                if is_default {
                    spread.layout = crate::grid_layout::GridLayout::new();
                }
            }
        }
        // Endpaper overlays appear on the first and last content spreads.
        self.mark_all_thumbs_dirty();
        self.mark_structure_dirty();
    }

    pub fn get_spread_left_bg(&self) -> String {
        self.doc.current_spread().left_bg.clone()
    }

    pub fn get_spread_right_bg(&self) -> String {
        self.doc.current_spread().right_bg.clone()
    }

    pub fn set_spread_left_bg(&mut self, color: &str) {
        self.doc.current_spread_mut().left_bg = color.to_string();
        self.mark_structure_dirty();
    }

    pub fn set_spread_right_bg(&mut self, color: &str) {
        self.doc.current_spread_mut().right_bg = color.to_string();
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // PDF export + state serialization
    // -----------------------------------------------------------------------

    pub fn export_pdf(&self, images_json: &str, fonts_json: &str) -> Vec<u8> {
        crate::pdf::export_pdf(&self.doc, images_json, fonts_json)
    }

    /// Stage raw image bytes for the next `pdf_export_begin_v2` call.
    /// The bytes are the original encoded file (JPEG, PNG, …); no base64 needed.
    pub fn pdf_stage_image(&mut self, id: &str, bytes: Vec<u8>) {
        self.pdf_staged_images.insert(id.to_string(), bytes);
    }

    /// Stage raw font bytes for the next `pdf_export_begin_v2` call.
    pub fn pdf_stage_font(&mut self, family: &str, bold: bool, italic: bool, bytes: Vec<u8>) {
        let key = format!("{}:{}:{}", family, bold as u8, italic as u8);
        self.pdf_staged_fonts.insert(key, bytes);
    }

    /// Phase 1 of the staged export using pre-staged raw bytes (no base64/JSON overhead).
    /// Consumes the staging buffers. Returns the total output page count, 0 on failure.
    pub fn pdf_export_begin_v2(&mut self) -> u32 {
        self.pdf_export_begin_target("all")
    }

    /// Phase 1 of the staged export for one output file. `target` selects which
    /// spreads are included: "all" (single PDF), "cover", or "body". Consumes the
    /// staging buffers; `pdf_export_finish` hands them back so a second target
    /// can be exported without re-staging. Returns the output page count, 0 on failure.
    pub fn pdf_export_begin_target(&mut self, target: &str) -> u32 {
        let target = match target {
            "cover" => crate::pdf::ExportTarget::Cover,
            "body"  => crate::pdf::ExportTarget::Body,
            _       => crate::pdf::ExportTarget::All,
        };
        let images = std::mem::take(&mut self.pdf_staged_images);
        let fonts  = std::mem::take(&mut self.pdf_staged_fonts);
        let state  = crate::pdf::pdf_export_begin_with_bytes(&self.doc, images, fonts, target);
        let total  = state.as_ref().map_or(0, |s| s.jobs.len() as u32);
        self.pdf_state = state.map(Box::new);
        total
    }

    /// Phase 1 of the staged export. Decodes images/fonts and pre-allocates
    /// one PDF page per spread. Returns the total spread count so the caller
    /// can loop over `pdf_export_spread`. Returns 0 on failure.
    pub fn pdf_export_begin(&mut self, images_json: &str, fonts_json: &str) -> u32 {
        let state = crate::pdf::pdf_export_begin(&self.doc, images_json, fonts_json);
        let total = state.as_ref().map_or(0, |s| s.jobs.len() as u32);
        self.pdf_state = state.map(Box::new);
        total
    }

    /// Phase 2 of the staged export. Renders one spread into the PDF.
    /// Call this `total` times (the value returned by `pdf_export_begin`).
    /// Returns a JSON string with per-phase timing data for profiling.
    pub fn pdf_export_spread(&mut self) -> String {
        if let Some(state) = self.pdf_state.as_mut() {
            let times = crate::pdf::pdf_export_spread_one(state, &self.doc);
            serde_json::to_string(&times).unwrap_or_default()
        } else {
            "{}".to_string()
        }
    }

    /// Phase 3 of the staged export. Serialises and returns the finished PDF,
    /// then clears the internal state. The staged image/font source bytes are
    /// returned to the staging buffers so a follow-up `pdf_export_begin_target`
    /// (cover/body split) can run without the caller re-staging them.
    pub fn pdf_export_finish(&mut self) -> Vec<u8> {
        match self.pdf_state.take() {
            Some(mut state) => {
                self.pdf_staged_images = std::mem::take(&mut state.image_src);
                self.pdf_staged_fonts  = std::mem::take(&mut state.font_bytes_map);
                crate::pdf::pdf_export_finish(*state)
            }
            None => Vec::new(),
        }
    }

    /// Export-related document settings as JSON (consumed by the export worker
    /// and the project settings panel).
    pub fn get_export_settings(&self) -> String {
        #[derive(serde::Serialize)]
        struct ExportSettings {
            crop_marks: bool,
            split_cover: bool,
            body_pages: bool,
            cover_pages: bool,
            cover_wrap_mm: f32,
        }
        serde_json::to_string(&ExportSettings {
            crop_marks:    self.doc.export_crop_marks,
            split_cover:   self.doc.export_split_cover,
            body_pages:    self.doc.export_body_pages,
            cover_pages:   self.doc.export_cover_pages,
            cover_wrap_mm: self.doc.cover_wrap_mm,
        }).unwrap_or_default()
    }

    pub fn set_export_settings(
        &mut self,
        crop_marks: bool,
        split_cover: bool,
        body_pages: bool,
        cover_pages: bool,
        cover_wrap_mm: f32,
    ) {
        self.doc.export_crop_marks  = crop_marks;
        self.doc.export_split_cover = split_cover;
        self.doc.export_body_pages  = body_pages;
        self.doc.export_cover_pages = cover_pages;
        self.doc.cover_wrap_mm      = cover_wrap_mm.clamp(0.0, 50.0);
        // Cover-as-pages is structural: split the wraparound cover into front/back
        // pages (or merge them back) when the toggle changes.
        if self.doc.normalize_cover_structure() {
            self.full_invalidate();
        }
    }

    pub fn save_state(&self) -> String {
        serde_json::to_string(&self.doc).unwrap_or_default()
    }

    pub fn load_state(&mut self, json: &str) -> bool {
        let mut doc: crate::page::PhotobookDocument = match serde_json::from_str(json) {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.schema_version > 1 { return false; }
        // Projects saved before cover-as-pages became structural carry the flag
        // but still have a wraparound cover — convert on load.
        doc.normalize_cover_structure();
        // Project loads start fresh — drop history and full-invalidate.
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.install_doc_full(doc);
        true
    }

    // -----------------------------------------------------------------------
    // Undo / redo (history lives in Rust to avoid JSON round-trips)
    // -----------------------------------------------------------------------

    /// Push the current document onto the undo stack and clear redo.
    pub fn snapshot_undo(&mut self) {
        self.undo_stack.push(self.doc.clone());
        // Bound history by approximate memory, not just a fixed count: a snapshot
        // of a 200-page book is far larger than one of a 2-page book.
        let mut total: usize = self.undo_stack.iter().map(estimate_doc_bytes).sum();
        while self.undo_stack.len() > 1
            && (total > crate::UNDO_BUDGET_BYTES || self.undo_stack.len() > crate::UNDO_MAX) {
            let removed = self.undo_stack.remove(0);
            total = total.saturating_sub(estimate_doc_bytes(&removed));
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo_stack.pop() else { return false; };
        let current = std::mem::replace(&mut self.doc, prev);
        self.diff_invalidate(&current);
        self.redo_stack.push(current);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo_stack.pop() else { return false; };
        let current = std::mem::replace(&mut self.doc, next);
        self.diff_invalidate(&current);
        self.undo_stack.push(current);
        true
    }

    pub fn can_undo(&self) -> bool { !self.undo_stack.is_empty() }
    pub fn can_redo(&self) -> bool { !self.redo_stack.is_empty() }

    pub fn reset_undo(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    // -----------------------------------------------------------------------
    // Page settings
    // -----------------------------------------------------------------------

    pub fn get_page_size_mm(&self) -> String {
        serde_json::to_string(&self.doc.page_size).unwrap_or_default()
    }

    pub fn get_bleed_mm(&self) -> f32 { self.doc.bleed_mm }
    pub fn get_safe_zone_mm(&self) -> f32 { self.doc.safe_zone_mm }
    pub fn get_spine_mm_per_page(&self) -> f32 { self.doc.spine_mm_per_page }
    pub fn get_spine_min_mm(&self) -> f32 { self.doc.spine_min_mm }
    pub fn get_print_dpi(&self) -> f32 { self.doc.print_dpi }

    pub fn set_page_settings(
        &mut self,
        width_mm: f32,
        height_mm: f32,
        bleed_mm: f32,
        safe_zone_mm: f32,
        spine_mm_per_page: f32,
        spine_min_mm: f32,
        print_dpi: f32,
    ) {
        self.doc.page_size.width_mm  = width_mm.max(1.0);
        self.doc.page_size.height_mm = height_mm.max(1.0);
        self.doc.bleed_mm            = bleed_mm.max(0.0);
        self.doc.safe_zone_mm        = safe_zone_mm.max(0.0);
        self.doc.spine_mm_per_page   = spine_mm_per_page.max(0.0);
        self.doc.spine_min_mm        = spine_min_mm.max(0.0);
        self.doc.print_dpi           = print_dpi.clamp(72.0, 1200.0);
        self.full_invalidate();
    }
}

/// Cheap upper-bound estimate of a document's retained memory, used to bound the
/// undo history by bytes instead of a fixed snapshot count. Counts collection
/// sizes rather than serializing — undo snapshots happen per edit, not per frame.
fn estimate_doc_bytes(doc: &crate::page::PhotobookDocument) -> usize {
    let mut bytes = 4096usize;
    for s in &doc.spreads {
        bytes += 512;
        bytes += s.layout.faces.len() * 512;
        bytes += s.layout.edges.len() * 128;
        bytes += s.text_elements.len() * 256;
    }
    bytes
}
