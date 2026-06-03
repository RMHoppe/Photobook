use wasm_bindgen::prelude::*;
use crate::page::SpreadKind;
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Spreads
    // -----------------------------------------------------------------------

    pub fn add_page(&mut self) {
        self.doc.add_spread(); // inserts a settings-cloned spread after the current one
        let new_idx = (self.doc.current_spread + 1).min(self.doc.spreads.len().saturating_sub(1));
        let (t, r, b, l) = (
            self.doc.default_margin_top,
            self.doc.default_margin_right,
            self.doc.default_margin_bottom,
            self.doc.default_margin_left,
        );
        if let Some(spread) = self.doc.spreads.get_mut(new_idx) {
            for face in spread.layout.faces.values_mut() {
                face.box_model.margin.top    = Some(t);
                face.box_model.margin.right  = Some(r);
                face.box_model.margin.bottom = Some(b);
                face.box_model.margin.left   = Some(l);
            }
        }
        // Navigate to the freshly inserted spread.
        self.doc.current_spread = new_idx;
        let n = self.doc.spreads.len();
        self.spread_dirty.resize(n, true);
        // Indices shifted by the mid-insert; repaint all thumbnails.
        for d in self.spread_dirty.iter_mut() { *d = true; }
        self.mark_structure_dirty();
    }

    pub fn remove_page(&mut self, spread_idx: u32) {
        self.doc.remove_spread(spread_idx as usize);
        let n = self.doc.spreads.len();
        self.spread_dirty.resize(n, true);
        self.mark_structure_dirty();
    }

    pub fn move_spread(&mut self, from_idx: u32, to_idx: u32) {
        let from = from_idx as usize;
        let to   = to_idx   as usize;
        let n    = self.doc.spreads.len();
        if from == 0 || to == 0 || from == to || from >= n || to >= n { return; }

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

        self.spread_dirty.iter_mut().for_each(|d| *d = true);
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
            kind: if s.kind == SpreadKind::Cover { "cover" } else { "content" },
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
            kind: if spread.kind == SpreadKind::Cover { "cover" } else { "content" },
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
        if enabled && self.doc.content_spread_count() < 2 {
            self.add_page();
        }
        let n = self.doc.spreads.len();
        self.spread_dirty.resize(n, true);
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

    pub fn get_spread_margin(&self) -> String {
        let s = self.doc.current_spread();
        serde_json::json!({
            "top":    s.margin_top,
            "right":  s.margin_right,
            "bottom": s.margin_bottom,
            "left":   s.margin_left,
        }).to_string()
    }

    pub fn set_spread_margin(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let s = self.doc.current_spread_mut();
        s.margin_top    = top.max(0.0);
        s.margin_right  = right.max(0.0);
        s.margin_bottom = bottom.max(0.0);
        s.margin_left   = left.max(0.0);
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
    /// Consumes the staging buffers. Returns the total spread count, 0 on failure.
    pub fn pdf_export_begin_v2(&mut self) -> u32 {
        let images = std::mem::take(&mut self.pdf_staged_images);
        let fonts  = std::mem::take(&mut self.pdf_staged_fonts);
        let state  = crate::pdf::pdf_export_begin_with_bytes(&self.doc, images, fonts);
        let total  = state.as_ref().map_or(0, |s| s.total as u32);
        self.pdf_state = state.map(Box::new);
        total
    }

    /// Phase 1 of the staged export. Decodes images/fonts and pre-allocates
    /// one PDF page per spread. Returns the total spread count so the caller
    /// can loop over `pdf_export_spread`. Returns 0 on failure.
    pub fn pdf_export_begin(&mut self, images_json: &str, fonts_json: &str) -> u32 {
        let state = crate::pdf::pdf_export_begin(&self.doc, images_json, fonts_json);
        let total = state.as_ref().map_or(0, |s| s.total as u32);
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
    /// then clears the internal state.
    pub fn pdf_export_finish(&mut self) -> Vec<u8> {
        match self.pdf_state.take() {
            Some(state) => crate::pdf::pdf_export_finish(*state),
            None        => Vec::new(),
        }
    }

    pub fn save_state(&self) -> String {
        serde_json::to_string(&self.doc).unwrap_or_default()
    }

    pub fn load_state(&mut self, json: &str) -> bool {
        let doc: crate::page::PhotobookDocument = match serde_json::from_str(json) {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.schema_version > 1 { return false; }
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
    pub fn get_margin_step_mm(&self) -> f32 { self.doc.margin_step_mm }
    pub fn get_print_dpi(&self) -> f32 { self.doc.print_dpi }

    pub fn get_default_spread_margin_mm(&self) -> String {
        serde_json::json!({
            "top":    self.doc.default_margin_top,
            "right":  self.doc.default_margin_right,
            "bottom": self.doc.default_margin_bottom,
            "left":   self.doc.default_margin_left,
        }).to_string()
    }

    pub fn set_default_spread_margin(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        self.doc.default_margin_top    = top.max(0.0);
        self.doc.default_margin_right  = right.max(0.0);
        self.doc.default_margin_bottom = bottom.max(0.0);
        self.doc.default_margin_left   = left.max(0.0);
        for face in self.doc.current_spread_mut().layout.faces.values_mut() {
            face.box_model.margin.top    = Some(top.max(0.0));
            face.box_model.margin.right  = Some(right.max(0.0));
            face.box_model.margin.bottom = Some(bottom.max(0.0));
            face.box_model.margin.left   = Some(left.max(0.0));
        }
    }

    pub fn set_page_settings(
        &mut self,
        width_mm: f32,
        height_mm: f32,
        bleed_mm: f32,
        safe_zone_mm: f32,
        spine_mm_per_page: f32,
        spine_min_mm: f32,
        margin_step_mm: f32,
        print_dpi: f32,
    ) {
        self.doc.page_size.width_mm  = width_mm.max(1.0);
        self.doc.page_size.height_mm = height_mm.max(1.0);
        self.doc.bleed_mm            = bleed_mm.max(0.0);
        self.doc.safe_zone_mm        = safe_zone_mm.max(0.0);
        self.doc.spine_mm_per_page   = spine_mm_per_page.max(0.0);
        self.doc.spine_min_mm        = spine_min_mm.max(0.0);
        self.doc.margin_step_mm      = margin_step_mm.max(0.0);
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
