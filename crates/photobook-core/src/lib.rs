mod bsp;
mod interaction;
mod layout;
mod page;
mod pdf;
mod utils;

mod editor_layout;
mod editor_selection;
mod editor_box_model;
mod editor_image_ops;
mod editor_text_ops;
mod editor_spread_settings;
mod editor_pinwheel;

use bsp::{BspKind, NodeId, NULL_ID};
use editor_pinwheel::DragPinwheelSpawn;
use interaction::DragState;
use layout::{LayoutResolver, Rect, ResolvedDivider, ResolvedLeaf};
use page::PhotobookDocument;
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
    pub(crate) selection: Vec<NodeId>,
    pub(crate) drag: Option<DragState>,
    pub(crate) pinwheel_drag: Option<DragPinwheelSpawn>,
    pub(crate) mouse_x: f32,
    pub(crate) mouse_y: f32,
    pub(crate) image_sizes: HashMap<String, (u32, u32)>,

    // Dirty tracking for incremental rendering
    pub(crate) structure_dirty: bool,
    pub(crate) leaf_dirty: HashSet<NodeId>,
    pub(crate) spread_dirty: Vec<bool>,
    pub(crate) low_dpi_dirty: bool,
    pub(crate) low_dpi_cache: Option<LowDpiCache>,
}

#[wasm_bindgen]
impl PhotobookEditor {
    #[wasm_bindgen(constructor)]
    pub fn new(page_width_mm: f32, page_height_mm: f32, bleed_mm: f32) -> PhotobookEditor {
        PhotobookEditor {
            doc: PhotobookDocument::new(page_width_mm, page_height_mm, bleed_mm),
            selection: vec![],
            drag: None,
            pinwheel_drag: None,
            mouse_x: 0.0,
            mouse_y: 0.0,
            image_sizes: HashMap::new(),
            structure_dirty: true,
            leaf_dirty: HashSet::new(),
            spread_dirty: vec![true],
            low_dpi_dirty: true,
            low_dpi_cache: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers (pub(crate) so child modules can call them)
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    /// Returns the single selected node ID, or `None` if selection is empty or > 1.
    pub(crate) fn selected_one(&self) -> Option<NodeId> {
        if self.selection.len() == 1 { Some(self.selection[0]) } else { None }
    }

    /// Returns the node that transform handle operations should target:
    /// the selected node for single selection, or the LCA for multi-selection.
    pub(crate) fn transform_target_node(&self) -> Option<NodeId> {
        match self.selection.len() {
            0 => None,
            1 => Some(self.selection[0]),
            _ => {
                let id = self.doc.current_spread().tree.lowest_common_ancestor(&self.selection);
                if id == NULL_ID { None } else { Some(id) }
            }
        }
    }

    /// mm-to-canvas-pixel scale factor for the current spread.
    pub(crate) fn mm_to_px(&self, canvas_w: f32) -> f32 {
        let spread_w_mm = self.doc.spread_width_mm(self.doc.current_spread());
        if spread_w_mm > 0.0 { canvas_w / spread_w_mm } else { 1.0 }
    }

    pub(crate) fn mark_structure_dirty(&mut self) {
        self.structure_dirty = true;
        self.low_dpi_dirty = true;
        let idx = self.doc.current_spread;
        self.ensure_spread_dirty_len();
        self.spread_dirty[idx] = true;
    }

    pub(crate) fn mark_leaf_dirty(&mut self, id: NodeId) {
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

    pub(crate) fn set_node_ratio(&mut self, node_id: NodeId, ratio: f32) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            if let BspKind::Split(ref mut s) = node.kind {
                s.ratio = ratio;
            }
        }
    }

    /// Root rect in canvas pixels that includes bleed on all sides.
    pub(crate) fn root_rect_with_bleed(&self, canvas_w: f32, canvas_h: f32) -> Rect {
        let bleed_px = self.doc.bleed_mm * self.mm_to_px(canvas_w);
        Rect::new(-bleed_px, -bleed_px, canvas_w + 2.0 * bleed_px, canvas_h + 2.0 * bleed_px)
    }

    pub(crate) fn current_resolved(
        &self,
        canvas_w: f32,
        canvas_h: f32,
    ) -> (Vec<ResolvedLeaf>, Vec<ResolvedDivider>) {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolved = LayoutResolver::new(&spread.tree, &[], mm_to_px).resolve_all(rect);
        (resolved.leaves, resolved.dividers)
    }
}

// ---------------------------------------------------------------------------
// Stateless geometry export
// ---------------------------------------------------------------------------

/// Compute image cover-fit geometry for canvas rendering and pan-mode setup.
///
/// Takes frame and image dimensions in the same unit (typically canvas pixels),
/// plus the image transform parameters. Returns JSON:
/// `{ sw, sh, overflow_x, overflow_y, pan_off_x, pan_off_y }`
///
/// Returns `"null"` when any dimension is non-positive.
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
