use wasm_bindgen::prelude::*;
use serde::Serialize;
use crate::interaction::{DragState, HitTester};
use crate::layout::{Rect, ResolvedFrame, SplitAxis, TransformHandles};
use crate::grid_layout::{EdgeId, Facing, FaceId, GridLayout, Orientation, OUTER_FACE};
use crate::grid_resolver::GridResolver;
use crate::PhotobookEditor;

// ---------------------------------------------------------------------------
// Free-function helpers
// ---------------------------------------------------------------------------

fn axis_drag_coord(axis: SplitAxis, mouse_x: f32, mouse_y: f32, root: Rect) -> (f32, f32) {
    match axis {
        SplitAxis::Horizontal => ((mouse_y - root.y) / root.h, 8.0 / root.h.max(1.0)),
        SplitAxis::Vertical   => ((mouse_x - root.x) / root.w, 8.0 / root.w.max(1.0)),
    }
}

/// Snap `raw` to the nearest candidate within `snap_r`, then clamp to `(lo, hi)`.
/// Candidates: initial offset (snap-back), spread centre (0.5), range midpoint,
/// other dividers (excluding `chain`).
fn snap_and_clamp(
    layout: &GridLayout, axis: SplitAxis, raw: f32, chain: &[EdgeId], snap_r: f32,
    lo: f32, hi: f32, initial_offset: f32,
) -> f32 {
    let edge_snap = layout.snap(axis, raw, chain, snap_r);
    let mut snapped = raw;
    let mut best_dist = snap_r;
    for &t in &[initial_offset, 0.5_f32, (lo + hi) / 2.0] {
        let d = (t - raw).abs();
        if d < best_dist { best_dist = d; snapped = t; }
    }
    if edge_snap != raw {
        let d = (edge_snap - raw).abs();
        if d < best_dist { snapped = edge_snap; }
    }
    snapped.clamp(lo + 1e-4, hi - 1e-4)
}

/// Snap and clamp a drag position. Nearest candidate within `snap_r` wins.
/// Candidates: initial offset (snap-back), spread centre (0.5), drag-range
/// midpoint, other dividers.
/// Returns `None` if the drag range is invalid (lo ≥ hi after padding).
///
/// `total_w_mm` / `total_h_mm`: full spread width/height in mm including bleed
/// (the mm extent corresponding to the [0, 1] normalized offset space), used
/// by `chain_drag_bounds` to account for half-gap margins in the valid range.
fn apply_drag_snap(
    layout: &GridLayout, axis: SplitAxis, raw: f32, chain: &[EdgeId], snap_r: f32,
    total_w_mm: f32, total_h_mm: f32, initial_offset: f32,
) -> Option<f32> {
    let (lo, hi) = layout.chain_drag_bounds(chain, total_w_mm, total_h_mm)?;
    let clo = lo + 1e-4;
    let chi = hi - 1e-4;
    if clo > chi { return None; }
    Some(snap_and_clamp(layout, axis, raw, chain, snap_r, lo, hi, initial_offset))
}

// ---------------------------------------------------------------------------
// Delta types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SpreadDelta<'a> {
    full: Option<&'a crate::layout::ResolvedSpread>,
    updated_frames: Option<&'a [ResolvedFrame]>,
}

#[wasm_bindgen]
impl PhotobookEditor {
    pub fn get_render_list(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let frames = GridResolver::new(&spread.layout, &self.selection, mm_to_px)
            .resolve_frames(rect);
        serde_json::to_string(&frames).unwrap_or_default()
    }

    pub fn get_dividers(&self, canvas_w: f32, canvas_h: f32) -> String {
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let visible_bleed_px = if self.bleed_visible { self.doc.bleed_mm * mm_to_px } else { 0.0 };
        let divs = GridResolver::new(&spread.layout, &[], mm_to_px)
            .with_visible_bleed(visible_bleed_px)
            .resolve_dividers(rect);
        serde_json::to_string(&divs).unwrap_or_default()
    }

    pub fn get_selected_transform_handles(&self, canvas_w: f32, canvas_h: f32) -> String {
        let Some(id) = self.selected_one() else { return "null".into() };
        let spread = self.doc.current_spread();
        let Some((rx, ry, rw, rh)) = spread.layout.face_rect(id) else { return "null".into() };
        let mm_to_px = self.mm_to_px(canvas_w);
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let outer = Rect::new(
            root_rect.x + rx * root_rect.w,
            root_rect.y + ry * root_rect.h,
            rw * root_rect.w,
            rh * root_rect.h,
        );
        let frames = GridResolver::new(&spread.layout, &[], mm_to_px).resolve_frames(root_rect);
        let inner = frames.iter().find(|f| f.id == id).map(|f| f.rect).unwrap_or(outer);
        serde_json::to_string(&TransformHandles { outer, inner })
            .unwrap_or_else(|_| "null".into())
    }

    pub fn hovered_divider(&self, canvas_w: f32, canvas_h: f32) -> u32 {
        let (frames, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(frames, divs);
        tester.hit_divider(self.mouse_x, self.mouse_y)
            .map(|(id, _)| id)
            .unwrap_or(OUTER_FACE)
    }

    pub fn split_axis_hint(&self, canvas_w: f32, canvas_h: f32) -> String {
        let Some(id) = self.selected_one() else { return "v".into(); };
        let (frames, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(frames, divs);
        tester.split_axis_hint(id, self.mouse_x, self.mouse_y).to_string()
    }

    pub fn split_axis_hint_for(&self, id: u32, canvas_w: f32, canvas_h: f32) -> String {
        let (frames, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(frames, divs);
        tester.split_axis_hint(id, self.mouse_x, self.mouse_y).to_string()
    }

    pub fn hit_test(&mut self, x: f32, y: f32, canvas_w: f32, canvas_h: f32) -> u32 {
        self.mouse_x = x;
        self.mouse_y = y;
        let (frames, divs) = self.current_resolved(canvas_w, canvas_h);
        let tester = HitTester::new(frames, divs);
        if tester.hit_divider(x, y).is_some() {
            return OUTER_FACE;
        }
        tester.hit_face(x, y)
    }

    pub fn set_mouse_pos(&mut self, x: f32, y: f32) {
        self.mouse_x = x;
        self.mouse_y = y;
    }

    // -----------------------------------------------------------------------
    // Incremental rendering — delta protocol
    // -----------------------------------------------------------------------

    pub fn get_resolved_spread_delta(&mut self, canvas_w: f32, canvas_h: f32) -> String {
        let w_bits = canvas_w.to_bits();
        let h_bits = canvas_h.to_bits();
        let canvas_changed = w_bits != self.last_delta_canvas_w_bits
            || h_bits != self.last_delta_canvas_h_bits;
        self.last_delta_canvas_w_bits = w_bits;
        self.last_delta_canvas_h_bits = h_bits;

        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let rect = self.root_rect_with_bleed(canvas_w, canvas_h);

        if self.structure_dirty || canvas_changed {
            let visible_bleed_px = if self.bleed_visible { self.doc.bleed_mm * mm_to_px } else { 0.0 };
            let resolved = GridResolver::new(&spread.layout, &self.selection, mm_to_px)
                .with_visible_bleed(visible_bleed_px)
                .resolve_all(rect);
            self.structure_dirty = false;
            self.leaf_dirty.clear();
            let delta = SpreadDelta { full: Some(&resolved), updated_frames: None };
            return serde_json::to_string(&delta).unwrap_or_default();
        }

        if !self.leaf_dirty.is_empty() {
            let updated = GridResolver::new(&spread.layout, &self.selection, mm_to_px)
                .resolve_frames_for(rect, &self.leaf_dirty);
            self.leaf_dirty.clear();
            let delta = SpreadDelta { full: None, updated_frames: Some(&updated) };
            return serde_json::to_string(&delta).unwrap_or_default();
        }

        let delta = SpreadDelta::<'_> { full: None, updated_frames: None };
        serde_json::to_string(&delta).unwrap_or_default()
    }

    pub fn get_thumbnail_data(&self, spread_idx: usize, thumb_w: f32, thumb_h: f32) -> String {
        let Some(spread) = self.doc.spreads.get(spread_idx) else { return "[]".into() };
        let spread_w_mm = self.doc.spread_width_mm(spread);
        let mm_to_px = if spread_w_mm > 0.0 { thumb_w / spread_w_mm } else { 1.0 };
        let root_rect = Rect::new(0.0, 0.0, thumb_w, thumb_h);
        let frames = GridResolver::new(&spread.layout, &[], mm_to_px)
            .resolve_frames(root_rect);
        serde_json::to_string(&frames).unwrap_or_else(|_| "[]".into())
    }

    /// Drain the dirty-thumbnail set, returning the affected spread *indices*
    /// (ids are mapped to current positions at drain time).
    pub fn get_dirty_spread_indices(&mut self) -> String {
        let drained = std::mem::replace(
            &mut self.dirty_thumbs,
            crate::ThumbsDirty::Ids(std::collections::HashSet::new()),
        );
        let dirty: Vec<usize> = match drained {
            crate::ThumbsDirty::All => (0..self.doc.spreads.len()).collect(),
            crate::ThumbsDirty::Ids(ids) => self.doc.spreads.iter().enumerate()
                .filter(|(_, s)| ids.contains(&s.id))
                .map(|(i, _)| i)
                .collect(),
        };
        serde_json::to_string(&dirty).unwrap_or_else(|_| "[]".into())
    }

    // -----------------------------------------------------------------------
    // Divider drag
    // -----------------------------------------------------------------------

    /// Begin a drag of a divider chain.
    ///
    /// When `full_chain` is true the entire connected chain at the same offset is
    /// moved together. When false only the selected twin pair (two edges) is moved,
    /// which breaks the chain at its endpoints on the first mouse movement.
    pub fn begin_divider_drag(&mut self, edge_id: u32, full_chain: bool, canvas_w: f32, canvas_h: f32) {
        self.save_debug_snapshot();
        let layout = &self.doc.current_spread().layout;
        let Some(axis) = layout.edge_axis(edge_id) else { return };
        let mut chain = if full_chain {
            layout.chain_for_edge(edge_id)
        } else {
            match layout.twin(edge_id) {
                Some(twin_id) => vec![edge_id, twin_id],
                None          => vec![edge_id],
            }
        };
        // With multiple frames selected, restrict the chain to the contiguous
        // sub-chain whose cross-sections touch the selection, terminated at the
        // nearest X-junction beyond the selection boundary.
        if self.selection.len() > 1 {
            let sel: std::collections::HashSet<FaceId> =
                self.selection.iter().copied().collect();
            // Convert the stored mouse position to a normalised perpendicular
            // coordinate so the slot under the pointer is identified correctly,
            // independent of which chain-representative edge_id was passed.
            let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
            let click_perp = match axis {
                crate::layout::SplitAxis::Vertical =>
                    if root_rect.h > 0.0 { (self.mouse_y - root_rect.y) / root_rect.h } else { 0.5 },
                crate::layout::SplitAxis::Horizontal =>
                    if root_rect.w > 0.0 { (self.mouse_x - root_rect.x) / root_rect.w } else { 0.5 },
            };
            chain = layout.chain_for_edge_in_selection(edge_id, &sel, click_perp);
            if chain.is_empty() { return; }
        }
        let initial_offset = chain.first()
            .and_then(|&eid| layout.edges.get(&eid))
            .map(|e| e.offset)
            .unwrap_or(0.5);
        let prop = layout.build_prop_drag(&chain, &self.selection, axis);
        self.drag = Some(DragState { edge_id, axis, chain, initial_offset, prop });
    }

    pub fn update_divider_drag(&mut self, mouse_x: f32, mouse_y: f32, canvas_w: f32, canvas_h: f32, shift: bool) {
        self.mouse_x = mouse_x;
        self.mouse_y = mouse_y;

        let (_edge_id, axis, chain, initial_offset, prop) = match &self.drag {
            Some(d) => (d.edge_id, d.axis, d.chain.clone(), d.initial_offset, d.prop.clone()),
            None => return,
        };

        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let (raw_norm, snap_r) = axis_drag_coord(axis, mouse_x, mouse_y, root_rect);
        let effective_snap_r = if self.snap_disabled { 0.0 } else { snap_r };

        match (shift, prop.as_ref()) {
            (true, Some(p)) => {
                let pos = {
                    let layout = &self.doc.current_spread().layout;
                    snap_and_clamp(layout, axis, raw_norm, &chain, effective_snap_r, p.lo_bound, p.hi_bound, p.pivot)
                };
                let layout = &mut self.doc.current_spread_mut().layout;
                layout.move_chain(&chain, pos);
                p.apply(layout, pos);
            }
            _ => {
                let mm_to_px = self.mm_to_px(canvas_w);
                let total_w_mm = if mm_to_px > 0.0 { root_rect.w / mm_to_px } else { 1.0 };
                let total_h_mm = if mm_to_px > 0.0 { root_rect.h / mm_to_px } else { 1.0 };
                let layout = &self.doc.current_spread().layout;
                if let Some(pos) = apply_drag_snap(layout, axis, raw_norm, &chain, effective_snap_r, total_w_mm, total_h_mm, initial_offset) {
                    let layout = &mut self.doc.current_spread_mut().layout;
                    layout.move_chain(&chain, pos);
                }
            }
        }
        self.mark_structure_dirty();
    }

    pub fn end_divider_drag(&mut self, canvas_w: f32, canvas_h: f32, shift: bool) {
        let mouse_x = self.mouse_x;
        let mouse_y = self.mouse_y;

        if let Some(ref drag) = self.drag {
            let (_edge_id, axis, chain, initial_offset, prop) =
                (drag.edge_id, drag.axis, drag.chain.clone(), drag.initial_offset, drag.prop.clone());

            let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
            let (raw_norm, snap_r) = axis_drag_coord(axis, mouse_x, mouse_y, root_rect);
            let effective_snap_r = if self.snap_disabled { 0.0 } else { snap_r };

            match (shift, prop.as_ref()) {
                (true, Some(p)) => {
                    let pos = {
                        let layout = &self.doc.current_spread().layout;
                        snap_and_clamp(layout, axis, raw_norm, &chain, effective_snap_r, p.lo_bound, p.hi_bound, p.pivot)
                    };
                    let layout = &mut self.doc.current_spread_mut().layout;
                    layout.move_chain(&chain, pos);
                    p.apply(layout, pos);
                }
                _ => {
                    let mm_to_px = self.mm_to_px(canvas_w);
                    let total_w_mm = if mm_to_px > 0.0 { root_rect.w / mm_to_px } else { 1.0 };
                    let total_h_mm = if mm_to_px > 0.0 { root_rect.h / mm_to_px } else { 1.0 };
                    let layout = &self.doc.current_spread().layout;
                    if let Some(pos) = apply_drag_snap(layout, axis, raw_norm, &chain, effective_snap_r, total_w_mm, total_h_mm, initial_offset) {
                        let layout = &mut self.doc.current_spread_mut().layout;
                        layout.move_chain(&chain, pos);
                    }
                }
            }
            self.mark_structure_dirty();
        }

        self.drag = None;
    }

    // -----------------------------------------------------------------------
    // Half-gap on the selected chain (per-side)
    // -----------------------------------------------------------------------

    /// Returns `{a, b, axis}` where `a` = Facing::End side (left/top of the
    /// visual gap) and `b` = Facing::Start side (right/bottom of the gap).
    /// Either value is JSON `null` when the segments in the chain disagree.
    pub fn get_chain_half_gaps(&self, edge_id: u32) -> String {
        let layout = &self.doc.current_spread().layout;
        let chain = layout.chain_for_edge(edge_id);
        if chain.is_empty() {
            return serde_json::json!({"a": 0.0, "b": 0.0, "axis": "v"}).to_string();
        }
        let axis = layout.edges.get(&chain[0])
            .map(|e| e.orientation.clone())
            .unwrap_or(Orientation::Vertical);

        let end_gaps: Vec<f32> = chain.iter()
            .filter_map(|&eid| layout.edges.get(&eid))
            .filter(|e| !e.is_boundary && e.facing == Facing::End)
            .map(|e| e.half_gap)
            .collect();
        let start_gaps: Vec<f32> = chain.iter()
            .filter_map(|&eid| layout.edges.get(&eid))
            .filter(|e| !e.is_boundary && e.facing == Facing::Start)
            .map(|e| e.half_gap)
            .collect();

        let uniform = |gaps: &[f32]| -> Option<f32> {
            if gaps.is_empty() { return Some(0.0); }
            if gaps.iter().all(|&v| (v - gaps[0]).abs() < 1e-4) { Some(gaps[0]) } else { None }
        };

        let a = uniform(&end_gaps);
        let b = uniform(&start_gaps);
        let axis_str = match axis { Orientation::Horizontal => "h", Orientation::Vertical => "v" };
        serde_json::json!({ "a": a, "b": b, "axis": axis_str }).to_string()
    }

    /// Returns `{a, b, axis}` for a specific edge and its twin only — no chain expansion.
    /// Used when a single twin pair is selected via its handle.
    pub fn get_edge_pair_half_gaps(&self, edge_id: u32) -> String {
        let layout = &self.doc.current_spread().layout;
        let Some(e) = layout.edges.get(&edge_id) else {
            return serde_json::json!({"a": 0.0, "b": 0.0, "axis": "v"}).to_string();
        };
        let axis_str = match e.orientation { Orientation::Horizontal => "h", Orientation::Vertical => "v" };
        let (end_gap, start_gap) = if e.facing == Facing::End {
            let start = layout.twin(edge_id)
                .and_then(|tid| layout.edges.get(&tid))
                .map(|t| t.half_gap).unwrap_or(0.0);
            (e.half_gap, start)
        } else {
            let end = layout.twin(edge_id)
                .and_then(|tid| layout.edges.get(&tid))
                .map(|t| t.half_gap).unwrap_or(0.0);
            (end, e.half_gap)
        };
        serde_json::json!({ "a": end_gap, "b": start_gap, "axis": axis_str }).to_string()
    }

    /// Set half_gap on the Facing::End edges of the chain (left/top side of gap).
    pub fn set_chain_half_gap_a(&mut self, edge_id: u32, v: f32) {
        let layout = &self.doc.current_spread().layout;
        let chain = layout.chain_for_edge(edge_id);
        let ids: Vec<EdgeId> = chain.iter().copied()
            .filter(|&eid| layout.edges.get(&eid)
                .map(|e| !e.is_boundary && e.facing == Facing::End).unwrap_or(false))
            .collect();
        let layout = &mut self.doc.current_spread_mut().layout;
        for eid in ids { layout.set_half_gap(eid, v); }
        self.mark_structure_dirty();
    }

    /// Set half_gap on the Facing::Start edges of the chain (right/bottom side of gap).
    pub fn set_chain_half_gap_b(&mut self, edge_id: u32, v: f32) {
        let layout = &self.doc.current_spread().layout;
        let chain = layout.chain_for_edge(edge_id);
        let ids: Vec<EdgeId> = chain.iter().copied()
            .filter(|&eid| layout.edges.get(&eid)
                .map(|e| !e.is_boundary && e.facing == Facing::Start).unwrap_or(false))
            .collect();
        let layout = &mut self.doc.current_spread_mut().layout;
        for eid in ids { layout.set_half_gap(eid, v); }
        self.mark_structure_dirty();
    }

    /// Returns `{gap, side}` for an all-boundary chain.
    /// `side` is one of "top", "bottom", "left", "right".
    pub fn get_boundary_chain_gap(&self, edge_id: u32) -> String {
        let layout = &self.doc.current_spread().layout;
        let chain = layout.chain_for_edge(edge_id);
        let Some(e) = chain.first().and_then(|&eid| layout.edges.get(&eid)) else {
            return serde_json::json!({"gap": 0.0, "side": "top"}).to_string();
        };
        let gap = e.half_gap;
        let side = match e.orientation {
            Orientation::Horizontal => if e.offset < 0.5 { "top" }    else { "bottom" },
            Orientation::Vertical   => if e.offset < 0.5 { "left" }   else { "right" },
        };
        serde_json::json!({"gap": gap, "side": side}).to_string()
    }

    /// Set half_gap on every edge in the all-boundary chain containing `edge_id`.
    pub fn set_boundary_chain_gap(&mut self, edge_id: u32, v: f32) {
        let layout = &self.doc.current_spread().layout;
        let chain = layout.chain_for_edge(edge_id);
        let layout = &mut self.doc.current_spread_mut().layout;
        for eid in chain { layout.set_half_gap(eid, v); }
        self.mark_structure_dirty();
    }

    /// Assign a random symmetric half-gap to every inner chain in the current spread.
    /// `min`/`max` are half-gap values; each chain gets one random value so both
    /// sides of the visual gap are equal.
    #[cfg(target_arch = "wasm32")]
    pub fn randomize_inner_gaps(&mut self, min: f32, max: f32) {
        if self.selection.is_empty() { return; }
        let sel: std::collections::HashSet<FaceId> = self.selection.iter().copied().collect();
        let layout = &self.doc.current_spread().layout;

        let is_selection_inner = |eid: EdgeId| -> bool {
            let Some(e) = layout.edges.get(&eid) else { return false };
            if e.is_boundary || !sel.contains(&e.face_id) { return false }
            let opp = e.facing.opposite();
            let Some((elo, ehi)) = layout.edge_extent(eid) else { return false };
            layout.edges.values().any(|nb| {
                nb.id != eid
                && nb.orientation == e.orientation
                && (nb.offset - e.offset).abs() < crate::grid_layout::EPS
                && nb.facing == opp
                && sel.contains(&nb.face_id)
                && layout.edge_extent(nb.id)
                    .map(|(nlo, nhi)| nlo < ehi - crate::grid_layout::EPS && nhi > elo + crate::grid_layout::EPS)
                    .unwrap_or(false)
            })
        };

        let mut seen = std::collections::HashSet::<EdgeId>::new();
        let candidate_ids: Vec<EdgeId> = layout.edges.keys().copied().collect();
        let mut assignments: Vec<(Vec<EdgeId>, f32)> = Vec::new();
        for eid in candidate_ids {
            if seen.contains(&eid) { continue; }
            if !is_selection_inner(eid) { seen.insert(eid); continue; }
            let chain = layout.chain_for_edge(eid);
            for &id in &chain { seen.insert(id); }
            let v = (min + (max - min) * (js_sys::Math::random() as f32)).max(0.0);
            assignments.push((chain, v));
        }
        let layout = &mut self.doc.current_spread_mut().layout;
        for (chain, v) in assignments {
            for eid in chain {
                if layout.edges.get(&eid).map(|e| sel.contains(&e.face_id)).unwrap_or(false) {
                    layout.set_half_gap(eid, v);
                }
            }
        }
        self.mark_structure_dirty();
    }
}

impl PhotobookEditor {
    pub(crate) fn collect_faces_in_rect(
        &self, rx: f32, ry: f32, rw: f32, rh: f32,
        canvas_w: f32, canvas_h: f32,
    ) -> Vec<FaceId> {
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let bleed_px  = self.doc.bleed_mm * mm_to_px;
        let frames = GridResolver::new(&self.doc.current_spread().layout, &[], mm_to_px)
            .resolve_frames(root_rect);
        let mut ids = Vec::new();
        for frame in &frames {
            let fx = frame.rect.x + bleed_px;
            let fy = frame.rect.y + bleed_px;
            if fx < rx + rw && fx + frame.rect.w > rx && fy < ry + rh && fy + frame.rect.h > ry {
                ids.push(frame.id);
            }
        }
        ids
    }

}
