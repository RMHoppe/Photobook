use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use crate::layout::BorderPosition;
use crate::grid_layout::{EdgeId, Facing, FaceId, Orientation, EPS};
use crate::PhotobookEditor;

/// A side can border several shorter sides at a T-junction. Exact twins alone
/// cannot distinguish the selection perimeter from a fully shared side.
fn selection_outer_edge(
    layout: &crate::grid_layout::GridLayout,
    selected: &std::collections::HashSet<FaceId>,
    eid: EdgeId,
) -> bool {
    let Some(edge) = layout.edges.get(&eid) else { return false };
    let Some((lo, hi)) = layout.edge_extent(eid) else { return false };
    let mut covered: Vec<_> = layout.edges.values().filter(|other| {
        other.orientation == edge.orientation && other.facing != edge.facing
            && (other.offset - edge.offset).abs() < EPS
            && selected.contains(&other.face_id)
    }).filter_map(|other| layout.edge_extent(other.id))
        .filter(|&(a, b)| a < hi - EPS && b > lo + EPS).collect();
    covered.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut end = lo;
    for (a, b) in covered {
        if a > end + EPS { return true; }
        end = end.max(b);
    }
    end < hi - EPS
}

// ---------------------------------------------------------------------------
// DTO used at the WASM JSON boundary — mirrors the TS BoxModel interface.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct MarginInsets {
    pub top:    Option<f32>,
    pub right:  Option<f32>,
    pub bottom: Option<f32>,
    pub left:   Option<f32>,
}

impl Default for MarginInsets {
    fn default() -> Self {
        MarginInsets { top: Some(0.0), right: Some(0.0), bottom: Some(0.0), left: Some(0.0) }
    }
}

/// Wire DTO for the box-model editor panel. Every field is optional with one
/// uniform meaning: reading, `null` = the multi-selection disagrees ("mixed");
/// writing, `null` = leave the stored value unchanged. The stored model
/// (`layout::Border` / `layout::BoxModel`) never carries these sentinels.
#[derive(Clone, Default, Serialize, Deserialize)]
struct BorderJson {
    #[serde(default)] pub width_top: Option<f32>,
    #[serde(default)] pub width_right: Option<f32>,
    #[serde(default)] pub width_bottom: Option<f32>,
    #[serde(default)] pub width_left: Option<f32>,
    #[serde(default)] pub color: Option<String>,
    #[serde(default)] pub position: Option<BorderPosition>,
    #[serde(default)] pub radius_tl: Option<f32>,
    #[serde(default)] pub radius_tr: Option<f32>,
    #[serde(default)] pub radius_br: Option<f32>,
    #[serde(default)] pub radius_bl: Option<f32>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct BoxModelJson {
    #[serde(default)]
    pub border: BorderJson,
    #[serde(default)]
    pub face_rotation_deg: Option<f32>,
}

impl BoxModelJson {
    fn from_box_model(bm: &crate::layout::BoxModel) -> Self {
        let b = &bm.border;
        BoxModelJson {
            border: BorderJson {
                width_top:    Some(b.width_top),
                width_right:  Some(b.width_right),
                width_bottom: Some(b.width_bottom),
                width_left:   Some(b.width_left),
                color:        Some(b.color.clone()),
                position:     Some(b.position),
                radius_tl:    Some(b.radius_tl),
                radius_tr:    Some(b.radius_tr),
                radius_br:    Some(b.radius_br),
                radius_bl:    Some(b.radius_bl),
            },
            face_rotation_deg: Some(bm.face_rotation_deg),
        }
    }
}

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Box model reads
    // -----------------------------------------------------------------------

    pub fn get_box_model(&self) -> String {
        let layout = &self.doc.current_spread().layout;
        if self.selection.is_empty() {
            return serde_json::to_string(&BoxModelJson::from_box_model(&Default::default()))
                .unwrap_or_default();
        }
        let bms: Vec<BoxModelJson> = self.selection.iter()
            .filter_map(|&id| layout.faces.get(&id))
            .map(|face| BoxModelJson::from_box_model(&face.box_model))
            .collect();
        Self::merge_box_models_json(&bms)
    }

    pub fn get_face_box_model(&self) -> String {
        self.get_box_model()
    }

    pub fn get_transform_box_model(&self) -> String {
        let layout = &self.doc.current_spread().layout;
        let bm = self.transform_target_node()
            .and_then(|id| layout.faces.get(&id))
            .map(|face| BoxModelJson::from_box_model(&face.box_model))
            .unwrap_or_else(|| BoxModelJson::from_box_model(&Default::default()));
        serde_json::to_string(&bm).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Box model writes
    // -----------------------------------------------------------------------

    pub fn set_box_model(&mut self, json: &str) {
        let bm: BoxModelJson = match serde_json::from_str(json) { Ok(v) => v, Err(_) => return };
        if self.selection.is_empty() { return; }
        for id in self.selection.clone() {
            self.apply_box_model_to_node(id, &bm);
        }
        self.mark_structure_dirty();
    }

    pub fn set_node_margin(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let Some(id) = self.transform_target_node() else { return };
        let layout = &self.doc.current_spread().layout;
        let Some(face) = layout.faces.get(&id) else { return };
        let ids = (face.top_edge_id, face.right_edge_id, face.bottom_edge_id, face.left_edge_id);
        let layout = &mut self.doc.current_spread_mut().layout;
        layout.set_half_gap(ids.0, top);
        layout.set_half_gap(ids.1, right);
        layout.set_half_gap(ids.2, bottom);
        layout.set_half_gap(ids.3, left);
        self.mark_structure_dirty();
    }

    pub fn set_face_rotation_deg(&mut self, deg: f32) {
        let Some(id) = self.transform_target_node() else { return };
        if let Some(face) = self.doc.current_spread_mut().layout.faces.get_mut(&id) {
            face.box_model.face_rotation_deg = deg;
        }
        self.mark_structure_dirty();
    }

    pub fn set_face_box_model(&mut self, json: &str) {
        self.save_debug_snapshot();
        self.set_box_model(json);
    }

    // -----------------------------------------------------------------------
    // Outer margin helpers (selection-group perimeter)
    // -----------------------------------------------------------------------

    /// Returns `{top, right, bottom, left}` for the outer edges of the current
    /// frame selection. An edge is "outer" if it borders a non-selected face or
    /// the spread boundary. `null` in any slot means the outer edges on that
    /// axis have mixed values.
    pub fn get_selection_outer_margins(&self) -> String {
        if self.selection.is_empty() {
            return serde_json::to_string(&MarginInsets::default()).unwrap_or_default();
        }
        let layout = &self.doc.current_spread().layout;
        let sel: std::collections::HashSet<crate::grid_layout::FaceId> =
            self.selection.iter().copied().collect();

        let mut tops:    Vec<f32> = Vec::new();
        let mut rights:  Vec<f32> = Vec::new();
        let mut bottoms: Vec<f32> = Vec::new();
        let mut lefts:   Vec<f32> = Vec::new();

        for &face_id in &self.selection {
            let Some(face) = layout.faces.get(&face_id) else { continue };
            let is_outer = |eid| selection_outer_edge(layout, &sel, eid);
            if is_outer(face.top_edge_id) {
                if let Some(v) = layout.get_half_gap(face.top_edge_id) { tops.push(v); }
            }
            if is_outer(face.right_edge_id) {
                if let Some(v) = layout.get_half_gap(face.right_edge_id) { rights.push(v); }
            }
            if is_outer(face.bottom_edge_id) {
                if let Some(v) = layout.get_half_gap(face.bottom_edge_id) { bottoms.push(v); }
            }
            if is_outer(face.left_edge_id) {
                if let Some(v) = layout.get_half_gap(face.left_edge_id) { lefts.push(v); }
            }
        }

        let agree = |vals: &[f32]| -> Option<f32> {
            vals.first().copied().filter(|&first|
                vals.iter().all(|&v| (v - first).abs() < crate::grid_layout::EPS))
        };

        serde_json::to_string(&MarginInsets {
            top:    agree(&tops),
            right:  agree(&rights),
            bottom: agree(&bottoms),
            left:   agree(&lefts),
        }).unwrap_or_default()
    }

    /// Set the half-gap on the outer edges of the current frame selection.
    /// Outer edges are those bordering a non-selected face or the spread boundary.
    /// `null` fields in the JSON are skipped.
    ///
    /// After applying outer-edge margins, a second pass adjusts concave corners:
    /// if a selected frame has a corner where BOTH edges are interior (facing other
    /// selected frames), and those adjacent frames each have an outer edge on the same
    /// side at that vertex, the inner frame shrinks and the outer frames expand so the
    /// gap wraps cleanly around the corner without gaps or overlaps.
    pub fn set_selection_outer_margins(&mut self, json: &str) {
        let insets: MarginInsets = match serde_json::from_str(json) {
            Ok(v) => v, Err(_) => return,
        };
        if self.selection.is_empty() { return; }

        let sel: std::collections::HashSet<crate::grid_layout::FaceId> =
            self.selection.iter().copied().collect();

        let margin_for_dir = |dir: usize| -> Option<f32> {
            match dir { 0 => insets.top, 1 => insets.right, 2 => insets.bottom, 3 => insets.left, _ => None }
        };

        let updates: Vec<(crate::grid_layout::EdgeId, f32)> = {
            let layout = &self.doc.current_spread().layout;
            let mut updates: Vec<(crate::grid_layout::EdgeId, f32)> = Vec::new();

            // Collect all edges that are collinear with `eid` (same orientation +
            // offset), have the opposite Facing, and whose extent strictly overlaps
            // `eid`'s extent (more than a single shared point).
            // Returns (EdgeId, FaceId) pairs for the matching edges.
            let collinear_opposite_neighbors =
                |eid: crate::grid_layout::EdgeId| -> Vec<(crate::grid_layout::EdgeId, crate::grid_layout::FaceId)> {
                    let Some(e) = layout.edges.get(&eid) else { return Vec::new() };
                    let Some((elo, ehi)) = layout.edge_extent(eid) else { return Vec::new() };
                    let opp = e.facing.opposite();
                    layout.edges.values()
                        .filter(|nb| {
                            nb.id != eid
                            && nb.orientation == e.orientation
                            && (nb.offset - e.offset).abs() < crate::grid_layout::EPS
                            && nb.facing == opp
                            && layout.edge_extent(nb.id)
                                .map(|(nlo, nhi)| {
                                    nlo < ehi - crate::grid_layout::EPS
                                    && nhi > elo + crate::grid_layout::EPS
                                })
                                .unwrap_or(false)
                        })
                        .map(|nb| (nb.id, nb.face_id))
                        .collect()
                };

            // ── Phase 1: positive half_gap on every outer edge ───────────────
            for &face_id in &self.selection {
                let Some(face) = layout.faces.get(&face_id) else { continue };
                let face_edges = [
                    (0usize, face.top_edge_id),
                    (1,      face.right_edge_id),
                    (2,      face.bottom_edge_id),
                    (3,      face.left_edge_id),
                ];
                for (dir, eid) in face_edges {
                    let is_outer = selection_outer_edge(layout, &sel, eid);
                    if is_outer {
                        if let Some(v) = margin_for_dir(dir) { updates.push((eid, v)); }
                    }
                }
            }

            // ── Phase 2: propagate each outer half_gap to touching inner edges ─
            // An inner edge is one that lies on an interior divider of the selection:
            // its own face is selected AND at least one collinear opposite-facing
            // neighbor is also selected (handles mismatched extents, e.g. a wide
            // frame [A] above narrower children [B][C] where twin() returns None).
            //
            // Propagation follows chains: if outer → inner_A → inner_B all share
            // the same offset and each consecutive pair overlaps in extent, inner_B
            // is adjusted too. BFS per outer edge; visited set prevents duplicates.
            //
            // Facing rule (Facing::Start = top/left, Facing::End = bottom/right):
            //   same facing as original outer  → same (positive) gap
            //   opposite facing                → existing seam gap minus outer gap
            // Stable precedence when opposite perimeter directions meet the same
            // interior chain (e.g. an S). Never depend on selection/HashMap order.
            updates.sort_by_key(|(eid, _)| {
                let e = &layout.edges[eid];
                (if e.facing == Facing::Start { 0 } else { 1 }, *eid)
            });
            let outer_count = updates.len();
            // Never overwrite a perimeter side through propagation, including
            // an unchanged (null) side that also borders a selected neighbor.
            let mut phase2_visited: std::collections::HashSet<crate::grid_layout::EdgeId> =
                layout.edges.values()
                    .filter(|e| sel.contains(&e.face_id) && selection_outer_edge(layout, &sel, e.id))
                    .map(|e| e.id).collect();

            for i in 0..outer_count {
                let (outer_eid, outer_gap) = updates[i];
                let Some(outer_e)  = layout.edges.get(&outer_eid) else { continue };
                let outer_facing   = outer_e.facing.clone();
                let outer_offset   = outer_e.offset;
                let outer_orient   = outer_e.orientation.clone();

                // BFS queue: (edge_id, lo, hi) of the current frontier node.
                let mut queue: Vec<(crate::grid_layout::EdgeId, f32, f32)> = Vec::new();
                if let Some((lo, hi)) = layout.edge_extent(outer_eid) {
                    queue.push((outer_eid, lo, hi));
                }
                let mut qi = 0;
                while qi < queue.len() {
                    let (_cur_eid, cur_lo, cur_hi) = queue[qi];
                    qi += 1;

                    for (&inner_eid, inner_e) in &layout.edges {
                        if phase2_visited.contains(&inner_eid) { continue; }
                        if inner_e.orientation != outer_orient { continue; }
                        if (inner_e.offset - outer_offset).abs() >= crate::grid_layout::EPS { continue; }
                        // Own face must be selected; boundary edges are never inner.
                        if !sel.contains(&inner_e.face_id) { continue; }
                        if inner_e.is_boundary { continue; }
                        // Inner check: at least one collinear opposite-facing neighbor
                        // belongs to a selected face.
                        let neighbors = collinear_opposite_neighbors(inner_eid);
                        if !neighbors.iter().any(|(_, fid)| sel.contains(fid)) { continue; }
                        // Ranges must overlap or share an endpoint with the current frontier node.
                        let Some((inner_lo, inner_hi)) = layout.edge_extent(inner_eid) else { continue };
                        if inner_lo > cur_hi + crate::grid_layout::EPS { continue; }
                        if inner_hi < cur_lo - crate::grid_layout::EPS { continue; }
                        // Facing rule is always relative to the original outer edge.
                        let gap = if inner_e.facing == outer_facing {
                            outer_gap
                        } else {
                            // Translation moves the two sides of a seam together:
                            // their half-gap sum must remain the original gap.
                            let total = neighbors.iter().filter(|(_, fid)| sel.contains(fid))
                                .min_by_key(|(eid, _)| *eid)
                                .map(|(eid, _)| inner_e.half_gap + layout.edges[eid].half_gap)
                                .unwrap_or(0.0);
                            total - outer_gap
                        };
                        updates.push((inner_eid, gap));
                        phase2_visited.insert(inner_eid);
                        queue.push((inner_eid, inner_lo, inner_hi));
                    }
                }
            }

            updates
        };

        let layout = &mut self.doc.current_spread_mut().layout;
        for (eid, v) in updates {
            layout.set_half_gap(eid, v);
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // Outer-margin layout adjustment
    // -----------------------------------------------------------------------

    /// Returns a JSON object `{id: offset, …}` for every non-boundary edge in
    /// the current spread.  Call this *before* applying outer margins so the
    /// original offsets can be passed back to
    /// `set_selection_outer_margins_and_adjust` on each live update, avoiding
    /// cumulative drift.
    pub fn get_inner_edge_offsets(&self) -> String {
        let layout = &self.doc.current_spread().layout;
        let map: std::collections::HashMap<u32, f32> = layout.edges.values()
            .filter(|e| !e.is_boundary)
            .map(|e| (e.id, e.offset))
            .collect();
        serde_json::to_string(&map).unwrap_or_else(|_| "{}".into())
    }

    /// Apply outer margins, keeping perimeter-connected divider chains aligned
    /// at concave corners. Other internal dividers retain their relative position
    /// within the margin-inset content area.  The mapping is from the *original* content area
    /// (defined by `original_margins_json`, captured before the first drag
    /// update) to the new content area (defined by `margins_json`), so that
    /// inner edges are stationary when the margins haven't actually changed.
    ///
    /// `original_offsets_json` is the verbatim output of `get_inner_edge_offsets`
    /// captured before the first margin was applied for this tool activation.
    /// `original_margins_json` is the verbatim output of `get_selection_outer_margins`
    /// captured at the same moment.
    pub fn set_selection_outer_margins_and_adjust(
        &mut self,
        margins_json: &str,
        original_offsets_json: &str,
        original_margins_json: &str,
    ) {
        let insets: MarginInsets =
            match serde_json::from_str(margins_json) { Ok(v) => v, Err(_) => return };
        let original: std::collections::HashMap<EdgeId, f32> =
            match serde_json::from_str(original_offsets_json) { Ok(v) => v, Err(_) => return };

        // Reconstruct activation geometry before classifying edges. A previous
        // live update may have moved an internal divider away from its baseline.
        let selected: std::collections::HashSet<_> = self.selection.iter().copied().collect();
        let layout = &mut self.doc.current_spread_mut().layout;
        for (&eid, &offset) in &original {
            if let Some(edge) = layout.edges.get_mut(&eid) {
                if selected.contains(&edge.face_id) { edge.offset = offset; }
            }
        }
        let current: MarginInsets = serde_json::from_str(&self.get_selection_outer_margins()).unwrap_or_default();
        self.set_selection_outer_margins(margins_json);
        let orig_insets: MarginInsets =
            serde_json::from_str(original_margins_json).unwrap_or_default();

        let spread_w = self.doc.spread_width_mm(self.doc.current_spread());
        let spread_h = self.doc.page_size.height_mm;
        if spread_w <= 0.0 || spread_h <= 0.0 { return; }

        let left   = insets.left.or(current.left).unwrap_or(0.0).max(0.0);
        let right  = insets.right.or(current.right).unwrap_or(0.0).max(0.0);
        let top    = insets.top.or(current.top).unwrap_or(0.0).max(0.0);
        let bottom = insets.bottom.or(current.bottom).unwrap_or(0.0).max(0.0);

        let orig_left   = orig_insets.left.unwrap_or(0.0).max(0.0);
        let orig_right  = orig_insets.right.unwrap_or(0.0).max(0.0);
        let orig_top    = orig_insets.top.unwrap_or(0.0).max(0.0);
        let orig_bottom = orig_insets.bottom.unwrap_or(0.0).max(0.0);

        let adjustments: Vec<(EdgeId, f32)> = {
            let layout = &self.doc.current_spread().layout;
            let sel: std::collections::HashSet<FaceId> = self.selection.iter().copied().collect();

            // Perimeter-connected collinear chains are already positioned by
            // margin propagation. Rescaling them again breaks concave corners.
            let mut pinned: std::collections::HashSet<EdgeId> = layout.edges.values()
                .filter(|e| sel.contains(&e.face_id) && selection_outer_edge(layout, &sel, e.id))
                .map(|e| e.id).collect();
            let mut queue: Vec<_> = pinned.iter().copied().collect();
            while let Some(eid) = queue.pop() {
                let edge = &layout.edges[&eid];
                let Some((lo, hi)) = layout.edge_extent(eid) else { continue };
                for other in layout.edges.values() {
                    if pinned.contains(&other.id) || !sel.contains(&other.face_id)
                        || other.orientation != edge.orientation
                        || (other.offset - edge.offset).abs() >= EPS { continue; }
                    if layout.edge_extent(other.id).is_some_and(|(a, b)| a <= hi + EPS && b >= lo - EPS) {
                        pinned.insert(other.id);
                        queue.push(other.id);
                    }
                }
            }

            // Bounding box of the selection in normalized [0,1] offset coordinates.
            // Edge offsets are not affected by half_gap mutations, so reading them
            // from the current layout is safe even after set_selection_outer_margins ran.
            let mut bb_left   = f32::INFINITY;
            let mut bb_right  = f32::NEG_INFINITY;
            let mut bb_top    = f32::INFINITY;
            let mut bb_bottom = f32::NEG_INFINITY;
            for &fid in &self.selection {
                let Some(face) = layout.faces.get(&fid) else { continue };
                if let Some(e) = layout.edges.get(&face.left_edge_id)   { bb_left   = bb_left.min(e.offset);   }
                if let Some(e) = layout.edges.get(&face.right_edge_id)  { bb_right  = bb_right.max(e.offset);  }
                if let Some(e) = layout.edges.get(&face.top_edge_id)    { bb_top    = bb_top.min(e.offset);    }
                if let Some(e) = layout.edges.get(&face.bottom_edge_id) { bb_bottom = bb_bottom.max(e.offset); }
            }
            let bb_w = bb_right - bb_left;
            let bb_h = bb_bottom - bb_top;
            if bb_w <= 0.0 || bb_h <= 0.0 { return; }

            // Only shift edges that are strictly interior to the selection (both
            // sides belong to selected faces). Perimeter edges that border
            // non-selected faces define the bounding box and must not be moved.
            let is_selection_inner = |eid: EdgeId| -> bool {
                let Some(e) = layout.edges.get(&eid) else { return false };
                if e.is_boundary || !sel.contains(&e.face_id) { return false }
                let opp = e.facing.opposite();
                let Some((elo, ehi)) = layout.edge_extent(eid) else { return false };
                layout.edges.values().any(|nb| {
                    nb.id != eid
                    && nb.orientation == e.orientation
                    && (nb.offset - e.offset).abs() < EPS
                    && nb.facing == opp
                    && sel.contains(&nb.face_id)
                    && layout.edge_extent(nb.id)
                        .map(|(nlo, nhi)| nlo < ehi - EPS && nhi > elo + EPS)
                        .unwrap_or(false)
                })
            };

            original.iter().filter_map(|(&eid, &orig)| {
                if pinned.contains(&eid) || !is_selection_inner(eid) { return None; }
                let edge = layout.edges.get(&eid)?;
                let new_offset = match edge.orientation {
                    Orientation::Vertical => {
                        let prev_left_frac  = orig_left  / spread_w;
                        let prev_right_frac = orig_right / spread_w;
                        let left_frac       = left  / spread_w;
                        let right_frac      = right / spread_w;
                        let prev_content_w  = (bb_w - prev_left_frac - prev_right_frac).max(EPS);
                        let rel = ((orig - (bb_left + prev_left_frac)) / prev_content_w).clamp(0.0, 1.0);
                        bb_left + left_frac + rel * (bb_w - left_frac - right_frac).max(0.0)
                    }
                    Orientation::Horizontal => {
                        let prev_top_frac    = orig_top    / spread_h;
                        let prev_bottom_frac = orig_bottom / spread_h;
                        let top_frac         = top    / spread_h;
                        let bottom_frac      = bottom / spread_h;
                        let prev_content_h   = (bb_h - prev_top_frac - prev_bottom_frac).max(EPS);
                        let rel = ((orig - (bb_top + prev_top_frac)) / prev_content_h).clamp(0.0, 1.0);
                        bb_top + top_frac + rel * (bb_h - top_frac - bottom_frac).max(0.0)
                    }
                };
                Some((eid, new_offset.clamp(0.0, 1.0)))
            }).collect()
        };

        let layout = &mut self.doc.current_spread_mut().layout;
        for (eid, new_offset) in adjustments {
            if let Some(e) = layout.edges.get_mut(&eid) { e.offset = new_offset; }
        }
        // mark_structure_dirty already called by set_selection_outer_margins above.
    }

    // -----------------------------------------------------------------------
    // Inner gaps (gaps between selected frames)
    // -----------------------------------------------------------------------

    /// Returns `{h, v}` — current half_gap on the inner edges of the selection.
    /// `h` = half_gap on Vertical inner edges (gap between side-by-side frames).
    /// `v` = half_gap on Horizontal inner edges (gap between stacked frames).
    /// `null` means no inner edges of that orientation exist, or values are mixed.
    pub fn get_selection_inner_gaps(&self) -> String {
        if self.selection.is_empty() {
            return serde_json::json!({"h": null, "v": null}).to_string();
        }
        let sel: std::collections::HashSet<crate::grid_layout::FaceId> =
            self.selection.iter().copied().collect();
        let layout = &self.doc.current_spread().layout;

        let is_inner = |eid: crate::grid_layout::EdgeId| -> bool {
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

        let mut h_gaps: Vec<f32> = Vec::new();
        let mut v_gaps: Vec<f32> = Vec::new();
        for &face_id in &self.selection {
            let Some(face) = layout.faces.get(&face_id) else { continue };
            for eid in [face.top_edge_id, face.bottom_edge_id, face.left_edge_id, face.right_edge_id] {
                if !is_inner(eid) { continue }
                let Some(e) = layout.edges.get(&eid) else { continue };
                // Dialog shows the total visual gap (both sides combined), so multiply by 2.
                match e.orientation {
                    crate::grid_layout::Orientation::Horizontal => v_gaps.push(e.half_gap * 2.0),
                    crate::grid_layout::Orientation::Vertical   => h_gaps.push(e.half_gap * 2.0),
                }
            }
        }

        let agree = |vals: &[f32]| -> Option<f32> {
            vals.first().copied().filter(|&first|
                vals.iter().all(|&v| (v - first).abs() < crate::grid_layout::EPS))
        };

        serde_json::json!({
            "h": agree(&h_gaps),
            "v": agree(&v_gaps),
        }).to_string()
    }

    /// Set half_gap on all inner edges of the current selection.
    /// `json` = `{h?: number|null, v?: number|null}`.
    /// `h` applies to Vertical inner edges; `v` applies to Horizontal inner edges.
    /// `null` fields are skipped.
    pub fn set_selection_inner_gaps(&mut self, json: &str) {
        #[derive(Deserialize)]
        struct InnerGapsInput { h: Option<f32>, v: Option<f32> }
        let gaps: InnerGapsInput = match serde_json::from_str(json) {
            Ok(v) => v, Err(_) => return,
        };
        if gaps.h.is_none() && gaps.v.is_none() { return; }
        if self.selection.is_empty() { return; }

        let sel: std::collections::HashSet<crate::grid_layout::FaceId> =
            self.selection.iter().copied().collect();

        let updates: Vec<(crate::grid_layout::EdgeId, f32)> = {
            let layout = &self.doc.current_spread().layout;

            let is_inner = |eid: crate::grid_layout::EdgeId| -> bool {
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

            let mut updates = Vec::new();
            for &face_id in &self.selection {
                let Some(face) = layout.faces.get(&face_id) else { continue };
                for eid in [face.top_edge_id, face.bottom_edge_id, face.left_edge_id, face.right_edge_id] {
                    if !is_inner(eid) { continue }
                    let Some(e) = layout.edges.get(&eid) else { continue };
                    // Dialog value is the total visual gap; each side gets half.
                    let gap = match e.orientation {
                        crate::grid_layout::Orientation::Horizontal => gaps.v,
                        crate::grid_layout::Orientation::Vertical   => gaps.h,
                    };
                    if let Some(g) = gap { updates.push((eid, g / 2.0)); }
                }
            }
            updates
        };

        let layout = &mut self.doc.current_spread_mut().layout;
        for (eid, g) in updates {
            layout.set_half_gap(eid, g);
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // Transformation presence check
    // -----------------------------------------------------------------------

    /// Returns true if any selected frame has a non-zero half_gap on any of
    /// its four edges, or a non-zero face rotation.
    pub fn selection_has_transformations(&self) -> bool {
        if self.selection.is_empty() { return false; }
        let layout = &self.doc.current_spread().layout;
        for &fid in &self.selection {
            let Some(face) = layout.faces.get(&fid) else { continue };
            if face.box_model.face_rotation_deg.abs() > EPS { return true; }
            for eid in [face.top_edge_id, face.right_edge_id, face.bottom_edge_id, face.left_edge_id] {
                if let Some(e) = layout.edges.get(&eid) {
                    if e.half_gap.abs() > EPS { return true; }
                }
            }
        }
        false
    }

    // -----------------------------------------------------------------------
    // Clear all gaps in selection
    // -----------------------------------------------------------------------

    /// Zero out the half_gap on every edge belonging to a selected face.
    pub fn clear_selection_gaps(&mut self) {
        if self.selection.is_empty() { return; }
        let edge_ids: Vec<crate::grid_layout::EdgeId> = {
            let layout = &self.doc.current_spread().layout;
            self.selection.iter()
                .filter_map(|&fid| layout.faces.get(&fid))
                .flat_map(|f| [f.top_edge_id, f.bottom_edge_id, f.left_edge_id, f.right_edge_id])
                .collect()
        };
        let layout = &mut self.doc.current_spread_mut().layout;
        for eid in edge_ids {
            layout.set_half_gap(eid, 0.0);
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // Divider half-gaps (per-side)
    // -----------------------------------------------------------------------

    /// Returns `{ h: {a,b}|null, v: {a,b}|null }` aggregated across all selected segments.
    /// Each axis key is `null` when no selected segment has that orientation.
    /// `a`/`b` inside an axis block are `null` when values disagree across segments.
    pub fn get_selected_segment_half_gaps(&self) -> String {
        fn merge(acc: Option<f32>, new: Option<f32>, seen: bool) -> Option<f32> {
            if !seen { return new; }
            match (acc, new) {
                (Some(a), Some(b)) if (a - b).abs() < 1e-4 => Some(a),
                _ => None,
            }
        }
        let layout = &self.doc.current_spread().layout;
        let (mut h_a, mut h_b, mut h_seen) = (None::<f32>, None::<f32>, false);
        let (mut v_a, mut v_b, mut v_seen) = (None::<f32>, None::<f32>, false);

        for &eid in &self.selected_segments {
            let Some(edge) = layout.edges.get(&eid) else { continue };
            if edge.is_boundary { continue; }
            let chain = layout.chain_for_edge(eid);
            let uniform = |it: Vec<f32>| -> Option<f32> {
                if it.is_empty() { return Some(0.0); }
                if it.iter().all(|&v| (v - it[0]).abs() < 1e-4) { Some(it[0]) } else { None }
            };
            let end_vals: Vec<f32> = chain.iter()
                .filter_map(|&id| layout.edges.get(&id))
                .filter(|e| !e.is_boundary && e.facing == Facing::End)
                .map(|e| e.half_gap).collect();
            let start_vals: Vec<f32> = chain.iter()
                .filter_map(|&id| layout.edges.get(&id))
                .filter(|e| !e.is_boundary && e.facing == Facing::Start)
                .map(|e| e.half_gap).collect();
            let seg_a = uniform(end_vals);
            let seg_b = uniform(start_vals);
            match edge.orientation {
                Orientation::Horizontal => {
                    h_a = merge(h_a, seg_a, h_seen);
                    h_b = merge(h_b, seg_b, h_seen);
                    h_seen = true;
                }
                Orientation::Vertical => {
                    v_a = merge(v_a, seg_a, v_seen);
                    v_b = merge(v_b, seg_b, v_seen);
                    v_seen = true;
                }
            }
        }
        let h = if h_seen { serde_json::json!({"a": h_a, "b": h_b}) } else { serde_json::Value::Null };
        let v = if v_seen { serde_json::json!({"a": v_a, "b": v_b}) } else { serde_json::Value::Null };
        serde_json::json!({ "h": h, "v": v }).to_string()
    }

    /// Set half_gap on the Facing::End (left/top) side of all selected chains.
    pub fn set_selected_segment_half_gap_a(&mut self, v: f32) {
        for eid in self.selected_segments.clone() {
            self.set_chain_half_gap_a(eid, v);
        }
    }

    /// Set half_gap on the Facing::Start (right/bottom) side of all selected chains.
    pub fn set_selected_segment_half_gap_b(&mut self, v: f32) {
        for eid in self.selected_segments.clone() {
            self.set_chain_half_gap_b(eid, v);
        }
    }

    /// Set half_gap on the Facing::End side of selected chains with the given orientation ("h"/"v").
    pub fn set_selected_segment_half_gap_a_axis(&mut self, axis: &str, v: f32) {
        let target = if axis == "h" { Orientation::Horizontal } else { Orientation::Vertical };
        let eids: Vec<u32> = self.selected_segments.iter().copied()
            .filter(|&eid| self.doc.current_spread().layout.edges.get(&eid)
                .map(|e| e.orientation == target && !e.is_boundary).unwrap_or(false))
            .collect();
        for eid in eids { self.set_chain_half_gap_a(eid, v); }
    }

    /// Set half_gap on the Facing::Start side of selected chains with the given orientation ("h"/"v").
    pub fn set_selected_segment_half_gap_b_axis(&mut self, axis: &str, v: f32) {
        let target = if axis == "h" { Orientation::Horizontal } else { Orientation::Vertical };
        let eids: Vec<u32> = self.selected_segments.iter().copied()
            .filter(|&eid| self.doc.current_spread().layout.edges.get(&eid)
                .map(|e| e.orientation == target && !e.is_boundary).unwrap_or(false))
            .collect();
        for eid in eids { self.set_chain_half_gap_b(eid, v); }
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    fn apply_box_model_to_node(&mut self, id: FaceId, bm: &BoxModelJson) {
        let layout = &mut self.doc.current_spread_mut().layout;
        let Some(face) = layout.faces.get_mut(&id) else { return };
        let r = &mut face.box_model;
        if let Some(v) = bm.border.width_top    { r.border.width_top    = v.max(0.0); }
        if let Some(v) = bm.border.width_right  { r.border.width_right  = v.max(0.0); }
        if let Some(v) = bm.border.width_bottom { r.border.width_bottom = v.max(0.0); }
        if let Some(v) = bm.border.width_left   { r.border.width_left   = v.max(0.0); }
        if let Some(v) = bm.border.radius_tl { r.border.radius_tl = v.max(0.0); }
        if let Some(v) = bm.border.radius_tr { r.border.radius_tr = v.max(0.0); }
        if let Some(v) = bm.border.radius_br { r.border.radius_br = v.max(0.0); }
        if let Some(v) = bm.border.radius_bl { r.border.radius_bl = v.max(0.0); }
        if let Some(ref c) = bm.border.color { r.border.color = c.clone(); }
        if let Some(p) = bm.border.position { r.border.position = p; }
        if let Some(deg) = bm.face_rotation_deg { r.face_rotation_deg = deg; }
    }

    /// Merge per-face DTOs into the selection aggregate: each field stays
    /// concrete when every face agrees and becomes `null` ("mixed") otherwise.
    fn merge_box_models_json(bms: &[BoxModelJson]) -> String {
        fn agree<T: PartialEq + Clone>(
            bms: &[BoxModelJson],
            get: impl Fn(&BoxModelJson) -> Option<T>,
        ) -> Option<T> {
            let first = get(&bms[0])?;
            bms[1..].iter()
                .all(|b| get(b).as_ref() == Some(&first))
                .then_some(first)
        }

        if bms.is_empty() {
            return serde_json::to_string(&BoxModelJson::from_box_model(&Default::default()))
                .unwrap_or_default();
        }
        let merged = BoxModelJson {
            border: BorderJson {
                width_top:    agree(bms, |b| b.border.width_top),
                width_right:  agree(bms, |b| b.border.width_right),
                width_bottom: agree(bms, |b| b.border.width_bottom),
                width_left:   agree(bms, |b| b.border.width_left),
                color:        agree(bms, |b| b.border.color.clone()),
                position:     agree(bms, |b| b.border.position),
                radius_tl:    agree(bms, |b| b.border.radius_tl),
                radius_tr:    agree(bms, |b| b.border.radius_tr),
                radius_br:    agree(bms, |b| b.border.radius_br),
                radius_bl:    agree(bms, |b| b.border.radius_bl),
            },
            face_rotation_deg: agree(bms, |b| b.face_rotation_deg),
        };
        serde_json::to_string(&merged).unwrap_or_default()
    }
}
