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

/// Snap and clamp a drag position. Nearest candidate within `snap_r` wins.
/// Candidates: spread centre (0.5), drag-range midpoint, other dividers.
/// `layout.snap` returns `raw` unchanged when nothing is nearby, so we only
/// treat it as a candidate when it actually moved.
/// Returns `None` if the drag range is invalid (lo ≥ hi after padding).
fn apply_drag_snap(
    layout: &GridLayout, axis: SplitAxis, raw: f32, chain: &[EdgeId], snap_r: f32,
) -> Option<f32> {
    let (lo, hi) = layout.chain_drag_bounds(chain)?;
    let edge_snap = layout.snap(axis, raw, chain, snap_r);

    let mut snapped = raw;
    let mut best_dist = snap_r;
    for &t in &[0.5_f32, (lo + hi) / 2.0] {
        let d = (t - raw).abs();
        if d < best_dist { best_dist = d; snapped = t; }
    }
    // Only consider edge_snap when it actually found a nearby divider.
    if edge_snap != raw {
        let d = (edge_snap - raw).abs();
        if d < best_dist { snapped = edge_snap; }
    }

    let clo = lo + 1e-4;
    let chi = hi - 1e-4;
    if clo <= chi { Some(snapped.clamp(clo, chi)) } else { None }
}

// ---------------------------------------------------------------------------
// Edge panel drag state
// ---------------------------------------------------------------------------

pub(crate) struct DragEdgePanel {
    pub axis: SplitAxis,
    pub new_is_first: bool,
    pub saved_layout: Box<GridLayout>,
}

fn snap_to_center(raw: f32, snap_r: f32) -> f32 {
    if (0.5 - raw).abs() < snap_r { 0.5 } else { raw }
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
        let divs = GridResolver::new(&spread.layout, &[], mm_to_px)
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
            let resolved = GridResolver::new(&spread.layout, &self.selection, mm_to_px)
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

    // -----------------------------------------------------------------------
    // Edge panel drag
    // -----------------------------------------------------------------------

    pub fn begin_edge_panel_drag(
        &mut self,
        axis: &str,
        new_is_first: bool,
        mouse_x: f32,
        mouse_y: f32,
        canvas_w: f32,
        canvas_h: f32,
    ) -> u32 {
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let axis_enum = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        let (raw, snap_r) = axis_drag_coord(axis_enum, mouse_x, mouse_y, root_rect);
        let effective_snap_r = if self.snap_disabled { 0.0 } else { snap_r };
        let pos = snap_to_center(raw, effective_snap_r).clamp(0.02, 0.98);

        let saved_layout = Box::new(self.doc.current_spread().layout.clone());
        let layout = &mut self.doc.current_spread_mut().layout;
        layout.rescale_interior_edges(axis_enum, pos, new_is_first);
        let chain = layout.split_all(pos, axis_enum, new_is_first);
        if chain.is_empty() {
            *layout = *saved_layout;
            return OUTER_FACE;
        }
        let rep_id = chain[0];

        self.edge_panel_drag = Some(DragEdgePanel { axis: axis_enum, new_is_first, saved_layout });
        self.mark_structure_dirty();
        rep_id
    }

    pub fn update_edge_panel_drag(
        &mut self,
        mouse_x: f32,
        mouse_y: f32,
        canvas_w: f32,
        canvas_h: f32,
    ) {
        let Some(drag) = &self.edge_panel_drag else { return };
        let (axis, new_is_first) = (drag.axis, drag.new_is_first);
        let saved = drag.saved_layout.as_ref().clone();

        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let (raw, snap_r) = axis_drag_coord(axis, mouse_x, mouse_y, root_rect);
        let effective_snap_r = if self.snap_disabled { 0.0 } else { snap_r };
        let pos = snap_to_center(raw, effective_snap_r).clamp(0.02, 0.98);

        let layout = &mut self.doc.current_spread_mut().layout;
        *layout = saved;
        layout.rescale_interior_edges(axis, pos, new_is_first);
        layout.split_all(pos, axis, new_is_first);
        self.mark_structure_dirty();
    }

    pub fn end_edge_panel_drag(&mut self) {
        if let Some(drag) = self.edge_panel_drag.take() {
            self.debug_snapshot = Some(drag.saved_layout);
        }
    }

    pub fn cancel_edge_panel_drag(&mut self) {
        if let Some(drag) = self.edge_panel_drag.take() {
            let layout = &mut self.doc.current_spread_mut().layout;
            *layout = *drag.saved_layout;
            self.mark_structure_dirty();
        }
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
        let _ = (canvas_w, canvas_h);
        self.save_debug_snapshot();
        let layout = &self.doc.current_spread().layout;
        let Some(axis) = layout.edge_axis(edge_id) else { return };
        let chain = if full_chain {
            layout.chain_for_edge(edge_id)
        } else {
            match layout.twin(edge_id) {
                Some(twin_id) => vec![edge_id, twin_id],
                None          => vec![edge_id],
            }
        };
        self.drag = Some(DragState { edge_id, axis, chain });
    }

    pub fn update_divider_drag(&mut self, mouse_x: f32, mouse_y: f32, canvas_w: f32, canvas_h: f32) {
        self.mouse_x = mouse_x;
        self.mouse_y = mouse_y;

        let (_edge_id, axis, chain) = match &self.drag {
            Some(d) => (d.edge_id, d.axis, d.chain.clone()),
            None => return,
        };

        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let (raw_norm, snap_r) = axis_drag_coord(axis, mouse_x, mouse_y, root_rect);
        let effective_snap_r = if self.snap_disabled { 0.0 } else { snap_r };

        let layout = &self.doc.current_spread().layout;
        if let Some(pos) = apply_drag_snap(layout, axis, raw_norm, &chain, effective_snap_r) {
            let layout = &mut self.doc.current_spread_mut().layout;
            layout.move_chain(&chain, pos);
        }
        self.mark_structure_dirty();
    }

    pub fn end_divider_drag(&mut self, canvas_w: f32, canvas_h: f32) {
        let mouse_x = self.mouse_x;
        let mouse_y = self.mouse_y;

        if let Some(ref drag) = self.drag {
            let (_edge_id, axis, chain) = (drag.edge_id, drag.axis, drag.chain.clone());

            let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
            let (raw_norm, snap_r) = axis_drag_coord(axis, mouse_x, mouse_y, root_rect);
            let effective_snap_r = if self.snap_disabled { 0.0 } else { snap_r };

            let layout = &self.doc.current_spread().layout;
            if let Some(pos) = apply_drag_snap(layout, axis, raw_norm, &chain, effective_snap_r) {
                let layout = &mut self.doc.current_spread_mut().layout;
                layout.move_chain(&chain, pos);
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

    pub(crate) fn collect_edges_in_rect(
        &self, rx: f32, ry: f32, rw: f32, rh: f32,
        canvas_w: f32, canvas_h: f32,
    ) -> Vec<u32> {
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let dividers = GridResolver::new(&self.doc.current_spread().layout, &[], mm_to_px)
            .resolve_dividers(root_rect);
        let mut ids = Vec::new();
        for div in &dividers {
            let intersects = match div.axis {
                SplitAxis::Horizontal =>
                    div.y >= ry && div.y <= ry + rh &&
                    div.x <= rx + rw && div.x + div.length >= rx,
                SplitAxis::Vertical =>
                    div.x >= rx && div.x <= rx + rw &&
                    div.y <= ry + rh && div.y + div.length >= ry,
            };
            if intersects { ids.push(div.segment_id); }
        }
        ids
    }
}
