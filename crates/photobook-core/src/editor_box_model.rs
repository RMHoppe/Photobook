use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use crate::layout::{Border, BorderPosition};
use crate::grid_layout::FaceId;
use crate::PhotobookEditor;

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

#[derive(Clone, Serialize, Deserialize)]
struct BoxModelJson {
    #[serde(default)]
    pub border: Border,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face_rotation_deg: Option<f32>,
}

impl Default for BoxModelJson {
    fn default() -> Self {
        BoxModelJson {
            border: Border::default(),
            face_rotation_deg: Some(0.0),
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
            return serde_json::to_string(&BoxModelJson::default()).unwrap_or_default();
        }
        let bms: Vec<BoxModelJson> = self.selection.iter()
            .filter_map(|&id| {
                let face = layout.faces.get(&id)?;
                Some(BoxModelJson {
                    border: face.box_model.border.clone(),
                    face_rotation_deg: face.box_model.face_rotation_deg,
                })
            })
            .collect();
        Self::merge_box_models_json(&bms)
    }

    pub fn get_face_box_model(&self) -> String {
        self.get_box_model()
    }

    pub fn get_transform_box_model(&self) -> String {
        let Some(id) = self.transform_target_node() else {
            return serde_json::to_string(&BoxModelJson::default()).unwrap_or_default();
        };
        let layout = &self.doc.current_spread().layout;
        let bm = layout.faces.get(&id).map(|face| BoxModelJson {
            border: face.box_model.border.clone(),
            face_rotation_deg: face.box_model.face_rotation_deg,
        }).unwrap_or_default();
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
            face.box_model.face_rotation_deg = Some(deg);
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
            let is_outer = |eid: crate::grid_layout::EdgeId| -> bool {
                match layout.twin(eid) {
                    None => true,
                    Some(twin) => layout.edges.get(&twin)
                        .map(|e| !sel.contains(&e.face_id))
                        .unwrap_or(true),
                }
            };
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
                    let is_outer = match layout.twin(eid) {
                        Some(twin) => layout.edges.get(&twin)
                            .map(|e| !sel.contains(&e.face_id))
                            .unwrap_or(true),
                        // No exact-extent twin (e.g. a wide frame above narrower
                        // children). Outer if any collinear opposite-facing neighbor
                        // is non-selected, or if there are no such neighbors at all.
                        None => {
                            let neighbors = collinear_opposite_neighbors(eid);
                            neighbors.is_empty()
                                || neighbors.iter().any(|(_, fid)| !sel.contains(fid))
                        }
                    };
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
            // A touching inner edge is collinear (same orientation + same offset)
            // with the outer edge AND whose parallel span overlaps or shares an
            // endpoint with it.
            //
            // Facing rule (Facing::Start = top/left, Facing::End = bottom/right):
            //   same facing  → same (positive) gap
            //   opposite     → negative gap
            let outer_count = updates.len();
            for i in 0..outer_count {
                let (outer_eid, outer_gap) = updates[i];
                let Some(outer_e)  = layout.edges.get(&outer_eid) else { continue };
                let outer_facing   = outer_e.facing.clone();
                let outer_offset   = outer_e.offset;
                let outer_orient   = outer_e.orientation.clone();
                let Some((outer_lo, outer_hi)) = layout.edge_extent(outer_eid) else { continue };

                for (&inner_eid, inner_e) in &layout.edges {
                    if inner_eid == outer_eid { continue; }
                    if inner_e.orientation != outer_orient { continue; }
                    if (inner_e.offset - outer_offset).abs() >= crate::grid_layout::EPS { continue; }
                    // Own face must be selected; boundary edges are never inner.
                    if !sel.contains(&inner_e.face_id) { continue; }
                    if inner_e.is_boundary { continue; }
                    // Inner check: at least one collinear opposite-facing neighbor
                    // belongs to a selected face.
                    let neighbors = collinear_opposite_neighbors(inner_eid);
                    if !neighbors.iter().any(|(_, fid)| sel.contains(fid)) { continue; }
                    // Ranges must overlap or share an endpoint.
                    let Some((inner_lo, inner_hi)) = layout.edge_extent(inner_eid) else { continue };
                    if inner_lo > outer_hi + crate::grid_layout::EPS { continue; }
                    if inner_hi < outer_lo - crate::grid_layout::EPS { continue; }
                    // Apply facing rule.
                    let gap = if inner_e.facing == outer_facing { outer_gap } else { -outer_gap };
                    updates.push((inner_eid, gap));
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

    /// Returns `{a, b, axis}` for the first selected divider chain.
    /// `a` = Facing::End side (left for vertical, top for horizontal).
    /// `b` = Facing::Start side (right for vertical, bottom for horizontal).
    pub fn get_selected_segment_half_gaps(&self) -> String {
        self.selected_segments.first()
            .map(|&eid| self.get_chain_half_gaps(eid))
            .unwrap_or_else(|| serde_json::json!({"a": 0.0, "b": 0.0, "axis": "v"}).to_string())
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
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    pub(crate) fn apply_box_model_to_node(&mut self, id: FaceId, bm: &BoxModelJson) {
        let layout = &mut self.doc.current_spread_mut().layout;

        // Write border and rotation to face.
        const MIXED_STR: &str = "__mixed__";
        if let Some(face) = layout.faces.get_mut(&id) {
            let r = &mut face.box_model;
            if let Some(v) = bm.border.width_top    { r.border.width_top    = if v >= 0.0 { Some(v) } else { None }; }
            if let Some(v) = bm.border.width_right  { r.border.width_right  = if v >= 0.0 { Some(v) } else { None }; }
            if let Some(v) = bm.border.width_bottom { r.border.width_bottom = if v >= 0.0 { Some(v) } else { None }; }
            if let Some(v) = bm.border.width_left   { r.border.width_left   = if v >= 0.0 { Some(v) } else { None }; }
            let has_per_side = bm.border.width_top.is_some() || bm.border.width_right.is_some()
                || bm.border.width_bottom.is_some() || bm.border.width_left.is_some();
            if !has_per_side && bm.border.width >= 0.0 {
                r.border.width = bm.border.width;
            }
            if bm.border.radius >= 0.0 { r.border.radius = bm.border.radius; }
            if let Some(v) = bm.border.radius_tl { r.border.radius_tl = if v >= 0.0 { Some(v) } else { None }; }
            if let Some(v) = bm.border.radius_tr { r.border.radius_tr = if v >= 0.0 { Some(v) } else { None }; }
            if let Some(v) = bm.border.radius_br { r.border.radius_br = if v >= 0.0 { Some(v) } else { None }; }
            if let Some(v) = bm.border.radius_bl { r.border.radius_bl = if v >= 0.0 { Some(v) } else { None }; }
            if bm.border.color != MIXED_STR {
                r.border.color = bm.border.color.clone();
            }
            if bm.border.position != BorderPosition::Mixed {
                r.border.position = bm.border.position.clone();
            }
            if let Some(deg) = bm.face_rotation_deg {
                r.face_rotation_deg = Some(deg);
            }
        }
    }

    pub(crate) fn merge_box_models_json(bms: &[BoxModelJson]) -> String {
        if bms.is_empty() {
            return serde_json::to_string(&BoxModelJson::default()).unwrap_or_default();
        }
        if bms.len() == 1 {
            let mut bm = bms[0].clone();
            let (t, r, b, l) = bm.border.side_widths();
            bm.border.width_top    = Some(t);
            bm.border.width_right  = Some(r);
            bm.border.width_bottom = Some(b);
            bm.border.width_left   = Some(l);
            let (rtl, rtr, rbr, rbl) = bm.border.corner_radii();
            bm.border.radius_tl = Some(rtl);
            bm.border.radius_tr = Some(rtr);
            bm.border.radius_br = Some(rbr);
            bm.border.radius_bl = Some(rbl);
            return serde_json::to_string(&bm).unwrap_or_default();
        }
        let f = &bms[0];
        let rest = &bms[1..];
        let mfm = |v: Option<f32>, agree: bool| -> Option<f32> { if agree { v } else { None } };
        let ms  = |v: &str, agree: bool| -> String { if agree { v.to_string() } else { "__mixed__".to_string() } };
        let mf  = |v: f32,  agree: bool| -> f32   { if agree { v } else { -1.0 } };
        let (ft, fr, fb, fl) = f.border.side_widths();
        let (frtl, frtr, frbr, frbl) = f.border.corner_radii();
        let merged = BoxModelJson {
            border: Border {
                width: 0.0,
                width_top:    mfm(Some(ft), rest.iter().all(|b| b.border.side_widths().0 == ft)),
                width_right:  mfm(Some(fr), rest.iter().all(|b| b.border.side_widths().1 == fr)),
                width_bottom: mfm(Some(fb), rest.iter().all(|b| b.border.side_widths().2 == fb)),
                width_left:   mfm(Some(fl), rest.iter().all(|b| b.border.side_widths().3 == fl)),
                radius: mf(f.border.radius, rest.iter().all(|b| b.border.radius == f.border.radius)),
                radius_tl: mfm(Some(frtl), rest.iter().all(|b| b.border.corner_radii().0 == frtl)),
                radius_tr: mfm(Some(frtr), rest.iter().all(|b| b.border.corner_radii().1 == frtr)),
                radius_br: mfm(Some(frbr), rest.iter().all(|b| b.border.corner_radii().2 == frbr)),
                radius_bl: mfm(Some(frbl), rest.iter().all(|b| b.border.corner_radii().3 == frbl)),
                color: ms(&f.border.color, rest.iter().all(|b| b.border.color == f.border.color)),
                position: if rest.iter().all(|b| b.border.position == f.border.position) {
                    f.border.position.clone()
                } else {
                    BorderPosition::Mixed
                },
            },
            face_rotation_deg: if rest.iter().all(|b| b.face_rotation_deg == f.face_rotation_deg) {
                f.face_rotation_deg
            } else {
                None
            },
        };
        serde_json::to_string(&merged).unwrap_or_default()
    }
}
