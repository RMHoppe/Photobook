use wasm_bindgen::prelude::*;
use serde::Serialize;
use crate::bsp::{BspKind, NULL_ID};
use crate::interaction::HitTester;
use crate::layout::{LayoutResolver, Rect, ResolvedLeaf, TransformHandles};
use crate::PhotobookEditor;

// ---------------------------------------------------------------------------
// Delta types — serialised and consumed by the TS SpreadGeometryCache
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SpreadDelta<'a> {
    full: Option<&'a crate::layout::ResolvedSpread>,
    updated_leaves: Option<&'a [ResolvedLeaf]>,
}

#[wasm_bindgen]
impl PhotobookEditor {
    pub fn get_render_list(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, &self.selection, mm_to_px);
        let leaves = resolver.resolve_leaves(rect);
        serde_json::to_string(&leaves).unwrap_or_default()
    }

    pub fn get_dividers(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let divs = resolver.resolve_dividers(rect);
        serde_json::to_string(&divs).unwrap_or_default()
    }

    /// Returns JSON array of `{rect, color}` for all nodes that have a background colour set.
    /// Ordered parent-first so the canvas can draw them in the correct layering order.
    pub fn get_node_backgrounds(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let bgs = resolver.resolve_backgrounds(rect);
        serde_json::to_string(&bgs).unwrap_or_default()
    }

    /// Returns JSON `{outer:{x,y,w,h}, inner:{x,y,w,h}}` for the selected node in canvas
    /// coordinates, or `null` if the selection is empty or contains more than one node.
    pub fn get_selected_transform_handles(&self, canvas_w: f32, canvas_h: f32) -> String {
        let id = if self.selection.len() == 1 {
            self.selection[0]
        } else if self.selection.len() > 1 {
            let spread = self.doc.current_spread();
            spread.tree.lowest_common_ancestor(&self.selection)
        } else {
            return "null".into();
        };
        if id == NULL_ID { return "null".into(); }
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let Some((outer, inner)) = resolver.resolve_node_outer_inner(id, root_rect) else {
            return "null".into();
        };
        serde_json::to_string(&TransformHandles { outer, inner })
            .unwrap_or_else(|_| "null".into())
    }

    /// If the selected node is a split (not a leaf), returns JSON `{x,y,w,h}` of its content
    /// rect in canvas coordinates. Returns `null` if nothing / multi-selection / leaf selected.
    pub fn get_selected_split_info(&self, canvas_w: f32, canvas_h: f32) -> String {
        let Some(id) = self.selected_one() else { return "null".into(); };
        let spread = self.doc.current_spread();
        let Some(node) = spread.tree.get(id) else { return "null".into(); };
        if !matches!(node.kind, BspKind::Split(_)) { return "null".into(); }
        let mm_to_px = self.mm_to_px(canvas_w);
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let Some(rect) = resolver.resolve_node_rect(id, root_rect) else { return "null".into(); };
        serde_json::to_string(&rect).unwrap_or_else(|_| "null".into())
    }

    /// Returns JSON array of resolved split borders for the current spread.
    pub fn get_split_node_borders(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let borders = resolver.resolve_split_borders(rect);
        serde_json::to_string(&borders).unwrap_or_else(|_| "[]".into())
    }

    pub fn hovered_divider(&self, canvas_w: f32, canvas_h: f32) -> u32 {
        let (leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(leaves, divs);
        tester.hit_divider(self.mouse_x, self.mouse_y)
            .map(|(id, _)| id)
            .unwrap_or(NULL_ID)
    }

    pub fn split_axis_hint(&self, canvas_w: f32, canvas_h: f32) -> String {
        let Some(id) = self.selected_one() else { return "v".into(); };
        let (leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(leaves, divs);
        tester.split_axis_hint(id, self.mouse_x, self.mouse_y).to_string()
    }

    pub fn split_axis_hint_for(&self, id: u32, canvas_w: f32, canvas_h: f32) -> String {
        let (leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(leaves, divs);
        tester.split_axis_hint(id, self.mouse_x, self.mouse_y).to_string()
    }

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

    pub fn set_mouse_pos(&mut self, x: f32, y: f32) {
        self.mouse_x = x;
        self.mouse_y = y;
    }

    // -----------------------------------------------------------------------
    // Incremental rendering — delta protocol
    // -----------------------------------------------------------------------

    /// Returns a JSON `SpreadDelta` for the current spread.
    ///
    /// - `full` is non-null when the tree structure changed (full re-resolve).
    /// - `updated_leaves` is non-null (and `full` is null) when only leaf data changed.
    /// - Both null means nothing changed.
    ///
    /// Clears dirty flags after serialising.
    pub fn get_resolved_spread_delta(&mut self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);

        if self.structure_dirty {
            let resolver = LayoutResolver::new(&spread.tree, &self.selection, mm_to_px);
            let resolved = resolver.resolve_all(rect);
            self.structure_dirty = false;
            self.leaf_dirty.clear();
            let delta = SpreadDelta { full: Some(&resolved), updated_leaves: None };
            return serde_json::to_string(&delta).unwrap_or_default();
        }

        if !self.leaf_dirty.is_empty() {
            let resolver = LayoutResolver::new(&spread.tree, &self.selection, mm_to_px);
            let dirty_ids = self.leaf_dirty.iter().copied().collect::<Vec<_>>();
            // Resolve only the dirty leaves by doing a full resolve_leaves pass and filtering.
            let all_leaves = resolver.resolve_leaves(rect);
            let updated: Vec<ResolvedLeaf> = all_leaves.into_iter()
                .filter(|l| dirty_ids.contains(&l.id))
                .collect();
            self.leaf_dirty.clear();
            let delta = SpreadDelta { full: None, updated_leaves: Some(&updated) };
            return serde_json::to_string(&delta).unwrap_or_default();
        }

        // Nothing dirty.
        let delta = SpreadDelta::<'_> { full: None, updated_leaves: None };
        serde_json::to_string(&delta).unwrap_or_default()
    }

    /// Returns a JSON array of `ResolvedLeaf` for the given spread index at thumbnail size.
    /// Pure read — does not change `current_spread` or any other state.
    pub fn get_thumbnail_data(&self, spread_idx: usize, thumb_w: f32, thumb_h: f32) -> String {
        let Some(spread) = self.doc.spreads.get(spread_idx) else { return "[]".into() };
        let spread_w_mm = self.doc.spread_width_mm(spread);
        let mm_to_px = if spread_w_mm > 0.0 { thumb_w / spread_w_mm } else { 1.0 };
        let root_rect = Rect::new(0.0, 0.0, thumb_w, thumb_h);
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let leaves = resolver.resolve_leaves(root_rect);
        serde_json::to_string(&leaves).unwrap_or_else(|_| "[]".into())
    }

    /// Returns a JSON array of spread indices that have pending thumbnail updates,
    /// then clears those dirty bits.
    pub fn get_dirty_spread_indices(&mut self) -> String {
        self.ensure_spread_dirty_len();
        let dirty: Vec<usize> = self.spread_dirty.iter().enumerate()
            .filter_map(|(i, &d)| if d { Some(i) } else { None })
            .collect();
        for i in &dirty {
            self.spread_dirty[*i] = false;
        }
        serde_json::to_string(&dirty).unwrap_or_else(|_| "[]".into())
    }
}
