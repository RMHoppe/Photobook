use wasm_bindgen::prelude::*;
use crate::grid_layout::{EdgeId, FaceId, GridLayout, Orientation, Facing, EPS, MIN_FRAC};
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

        // If the junction sits too close to a face boundary there is no valid
        // range for the clamp — bail instead of panicking.
        if cx_lo >= jx - MIN_FRAC || jx + MIN_FRAC >= cx_hi
            || cy_lo >= jy - MIN_FRAC || jy + MIN_FRAC >= cy_hi
        {
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

        // Each new side replaces one particular side at the junction. Copy
        // that side's inset, not an arbitrary edge from the whole axis: opposite
        // sides may have different (even negative) half-gaps after outer margins.
        // Choose the segment nearest the junction to also handle longer chains
        // with T-junctions and different gaps further along the arm.
        let side_gap = |chain: &[EdgeId], facing: Facing, junction: f32| -> f32 {
            chain.iter().filter_map(|eid| {
                let edge = layout.edges.get(eid)?;
                if edge.facing != facing { return None; }
                let (lo, hi) = layout.edge_extent(*eid)?;
                let distance = (lo - junction).abs().min((hi - junction).abs());
                Some((distance, *eid, edge.half_gap))
            }).min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
                .map_or(0.0, |(_, _, gap)| gap)
        };
        let (left_gap, right_gap, top_gap, bottom_gap) = if cw {
            (side_gap(&v_upper, Facing::Start, hy),
             side_gap(&v_lower, Facing::End, hy),
             side_gap(&h_right, Facing::Start, vx),
             side_gap(&h_left, Facing::End, vx))
        } else {
            (side_gap(&v_lower, Facing::Start, hy),
             side_gap(&v_upper, Facing::End, hy),
             side_gap(&h_left, Facing::Start, vx),
             side_gap(&h_right, Facing::End, vx))
        };

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
            layout.set_half_gap(l, left_gap);
            layout.set_half_gap(r, right_gap);
            layout.set_half_gap(t, top_gap);
            layout.set_half_gap(b, bottom_gap);
        }

        spread.pinwheel_centers.push(center_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid_resolver::resolve_frames_mm;
    use crate::layout::Rect;

    fn ring(gap: f32, margins: &str) -> PhotobookEditor {
        let mut ed = PhotobookEditor::new(200.0, 200.0, 0.0);
        ed.doc.current_spread_mut().kind = crate::page::SpreadKind::CoverFront;
        ed.doc.current_spread_mut().layout = GridLayout::new();
        let id = *ed.doc.current_spread().layout.faces.keys().next().unwrap();
        assert!(ed.split_face_into_n(id, "h", 3));
        let rows: Vec<_> = ed.doc.current_spread().layout.faces.keys().copied().collect();
        for id in rows { assert!(ed.split_face_into_n(id, "v", 3)); }
        let layout = &mut ed.doc.current_spread_mut().layout;
        for edge in layout.edges.values_mut().filter(|e| !e.is_boundary) {
            edge.half_gap = gap / 2.0;
        }
        let center = layout.face_at(0.5, 0.5).unwrap();
        ed.select_all();
        ed.toggle_selection(center);
        let offsets = ed.get_inner_edge_offsets();
        let original = ed.get_selection_outer_margins();
        ed.set_selection_outer_margins_and_adjust(margins, &offsets, &original);
        ed
    }

    fn rectangles(ed: &PhotobookEditor) -> std::collections::HashMap<FaceId, Rect> {
        resolve_frames_mm(&ed.doc.current_spread().layout, 200.0, 200.0, 0.0)
            .into_iter().collect()
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.002, "expected {expected}, got {actual}");
    }

    #[test]
    fn pinwheel_after_ring_margins_preserves_each_junction_gap() {
        for gap in [0.0, 4.0] {
            for margins in [r#"{"top":10,"right":10,"bottom":10,"left":10}"#,
                            r#"{"top":3,"right":7,"bottom":11,"left":5}"#] {
                for corner in 0..4 {
                    for cw in [true, false] {
                        let mut ed = ring(gap, margins);
                        let mut junctions = ed.doc.current_spread().layout.find_xjunctions();
                        junctions.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.total_cmp(&b.0)));
                        let (x, y, tl, tr, bl, br) = junctions[corner];
                        let before = rectangles(&ed);
                        let (a, b, c, d) = (before[&tl], before[&tr], before[&bl], before[&br]);
                        // The visible gaps of the four original arms, measured
                        // independently of the half-gap inheritance implementation.
                        let upper = b.x - (a.x + a.w);
                        let lower = d.x - (c.x + c.w);
                        let left = c.y - (a.y + a.h);
                        let right = d.y - (b.y + b.h);
                        ed.begin_pinwheel_spawn(tl, tr, bl, br, x, y);
                        ed.update_pinwheel_spawn(x + 0.075, y + if cw { -0.075 } else { 0.075 });
                        ed.end_pinwheel_spawn();
                        let after = rectangles(&ed);
                        assert_eq!(after.len(), 10);
                        let new = after[&ed.doc.current_spread().pinwheel_centers[0]];
                        let (a, b, c, d) = (after[&tl], after[&tr], after[&bl], after[&br]);
                        let (actual, expected) = if cw {
                            ([new.x - (a.x+a.w), d.x - (new.x+new.w),
                              new.y - (b.y+b.h), c.y - (new.y+new.h)],
                             [upper, lower, right, left])
                        } else {
                            ([new.x - (c.x+c.w), b.x - (new.x+new.w),
                              new.y - (a.y+a.h), d.y - (new.y+new.h)],
                             [lower, upper, left, right])
                        };
                        for (a, e) in actual.into_iter().zip(expected) { assert_close(a, e); }
                        for (&id, a) in &after {
                            assert!(a.w > 0.0 && a.h > 0.0);
                            for (&other, b) in &after {
                                if id >= other { continue; }
                                let overlap_w = ((a.x+a.w).min(b.x+b.w) - a.x.max(b.x)).max(0.0);
                                let overlap_h = ((a.y+a.h).min(b.y+b.h) - a.y.max(b.y)).max(0.0);
                                assert!(overlap_w * overlap_h < 0.01, "panels {id}/{other} overlap");
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn pinwheel_preview_after_margins_is_repeatable_and_cancellable() {
        let mut ed = ring(4.0, r#"{"top":3,"right":7,"bottom":11,"left":5}"#);
        let original: serde_json::Value = serde_json::from_str(&ed.save_state()).unwrap();
        let (x, y, tl, tr, bl, br) = ed.doc.current_spread().layout.find_xjunctions()[0];
        ed.begin_pinwheel_spawn(tl, tr, bl, br, x, y);
        ed.update_pinwheel_spawn(x + 0.075, y - 0.075);
        let direct: serde_json::Value = serde_json::from_str(&ed.save_state()).unwrap();
        ed.update_pinwheel_spawn(x + 0.09, y + 0.09);
        ed.update_pinwheel_spawn(x + 0.075, y - 0.075);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&ed.save_state()).unwrap(), direct);
        ed.cancel_pinwheel_spawn();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&ed.save_state()).unwrap(), original);
    }
}
