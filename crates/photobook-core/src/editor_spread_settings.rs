use wasm_bindgen::prelude::*;
use crate::page::SpreadKind;
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Spreads
    // -----------------------------------------------------------------------

    pub fn add_page(&mut self) {
        self.doc.add_spread();
        let (t, r, b, l) = (
            self.doc.default_margin_top,
            self.doc.default_margin_right,
            self.doc.default_margin_bottom,
            self.doc.default_margin_left,
        );
        if let Some(spread) = self.doc.spreads.last_mut() {
            for face in spread.layout.faces.values_mut() {
                face.box_model.margin.top    = t;
                face.box_model.margin.right  = r;
                face.box_model.margin.bottom = b;
                face.box_model.margin.left   = l;
            }
        }
        let n = self.doc.spreads.len();
        self.spread_dirty.resize(n, true);
        self.mark_structure_dirty();
    }

    pub fn remove_page(&mut self, spread_idx: u32) {
        self.doc.remove_spread(spread_idx as usize);
        let n = self.doc.spreads.len();
        self.spread_dirty.resize(n, true);
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
        struct SpreadInfo<'a> { id: u32, label: &'a str, kind: &'static str, width_mm: f32, height_mm: f32 }
        let h = self.doc.page_size.height_mm;
        let info: Vec<_> = self.doc.spreads.iter().map(|s| SpreadInfo {
            id: s.id,
            label: &s.label,
            kind: if s.kind == SpreadKind::Cover { "cover" } else { "content" },
            width_mm: self.doc.spread_width_mm(s),
            height_mm: h,
        }).collect();
        serde_json::to_string(&info).unwrap_or_default()
    }

    pub fn get_current_spread_info(&self) -> String {
        let spread = self.doc.current_spread();
        let w = self.doc.spread_width_mm(spread);
        let h = self.doc.page_size.height_mm;
        let spine = if spread.kind == SpreadKind::Cover { self.doc.spine_mm() } else { 0.0 };
        #[derive(serde::Serialize)]
        struct Info<'a> { kind: &'static str, width_mm: f32, height_mm: f32, spine_mm: f32, page_width_mm: f32, left_bg: &'a str, right_bg: &'a str }
        let info = Info {
            kind: if spread.kind == SpreadKind::Cover { "cover" } else { "content" },
            width_mm: w,
            height_mm: h,
            spine_mm: spine,
            page_width_mm: self.doc.page_size.width_mm,
            left_bg: &spread.left_bg,
            right_bg: &spread.right_bg,
        };
        serde_json::to_string(&info).unwrap_or_default()
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

    pub fn save_state(&self) -> String {
        serde_json::to_string(&self.doc).unwrap_or_default()
    }

    pub fn load_state(&mut self, json: &str) -> bool {
        match serde_json::from_str(json) {
            Ok(doc) => {
                self.doc = doc;
                self.selection.clear();
                let n = self.doc.spreads.len();
                self.structure_dirty = true;
                self.leaf_dirty.clear();
                self.low_dpi_dirty = true;
                self.low_dpi_cache = None;
                self.spread_dirty = vec![true; n];
                true
            }
            Err(_) => false,
        }
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
            face.box_model.margin.top    = top.max(0.0);
            face.box_model.margin.right  = right.max(0.0);
            face.box_model.margin.bottom = bottom.max(0.0);
            face.box_model.margin.left   = left.max(0.0);
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
        self.selection.clear();
        let n = self.doc.spreads.len();
        self.structure_dirty = true;
        self.spread_dirty = vec![true; n];
        self.low_dpi_dirty = true;
        self.low_dpi_cache = None;
    }
}
