mod interaction;
mod layout;
mod page;
mod pdf;
mod utils;

pub mod grid_layout;
pub mod grid_resolver;

mod editor_layout;
mod editor_layout_transform;
mod editor_selection;
mod editor_box_model;
mod editor_image_ops;
mod editor_text_ops;
mod editor_spread_settings;
mod editor_pinwheel;
pub(crate) mod editor_tests;

#[cfg(feature = "wasm-test")]
mod wasm_test_runner;

use editor_layout::DragEdgePanel;
use editor_pinwheel::DragPinwheelSpawn;
use interaction::DragState;
use layout::{Rect, ResolvedDivider, ResolvedFrame};
use page::PhotobookDocument;
use grid_layout::{EdgeId, FaceId, GridLayout};
use grid_resolver::GridResolver;
use wasm_bindgen::prelude::*;
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Low-DPI frame cache
// ---------------------------------------------------------------------------

pub(crate) struct LowDpiCache {
    pub canvas_w_bits: u32,
    pub canvas_h_bits: u32,
    pub spread_idx: usize,
    pub json: String,
}

#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[cfg(not(feature = "console_error_panic_hook"))]
#[wasm_bindgen]
pub fn init_panic_hook() {}

// ---------------------------------------------------------------------------
// Main editor struct
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct PhotobookEditor {
    pub(crate) doc: PhotobookDocument,
    pub(crate) selection: Vec<FaceId>,
    pub(crate) selected_segments: Vec<EdgeId>,
    pub(crate) drag: Option<DragState>,
    pub(crate) edge_panel_drag: Option<DragEdgePanel>,
    pub(crate) drag_pinwheel: Option<DragPinwheelSpawn>,
    pub(crate) debug_snapshot: Option<Box<GridLayout>>,
    pub(crate) mouse_x: f32,
    pub(crate) mouse_y: f32,
    pub(crate) image_sizes: HashMap<String, (u32, u32)>,

    // Dirty tracking for incremental rendering
    pub(crate) structure_dirty: bool,
    pub(crate) leaf_dirty: HashSet<FaceId>,
    pub(crate) spread_dirty: Vec<bool>,
    pub(crate) low_dpi_dirty: bool,
    pub(crate) low_dpi_cache: Option<LowDpiCache>,
    pub(crate) last_delta_canvas_w_bits: u32,
    pub(crate) last_delta_canvas_h_bits: u32,
    pub(crate) snap_disabled: bool,
    pub(crate) pdf_state: Option<Box<crate::pdf::PdfExportState>>,
    pub(crate) pdf_staged_images: HashMap<String, Vec<u8>>,
    pub(crate) pdf_staged_fonts:  HashMap<String, Vec<u8>>,

    // Undo/redo
    pub(crate) undo_stack: Vec<PhotobookDocument>,
    pub(crate) redo_stack: Vec<PhotobookDocument>,
}

pub(crate) const UNDO_MAX: usize = 50;

/// Memory budget for the undo history. Snapshots are evicted oldest-first once
/// the estimated retained bytes exceed this (`UNDO_MAX` remains a hard backstop).
pub(crate) const UNDO_BUDGET_BYTES: usize = 256 * 1024 * 1024;

#[wasm_bindgen]
impl PhotobookEditor {
    #[wasm_bindgen(constructor)]
    pub fn new(page_width_mm: f32, page_height_mm: f32, bleed_mm: f32) -> PhotobookEditor {
        PhotobookEditor {
            doc: PhotobookDocument::new(page_width_mm, page_height_mm, bleed_mm),
            selection: vec![],
            selected_segments: vec![],
            drag: None,
            edge_panel_drag: None,
            drag_pinwheel: None,
            debug_snapshot: None,
            mouse_x: 0.0,
            mouse_y: 0.0,
            image_sizes: HashMap::new(),
            structure_dirty: true,
            leaf_dirty: HashSet::new(),
            spread_dirty: vec![true],
            low_dpi_dirty: true,
            low_dpi_cache: None,
            last_delta_canvas_w_bits: 0,
            last_delta_canvas_h_bits: 0,
            snap_disabled: false,
            pdf_state: None,
            pdf_staged_images: HashMap::new(),
            pdf_staged_fonts:  HashMap::new(),
            undo_stack: Vec::with_capacity(UNDO_MAX),
            redo_stack: Vec::with_capacity(UNDO_MAX),
        }
    }

    pub fn set_snap_disabled(&mut self, disabled: bool) {
        self.snap_disabled = disabled;
    }

    pub fn get_debug_layout_dump(&self) -> String {
        let current_json = serde_json::to_string_pretty(&self.doc.current_spread().layout)
            .unwrap_or_else(|e| format!("\"serialize error: {e}\""));
        let prev_json = self.debug_snapshot.as_deref()
            .map(|s| serde_json::to_string_pretty(s).unwrap_or_else(|e| format!("\"serialize error: {e}\"")))
            .unwrap_or_else(|| "null".to_string());
        format!(
            "=== Layout Debug Dump ===\n\n--- PREVIOUS LAYOUT ---\n{prev_json}\n\n--- CURRENT LAYOUT ---\n{current_json}\n"
        )
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    pub(crate) fn selected_one(&self) -> Option<FaceId> {
        if self.selection.len() == 1 { Some(self.selection[0]) } else { None }
    }

    pub(crate) fn transform_target_node(&self) -> Option<FaceId> {
        self.selected_one()
    }

    pub(crate) fn mm_to_px(&self, canvas_w: f32) -> f32 {
        let spread_w_mm = self.doc.spread_width_mm(self.doc.current_spread());
        if spread_w_mm > 0.0 { canvas_w / spread_w_mm } else { 1.0 }
    }

    pub(crate) fn save_debug_snapshot(&mut self) {
        self.debug_snapshot = Some(Box::new(self.doc.current_spread().layout.clone()));
    }

    pub(crate) fn mark_structure_dirty(&mut self) {
        self.structure_dirty = true;
        self.low_dpi_dirty = true;
        let idx = self.doc.current_spread;
        self.ensure_spread_dirty_len();
        self.spread_dirty[idx] = true;
    }

    pub(crate) fn mark_leaf_dirty(&mut self, id: FaceId) {
        self.leaf_dirty.insert(id);
        self.low_dpi_dirty = true;
        let idx = self.doc.current_spread;
        self.ensure_spread_dirty_len();
        self.spread_dirty[idx] = true;
    }

    pub(crate) fn ensure_spread_dirty_len(&mut self) {
        let n = self.doc.spreads.len();
        if self.spread_dirty.len() < n {
            self.spread_dirty.resize(n, true);
        }
    }

    /// Mark every render cache dirty. Called by `install_doc_full` and by
    /// doc-wide settings changes whose effect is hard to bound to a subset.
    pub(crate) fn full_invalidate(&mut self) {
        let n = self.doc.spreads.len();
        self.selection.clear();
        self.structure_dirty = true;
        self.leaf_dirty.clear();
        self.low_dpi_dirty = true;
        self.low_dpi_cache = None;
        self.spread_dirty = vec![true; n];
    }

    /// Install `new_doc` as the live document and full-invalidate. Used by
    /// project loads where there's no useful diff against the prior state.
    pub(crate) fn install_doc_full(&mut self, new_doc: PhotobookDocument) {
        self.doc = new_doc;
        self.full_invalidate();
    }

    /// `self.doc` has just been replaced; mark dirty bits by diffing it against
    /// `old`. Preserves cached low-DPI / clean spread state where possible.
    pub(crate) fn diff_invalidate(&mut self, old: &PhotobookDocument) {
        let doc_settings_changed = old.page_size         != self.doc.page_size
            || old.bleed_mm          != self.doc.bleed_mm
            || old.spine_mm_per_page != self.doc.spine_mm_per_page
            || old.spine_min_mm      != self.doc.spine_min_mm
            || old.endpapers         != self.doc.endpapers;

        if doc_settings_changed {
            self.full_invalidate();
            return;
        }

        let new_n = self.doc.spreads.len();
        if self.spread_dirty.len() != new_n {
            self.spread_dirty.resize(new_n, false);
        }

        for i in 0..new_n {
            if old.spreads.get(i) != Some(&self.doc.spreads[i]) {
                self.spread_dirty[i] = true;
            }
        }

        let cur = self.doc.current_spread;
        let current_changed = old.current_spread != cur
            || old.spreads.len() != new_n
            || old.spreads.get(cur) != self.doc.spreads.get(cur);

        if current_changed {
            self.structure_dirty = true;
            self.leaf_dirty.clear();
            self.low_dpi_dirty = true;
        }
        if let Some(c) = &self.low_dpi_cache {
            if c.spread_idx >= new_n || self.spread_dirty[c.spread_idx] {
                self.low_dpi_cache = None;
                self.low_dpi_dirty = true;
            }
        }
        self.selection.clear();
    }

    pub(crate) fn root_rect_with_bleed(&self, canvas_w: f32, canvas_h: f32) -> Rect {
        let bleed_px = self.doc.bleed_mm * self.mm_to_px(canvas_w);
        Rect::new(
            -bleed_px,
            -bleed_px,
            canvas_w + 2.0 * bleed_px,
            canvas_h + 2.0 * bleed_px,
        )
    }

    pub(crate) fn current_resolved(
        &self,
        canvas_w: f32,
        canvas_h: f32,
    ) -> (Vec<ResolvedFrame>, Vec<ResolvedDivider>) {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = GridResolver::new(&spread.layout, &self.selection, mm_to_px);
        let frames   = resolver.resolve_frames(rect);
        let dividers = resolver.resolve_divider_hits(rect);
        (frames, dividers)
    }
}

// ---------------------------------------------------------------------------
// Stateless geometry export
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn compute_image_cover(
    frame_w: f32, frame_h: f32,
    img_w: f32, img_h: f32,
    pan_x: f32, pan_y: f32,
    user_scale: f32,
    rotation_deg: f32,
) -> String {
    let (cover_scale, _, total_scale) = utils::image_cover_factors(
        frame_w, frame_h, img_w, img_h, rotation_deg, user_scale,
    );
    if cover_scale <= 0.0 { return "null".into(); }
    let sw = img_w * total_scale;
    let sh = img_h * total_scale;
    let overflow_x = (sw - frame_w).max(0.0);
    let overflow_y = (sh - frame_h).max(0.0);
    serde_json::json!({
        "sw": sw,
        "sh": sh,
        "overflow_x": overflow_x,
        "overflow_y": overflow_y,
        "pan_off_x": overflow_x * pan_x,
        "pan_off_y": overflow_y * pan_y,
    }).to_string()
}
