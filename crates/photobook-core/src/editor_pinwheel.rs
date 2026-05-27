use wasm_bindgen::prelude::*;
use crate::grid_layout::{EdgeId, FaceId, GridLayout, Orientation, EPS, MIN_FRAC};
use crate::page::Spread;
use crate::PhotobookEditor;

// ---------------------------------------------------------------------------
// Drag state
// ---------------------------------------------------------------------------

pub(crate) struct DragPinwheelSpawn {
    pub junction_nx: f32,
    pub junction_ny: f32,
    /// Clamping bounds for the centre panel (normalised).
    pub cx_lo: f32,
    pub cx_hi: f32,
    pub cy_lo: f32,
    pub cy_hi: f32,
    /// Saved layout to restore on each drag update.
    pub saved_layout: GridLayout,
    pub saved_pinwheel_centers: Vec<FaceId>,
}

// ---------------------------------------------------------------------------
// WASM bindings
// ---------------------------------------------------------------------------

#[wasm_bindgen]
impl PhotobookEditor {
    /// Return all X-junctions as a JSON array of
    /// `{nx, ny, tl_id, tr_id, bl_id, br_id}` (normalised spread coords).
    pub fn get_xjunctions(&self) -> String {
        let junctions = self.doc.current_spread().layout.find_xjunctions();
        let arr: Vec<serde_json::Value> = junctions.iter().map(|&(vx, hy, tl, tr, bl, br)| {
            serde_json::json!({
                "nx": vx, "ny": hy,
                "tl_id": tl, "tr_id": tr, "bl_id": bl, "br_id": br,
            })
        }).collect();
        serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into())
    }

    /// Return the pinwheel centre face IDs as a JSON array.
    pub fn get_pinwheel_centers(&self) -> String {
        serde_json::to_string(&self.doc.current_spread().pinwheel_centers)
            .unwrap_or_else(|_| "[]".into())
    }

    /// Prepare for a pinwheel spawn from the given X-junction.
    pub fn begin_pinwheel_spawn(
        &mut self,
        tl_id: u32, tr_id: u32, bl_id: u32, br_id: u32,
        junction_nx: f32, junction_ny: f32,
    ) {
        let layout = &self.doc.current_spread().layout;

        let tl_r = layout.face_rect(tl_id).unwrap_or((0.0, 0.0, junction_nx, junction_ny));
        let tr_r = layout.face_rect(tr_id).unwrap_or((junction_nx, 0.0, 1.0 - junction_nx, junction_ny));
        let bl_r = layout.face_rect(bl_id).unwrap_or((0.0, junction_ny, junction_nx, 1.0 - junction_ny));
        let br_r = layout.face_rect(br_id).unwrap_or((junction_nx, junction_ny, 1.0 - junction_nx, 1.0 - junction_ny));

        let cx_lo = tl_r.0.max(bl_r.0) + MIN_FRAC;
        let cx_hi = (tr_r.0 + tr_r.2).min(br_r.0 + br_r.2) - MIN_FRAC;
        let cy_lo = tl_r.1.max(tr_r.1) + MIN_FRAC;
        let cy_hi = (bl_r.1 + bl_r.3).min(br_r.1 + br_r.3) - MIN_FRAC;

        let saved_layout           = layout.clone();
        let saved_pinwheel_centers = self.doc.current_spread().pinwheel_centers.clone();

        self.save_debug_snapshot();
        self.drag_pinwheel = Some(DragPinwheelSpawn {
            junction_nx, junction_ny,
            cx_lo, cx_hi, cy_lo, cy_hi,
            saved_layout, saved_pinwheel_centers,
        });
    }

    /// Update the live spawn preview with the current mouse position (normalised).
    pub fn update_pinwheel_spawn(&mut self, mouse_nx: f32, mouse_ny: f32) {
        // Extract everything we need from the drag state before releasing its borrow.
        let (jx, jy, cx_lo, cx_hi, cy_lo, cy_hi, saved_layout, saved_centers) = {
            let Some(s) = self.drag_pinwheel.as_ref() else { return };
            (s.junction_nx, s.junction_ny,
             s.cx_lo, s.cx_hi, s.cy_lo, s.cy_hi,
             s.saved_layout.clone(),
             s.saved_pinwheel_centers.clone())
        };

        let dx    = (mouse_nx - jx).abs();
        let dy    = (mouse_ny - jy).abs();
        let cw    = (mouse_nx > jx) == (mouse_ny < jy);

        // Restore to the pre-spawn layout first.
        self.doc.current_spread_mut().layout           = saved_layout;
        self.doc.current_spread_mut().pinwheel_centers = saved_centers;

        // Require a minimum drag before showing anything.
        if dx < MIN_FRAC && dy < MIN_FRAC {
            self.mark_structure_dirty();
            return;
        }

        let cx1 = (jx - dx).clamp(cx_lo, jx - MIN_FRAC);
        let cx2 = (jx + dx).clamp(jx + MIN_FRAC, cx_hi);
        let cy1 = (jy - dy).clamp(cy_lo, jy - MIN_FRAC);
        let cy2 = (jy + dy).clamp(jy + MIN_FRAC, cy_hi);

        if cx2 - cx1 < MIN_FRAC || cy2 - cy1 < MIN_FRAC {
            self.mark_structure_dirty();
            return;
        }

        Self::apply_pinwheel(self.doc.current_spread_mut(), jx, jy, cx1, cx2, cy1, cy2, cw);
        self.mark_structure_dirty();
    }

    /// Confirm the current spawn.
    pub fn end_pinwheel_spawn(&mut self) {
        self.drag_pinwheel = None;
        self.mark_structure_dirty();
    }

    /// Abort the spawn, restoring the original layout.
    pub fn cancel_pinwheel_spawn(&mut self) {
        let (saved_layout, saved_centers) = {
            let Some(s) = self.drag_pinwheel.take() else { return };
            (s.saved_layout, s.saved_pinwheel_centers)
        };
        self.doc.current_spread_mut().layout           = saved_layout;
        self.doc.current_spread_mut().pinwheel_centers = saved_centers;
        self.mark_structure_dirty();
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    /// Split the two chains that cross at (vx, hy) into four half-chains and
    /// reposition them to create space for a center panel at [cx1,cx2]×[cy1,cy2].
    ///
    /// Each half-chain is identified by scanning all edges whose offset matches
    /// the chain (vx or hy) and whose owning face lies entirely on one side of
    /// the junction. This handles T-junctions that terminate on the arm: any
    /// number of collinear edges get repositioned as a unit.
    fn apply_pinwheel(
        spread: &mut Spread,
        vx: f32, hy: f32,
        cx1: f32, cx2: f32, cy1: f32, cy2: f32,
        cw: bool,
    ) {
        let layout = &mut spread.layout;

        // Snapshot (edge_id, face_id, is_vertical, offset) so face_rect can be
        // called without a conflicting borrow on layout.edges.
        let edge_info: Vec<(EdgeId, FaceId, bool, f32)> = layout.edges.values()
            .filter(|e| !e.is_boundary)
            .map(|e| (e.id, e.face_id, matches!(e.orientation, Orientation::Vertical), e.offset))
            .collect();

        let mut v_upper: Vec<EdgeId> = Vec::new(); // vertical chain, faces above hy
        let mut v_lower: Vec<EdgeId> = Vec::new(); // vertical chain, faces below hy
        let mut h_left:  Vec<EdgeId> = Vec::new(); // horizontal chain, faces left of vx
        let mut h_right: Vec<EdgeId> = Vec::new(); // horizontal chain, faces right of vx

        for &(eid, fid, is_v, off) in &edge_info {
            if is_v && (off - vx).abs() < EPS * 10.0 {
                if let Some((_, fy, _, fh)) = layout.face_rect(fid) {
                    if fy + fh <= hy + EPS      { v_upper.push(eid); }
                    else if fy >= hy - EPS      { v_lower.push(eid); }
                }
            } else if !is_v && (off - hy).abs() < EPS * 10.0 {
                if let Some((fx, _, fw, _)) = layout.face_rect(fid) {
                    if fx + fw <= vx + EPS      { h_left.push(eid); }
                    else if fx >= vx - EPS      { h_right.push(eid); }
                }
            }
        }

        // CW:  v_upper→cx1, v_lower→cx2, h_left→cy2, h_right→cy1
        // CCW: v_upper→cx2, v_lower→cx1, h_left→cy1, h_right→cy2
        let (vu_off, vl_off, hl_off, hr_off) = if cw {
            (cx1, cx2, cy2, cy1)
        } else {
            (cx2, cx1, cy1, cy2)
        };

        // Capture chain half-gaps before moving edges.
        let v_gap = v_upper.first().or(v_lower.first())
            .and_then(|eid| layout.edges.get(eid))
            .map_or(0.0, |e| e.half_gap);
        let h_gap = h_left.first().or(h_right.first())
            .and_then(|eid| layout.edges.get(eid))
            .map_or(0.0, |e| e.half_gap);

        for eid in v_upper { if let Some(e) = layout.edges.get_mut(&eid) { e.offset = vu_off; } }
        for eid in v_lower { if let Some(e) = layout.edges.get_mut(&eid) { e.offset = vl_off; } }
        for eid in h_left  { if let Some(e) = layout.edges.get_mut(&eid) { e.offset = hl_off; } }
        for eid in h_right { if let Some(e) = layout.edges.get_mut(&eid) { e.offset = hr_off; } }

        let center_id = layout.add_isolated_face(cx1, cx2, cy1, cy2);

        // Propagate the chain gaps to the new centre face's four edges.
        let center_edges = layout.faces.get(&center_id).map(|f| {
            (f.left_edge_id, f.right_edge_id, f.top_edge_id, f.bottom_edge_id)
        });
        if let Some((l, r, t, b)) = center_edges {
            layout.set_half_gap(l, v_gap);
            layout.set_half_gap(r, v_gap);
            layout.set_half_gap(t, h_gap);
            layout.set_half_gap(b, h_gap);
        }

        spread.pinwheel_centers.push(center_id);
    }
}
