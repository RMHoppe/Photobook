mod bsp;
mod interaction;
mod layout;
mod page;
mod pdf;
mod utils;

use bsp::{BspTree, NodeId, NULL_ID, SplitAxis};
use interaction::{DragState, HitTester};
use layout::{BoxModel, LayoutResolver, Rect};
use page::{PhotobookDocument, SpreadKind};
use wasm_bindgen::prelude::*;

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
    doc: PhotobookDocument,
    selected: NodeId,
    drag: Option<DragState>,
    mouse_x: f32,
    mouse_y: f32,
}

#[wasm_bindgen]
impl PhotobookEditor {
    #[wasm_bindgen(constructor)]
    pub fn new(page_width_mm: f32, page_height_mm: f32, bleed_mm: f32) -> PhotobookEditor {
        PhotobookEditor {
            doc: PhotobookDocument::new(page_width_mm, page_height_mm, bleed_mm),
            selected: NULL_ID,
            drag: None,
            mouse_x: 0.0,
            mouse_y: 0.0,
        }
    }

    // -----------------------------------------------------------------------
    // Layout queries
    // -----------------------------------------------------------------------

    pub fn get_render_list(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, self.selected, mm_to_px);
        let leaves = resolver.resolve_leaves(rect);
        serde_json::to_string(&leaves).unwrap_or_default()
    }

    pub fn get_dividers(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, self.selected, mm_to_px);
        let divs = resolver.resolve_dividers(rect);
        serde_json::to_string(&divs).unwrap_or_default()
    }

    /// Returns JSON array of `{rect, color}` for all nodes that have a background colour set.
    /// Ordered parent-first so the canvas can draw them in the correct layering order.
    pub fn get_node_backgrounds(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, NULL_ID, mm_to_px);
        let bgs = resolver.resolve_backgrounds(rect);
        serde_json::to_string(&bgs).unwrap_or_default()
    }

    /// Returns JSON `{outer:{x,y,w,h}, inner:{x,y,w,h}}` for the selected node in canvas
    /// coordinates (outer = before margin, inner = after margin), or `null` if nothing selected.
    pub fn get_selected_transform_handles(&self, canvas_w: f32, canvas_h: f32) -> String {
        if self.selected == NULL_ID { return "null".into(); }
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, self.selected, mm_to_px);
        let Some((outer, inner)) = resolver.resolve_node_outer_inner(self.selected, root_rect) else {
            return "null".into();
        };
        #[derive(serde::Serialize)]
        struct R { x: f32, y: f32, w: f32, h: f32 }
        #[derive(serde::Serialize)]
        struct H { outer: R, inner: R }
        serde_json::to_string(&H {
            outer: R { x: outer.x, y: outer.y, w: outer.w, h: outer.h },
            inner: R { x: inner.x, y: inner.y, w: inner.w, h: inner.h },
        }).unwrap_or_else(|_| "null".into())
    }

    /// Set the margin of the currently selected node (values in mm, clamped to ≥ 0).
    pub fn set_node_margin(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        if self.selected == NULL_ID { return; }
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(self.selected) {
            node.box_model.margin.top    = top.max(0.0);
            node.box_model.margin.right  = right.max(0.0);
            node.box_model.margin.bottom = bottom.max(0.0);
            node.box_model.margin.left   = left.max(0.0);
        }
    }

    /// If the currently selected node is a split (not a leaf), returns JSON `{x,y,w,h}`
    /// of its content rect in canvas coordinates, otherwise returns JSON `null`.
    pub fn get_selected_split_info(&self, canvas_w: f32, canvas_h: f32) -> String {
        if self.selected == NULL_ID { return "null".into(); }
        let spread = self.doc.current_spread();
        let Some(node) = spread.tree.get(self.selected) else { return "null".into(); };
        if !matches!(node.kind, bsp::BspKind::Split(_)) { return "null".into(); }
        let mm_to_px = self.mm_to_px(canvas_w);
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, self.selected, mm_to_px);
        let Some(rect) = resolver.resolve_node_rect(self.selected, root_rect) else { return "null".into(); };
        #[derive(serde::Serialize)]
        struct R { x: f32, y: f32, w: f32, h: f32 }
        serde_json::to_string(&R { x: rect.x, y: rect.y, w: rect.w, h: rect.h })
            .unwrap_or_else(|_| "null".into())
    }

    // -----------------------------------------------------------------------
    // Selection & navigation
    // -----------------------------------------------------------------------

    pub fn hit_test(&mut self, x: f32, y: f32, canvas_w: f32, canvas_h: f32) -> u32 {
        self.mouse_x = x;
        self.mouse_y = y;
        let (leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(leaves, divs);
        if tester.hit_divider(x, y).is_some() {
            return NULL_ID;
        }
        tester.hit_leaf(x, y)
    }

    pub fn select_node(&mut self, id: u32) {
        if id == NULL_ID {
            self.selected = NULL_ID;
        } else if self.doc.current_spread().tree.get(id).is_some() {
            self.selected = id;
        }
    }

    pub fn navigate(&mut self, direction: &str) {
        self.selected = self.doc.current_spread().tree.navigate(self.selected, direction);
    }

    pub fn get_selected(&self) -> u32 {
        self.selected
    }

    // -----------------------------------------------------------------------
    // Tree mutation
    // -----------------------------------------------------------------------

    pub fn split_selected(&mut self, axis: &str) -> bool {
        if self.selected == NULL_ID { return false; }
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        if let Some((first, _)) = self.doc.current_spread_mut().tree.split(self.selected, split_axis) {
            self.selected = first;
            return true;
        }
        false
    }

    /// Split the selected leaf at a specific ratio instead of the default 0.5.
    pub fn split_selected_at(&mut self, axis: &str, ratio: f32) -> bool {
        if self.selected == NULL_ID { return false; }
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        let id = self.selected;
        if let Some((first, _)) = self.doc.current_spread_mut().tree.split(id, split_axis) {
            self.set_node_ratio(id, ratio.clamp(0.05, 0.95));
            self.selected = first;
            return true;
        }
        false
    }

    pub fn delete_selected(&mut self) -> bool {
        if self.selected == NULL_ID { return false; }
        if let Some(promoted) = self.doc.current_spread_mut().tree.delete_leaf(self.selected) {
            self.selected = promoted;
            return true;
        }
        false
    }

    // -----------------------------------------------------------------------
    // Divider drag
    // -----------------------------------------------------------------------

    pub fn begin_divider_drag(&mut self, node_id: u32, canvas_w: f32, canvas_h: f32) {
        let (_leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        if let Some(div) = divs.iter().find(|d| d.node_id == node_id) {
            self.drag = Some(DragState {
                node_id,
                axis: div.axis.clone(),
            });
        }
    }

    pub fn update_divider_drag(&mut self, mouse_x: f32, mouse_y: f32, canvas_w: f32, canvas_h: f32) {
        self.mouse_x = mouse_x;
        self.mouse_y = mouse_y;
        let (node_id, axis) = match &self.drag {
            Some(d) => (d.node_id, d.axis.clone()),
            None => return,
        };

        // Resolve the current layout to get this node's inner rect and all divider positions.
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px = self.mm_to_px(canvas_w);
        let resolver = LayoutResolver::new(&self.doc.current_spread().tree, NULL_ID, mm_to_px);

        let Some(node_rect) = resolver.resolve_node_rect(node_id, root_rect) else { return; };
        let dim = if axis == "v" { node_rect.w } else { node_rect.h };
        if dim <= 0.0 { return; }

        // Ratio from absolute mouse position (exact, unlike the old delta approach).
        let raw_pos = if axis == "v" { mouse_x } else { mouse_y };
        let origin  = if axis == "v" { node_rect.x } else { node_rect.y };
        let raw_ratio = (raw_pos - origin) / dim;

        // Collect snap targets: other dividers on the same axis.
        const SNAP_PX: f32 = 8.0;
        let dividers = resolver.resolve_dividers(root_rect);
        let mut new_ratio = raw_ratio;
        for div in dividers.iter().filter(|d| d.node_id != node_id && d.axis == axis) {
            let snap_pos   = if axis == "v" { div.x } else { div.y };
            let candidate  = origin + raw_ratio * dim;
            if (candidate - snap_pos).abs() < SNAP_PX {
                new_ratio = (snap_pos - origin) / dim;
                break;
            }
        }

        self.set_node_ratio(node_id, new_ratio.clamp(0.05, 0.95));
    }

    pub fn end_divider_drag(&mut self) {
        self.drag = None;
    }

    // -----------------------------------------------------------------------
    // Box model
    // -----------------------------------------------------------------------

    pub fn get_box_model(&self) -> String {
        if self.selected == NULL_ID {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        }
        let bm = self.doc.current_spread().tree
            .get(self.selected)
            .map(|n| n.box_model.clone())
            .unwrap_or_default();
        serde_json::to_string(&bm).unwrap_or_default()
    }

    /// Copy the current node's `gap` value to every descendant in the subtree.
    pub fn apply_gap_to_subtree(&mut self, node_id: u32) {
        let gap = match self.doc.current_spread().tree.get(node_id) {
            Some(n) => n.box_model.gap,
            None => return,
        };
        let descendants = self.doc.current_spread().tree.descendants(node_id);
        for id in descendants {
            if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
                node.box_model.gap = gap;
            }
        }
    }

    /// Copy the current node's `bg` value to every descendant in the subtree.
    pub fn apply_bg_to_subtree(&mut self, node_id: u32) {
        let bg = match self.doc.current_spread().tree.get(node_id) {
            Some(n) => n.box_model.bg.clone(),
            None => return,
        };
        let descendants = self.doc.current_spread().tree.descendants(node_id);
        for id in descendants {
            if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
                node.box_model.bg = bg.clone();
            }
        }
    }

    pub fn set_box_model(&mut self, json: &str) {
        let bm: BoxModel = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(_) => return,
        };
        if self.selected == NULL_ID { return; }
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(self.selected) {
            node.box_model = bm;
        }
    }

    // -----------------------------------------------------------------------
    // Image assignment
    // -----------------------------------------------------------------------

    /// Swap the image (and its transform) between two leaf nodes.
    pub fn swap_images(&mut self, node_a: u32, node_b: u32) {
        if node_a == node_b { return; }
        // Clone both leaf payloads first to satisfy the borrow checker.
        let snapshot = |tree: &crate::bsp::BspTree, id: u32|
            -> Option<(Option<String>, f32, f32, f32, f32)>
        {
            match &tree.get(id)?.kind {
                bsp::BspKind::Leaf(l) =>
                    Some((l.image_id.clone(), l.pan_x, l.pan_y, l.scale, l.rotation_deg)),
                _ => None,
            }
        };
        let tree = &self.doc.current_spread().tree;
        let (Some(a), Some(b)) = (snapshot(tree, node_a), snapshot(tree, node_b)) else { return; };
        let tree = &mut self.doc.current_spread_mut().tree;
        if let Some(n) = tree.get_mut(node_a) {
            if let bsp::BspKind::Leaf(ref mut l) = n.kind {
                l.image_id = b.0; l.pan_x = b.1; l.pan_y = b.2; l.scale = b.3; l.rotation_deg = b.4;
            }
        }
        if let Some(n) = tree.get_mut(node_b) {
            if let bsp::BspKind::Leaf(ref mut l) = n.kind {
                l.image_id = a.0; l.pan_x = a.1; l.pan_y = a.2; l.scale = a.3; l.rotation_deg = a.4;
            }
        }
    }

    pub fn assign_image(&mut self, node_id: u32, image_id: &str) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            if let bsp::BspKind::Leaf(ref mut l) = node.kind {
                l.image_id = Some(image_id.to_string());
                // Reset transform so every new assignment starts centered.
                l.pan_x = 0.5;
                l.pan_y = 0.5;
                l.scale = 1.0;
                l.rotation_deg = 0.0;
            }
        }
    }

    /// Update the image transform for a leaf node.
    pub fn set_image_transform(
        &mut self,
        node_id: u32,
        pan_x: f32,
        pan_y: f32,
        scale: f32,
        rotation_deg: f32,
    ) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            if let bsp::BspKind::Leaf(ref mut l) = node.kind {
                l.pan_x = pan_x.clamp(0.0, 1.0);
                l.pan_y = pan_y.clamp(0.0, 1.0);
                l.scale = scale.max(1.0);
                l.rotation_deg = rotation_deg;
            }
        }
    }

    /// Return `{pan_x, pan_y, scale, rotation_deg}` JSON for a leaf node.
    pub fn get_leaf_transform(&self, node_id: u32) -> String {
        #[derive(serde::Serialize)]
        struct T { pan_x: f32, pan_y: f32, scale: f32, rotation_deg: f32 }
        let t = self.doc.current_spread().tree.get(node_id)
            .and_then(|n| if let bsp::BspKind::Leaf(ref l) = n.kind {
                Some(T { pan_x: l.pan_x, pan_y: l.pan_y, scale: l.scale, rotation_deg: l.rotation_deg })
            } else { None })
            .unwrap_or(T { pan_x: 0.5, pan_y: 0.5, scale: 1.0, rotation_deg: 0.0 });
        serde_json::to_string(&t).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Spreads
    // -----------------------------------------------------------------------

    pub fn add_page(&mut self) {
        self.doc.add_spread();
    }

    pub fn remove_page(&mut self, spread_idx: u32) {
        self.doc.remove_spread(spread_idx as usize);
    }

    pub fn set_current_spread(&mut self, spread_idx: u32) {
        let idx = spread_idx as usize;
        if idx < self.doc.spreads.len() {
            self.doc.current_spread = idx;
            self.selected = NULL_ID;
        }
    }

    pub fn get_spread_count(&self) -> u32 {
        self.doc.spreads.len() as u32
    }

    pub fn get_current_spread_index(&self) -> u32 {
        self.doc.current_spread as u32
    }

    /// Returns JSON array of {id, label, kind} for all spreads (lightweight, no tree data).
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

    /// Returns JSON {kind, width_mm, height_mm, spine_mm, page_width_mm} for the current spread.
    pub fn get_current_spread_info(&self) -> String {
        let spread = self.doc.current_spread();
        let w = self.doc.spread_width_mm(spread);
        let h = self.doc.page_size.height_mm;
        let spine = if spread.kind == SpreadKind::Cover { self.doc.spine_mm() } else { 0.0 };
        #[derive(serde::Serialize)]
        struct Info { kind: &'static str, width_mm: f32, height_mm: f32, spine_mm: f32, page_width_mm: f32 }
        let info = Info {
            kind: if spread.kind == SpreadKind::Cover { "cover" } else { "content" },
            width_mm: w,
            height_mm: h,
            spine_mm: spine,
            page_width_mm: self.doc.page_size.width_mm,
        };
        serde_json::to_string(&info).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // PDF export
    // -----------------------------------------------------------------------

    pub fn export_pdf(&self, images_json: &str) -> Vec<u8> {
        pdf::export_pdf(&self.doc, images_json)
    }

    // -----------------------------------------------------------------------
    // State serialization
    // -----------------------------------------------------------------------

    pub fn save_state(&self) -> String {
        serde_json::to_string(&self.doc).unwrap_or_default()
    }

    pub fn load_state(&mut self, json: &str) -> bool {
        match serde_json::from_str(json) {
            Ok(doc) => {
                self.doc = doc;
                self.selected = NULL_ID;
                true
            }
            Err(_) => false,
        }
    }

    // -----------------------------------------------------------------------
    // Geometry helpers
    // -----------------------------------------------------------------------

    pub fn get_page_size_mm(&self) -> String {
        serde_json::to_string(&self.doc.page_size).unwrap_or_default()
    }

    pub fn get_bleed_mm(&self) -> f32 {
        self.doc.bleed_mm
    }

    pub fn get_safe_zone_mm(&self) -> f32 {
        self.doc.safe_zone_mm
    }

    pub fn get_spine_mm_per_page(&self) -> f32 {
        self.doc.spine_mm_per_page
    }

    pub fn get_spine_min_mm(&self) -> f32 {
        self.doc.spine_min_mm
    }

    pub fn set_mouse_pos(&mut self, x: f32, y: f32) {
        self.mouse_x = x;
        self.mouse_y = y;
    }

    pub fn split_axis_hint(&self, canvas_w: f32, canvas_h: f32) -> String {
        if self.selected == NULL_ID { return "v".into(); }
        let (leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(leaves, divs);
        tester.split_axis_hint(self.selected, self.mouse_x, self.mouse_y).to_string()
    }

    pub fn hovered_divider(&self, canvas_w: f32, canvas_h: f32) -> u32 {
        let (leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(leaves, divs);
        tester.hit_divider(self.mouse_x, self.mouse_y)
            .map(|(id, _)| id)
            .unwrap_or(NULL_ID)
    }

    pub fn get_margin_step_mm(&self) -> f32 {
        self.doc.margin_step_mm
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
    ) {
        self.doc.page_size.width_mm  = width_mm.max(1.0);
        self.doc.page_size.height_mm = height_mm.max(1.0);
        self.doc.bleed_mm            = bleed_mm.max(0.0);
        self.doc.safe_zone_mm        = safe_zone_mm.max(0.0);
        self.doc.spine_mm_per_page   = spine_mm_per_page.max(0.0);
        self.doc.spine_min_mm        = spine_min_mm.max(0.0);
        self.doc.margin_step_mm      = margin_step_mm.max(0.0);
        self.selected = NULL_ID;
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    fn active_tree(&self) -> &BspTree {
        &self.doc.current_spread().tree
    }

    /// mm-to-canvas-pixel scale factor for the current spread.
    fn mm_to_px(&self, canvas_w: f32) -> f32 {
        let spread_w_mm = self.doc.spread_width_mm(self.doc.current_spread());
        if spread_w_mm > 0.0 { canvas_w / spread_w_mm } else { 1.0 }
    }

    fn get_node_ratio(&self, node_id: NodeId) -> f32 {
        self.active_tree()
            .get(node_id)
            .and_then(|n| match &n.kind {
                bsp::BspKind::Split(s) => Some(s.ratio),
                _ => None,
            })
            .unwrap_or(0.5)
    }

    fn set_node_ratio(&mut self, node_id: NodeId, ratio: f32) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            if let bsp::BspKind::Split(ref mut s) = node.kind {
                s.ratio = ratio;
            }
        }
    }

    /// Root rect in canvas pixels that includes bleed on all sides.
    /// Frames whose edges sit at the spread boundary naturally extend into the bleed.
    fn root_rect_with_bleed(&self, canvas_w: f32, canvas_h: f32) -> Rect {
        let bleed_px = self.doc.bleed_mm * self.mm_to_px(canvas_w);
        Rect::new(-bleed_px, -bleed_px, canvas_w + 2.0 * bleed_px, canvas_h + 2.0 * bleed_px)
    }

    fn current_resolved(
        &self,
        canvas_w: f32,
        canvas_h: f32,
    ) -> (Vec<layout::ResolvedLeaf>, Vec<layout::ResolvedDivider>) {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, self.selected, mm_to_px);
        (resolver.resolve_leaves(rect), resolver.resolve_dividers(rect))
    }
}
