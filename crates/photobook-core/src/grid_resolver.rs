//! Canvas render pipeline backed by `GridLayout`.

use crate::layout::{
    EdgeInsets, Rect, ResolvedDivider, ResolvedFrame,
    ResolvedSpread, ResolvedTwinHandle, SplitAxis,
};
use crate::grid_layout::{EdgeId, Facing, FaceId, GridFace, GridLayout, Orientation};

// ---------------------------------------------------------------------------
// GridResolver
// ---------------------------------------------------------------------------

pub struct GridResolver<'a> {
    layout:    &'a GridLayout,
    selection: std::collections::HashSet<FaceId>,
    mm_to_px:  f32,
}

impl<'a> GridResolver<'a> {
    pub fn new(layout: &'a GridLayout, selection: &[FaceId], mm_to_px: f32) -> Self {
        GridResolver {
            layout,
            selection: selection.iter().copied().collect(),
            mm_to_px,
        }
    }

    // -----------------------------------------------------------------------
    // Combined resolver
    // -----------------------------------------------------------------------

    pub fn resolve_all(&self, root_rect: Rect) -> ResolvedSpread {
        ResolvedSpread {
            frames:       self.resolve_frames(root_rect),
            dividers:     self.resolve_dividers(root_rect),
            twin_handles: self.resolve_twin_handles(root_rect),
        }
    }

    // -----------------------------------------------------------------------
    // Frames
    // -----------------------------------------------------------------------

    pub fn resolve_frames(&self, root_rect: Rect) -> Vec<ResolvedFrame> {
        let mut frames: Vec<(i32, FaceId, ResolvedFrame)> = self.layout.faces.values()
            .filter_map(|face| {
                let frame = self.resolve_one_frame(face, root_rect)?;
                Some((face.z_index, face.id, frame))
            })
            .collect();

        frames.sort_by_key(|(z, id, _)| (*z, *id));
        frames.into_iter().map(|(_, _, f)| f).collect()
    }

    /// Resolve only the frames for the given face ids — the incremental render
    /// path. O(k) in the number of dirty faces rather than O(n) over the whole
    /// layout. Order is irrelevant: the TS geometry cache updates frames in
    /// place by id, so no z-sort is needed here.
    pub fn resolve_frames_for(
        &self,
        root_rect: Rect,
        ids: &std::collections::HashSet<FaceId>,
    ) -> Vec<ResolvedFrame> {
        ids.iter()
            .filter_map(|id| {
                let face = self.layout.faces.get(id)?;
                self.resolve_one_frame(face, root_rect)
            })
            .collect()
    }

    /// Resolve a single face into a `ResolvedFrame`. Each face is independent —
    /// its rect, gap inset, and box model don't depend on sibling *frames* — so
    /// this is safe to call for an arbitrary subset.
    fn resolve_one_frame(&self, face: &GridFace, root_rect: Rect) -> Option<ResolvedFrame> {
        let layout   = self.layout;
        let mm_to_px = self.mm_to_px;
        let (fx, fy, fw, fh) = layout.face_rect(face.id)?;
        let raw   = norm_to_px(fx, fy, fw, fh, root_rect);
        let gi    = self.gap_inset_px(face.id);
        let inner = raw.inset(&gi);
        let (bwt, bwr, bwb, bwl) = face.box_model.border.side_widths();
        let (crtl, crtr, crbr, crbl) = face.box_model.border.corner_radii();
        Some(ResolvedFrame {
            id:               face.id,
            rect:             inner,
            face_rect:        raw,
            image_id:         face.image.image_id.clone(),
            object_fit:       face.image.object_fit.clone(),
            pan_x:            face.image.pan_x,
            pan_y:            face.image.pan_y,
            scale:            face.image.scale,
            rotation_deg:     face.image.rotation_deg,
            flip_h:           face.image.flip_h,
            flip_v:           face.image.flip_v,
            is_selected:      self.selection.contains(&face.id),
            border_width_top:    bwt * mm_to_px,
            border_width_right:  bwr * mm_to_px,
            border_width_bottom: bwb * mm_to_px,
            border_width_left:   bwl * mm_to_px,
            border_color:     face.box_model.border.color.clone(),
            border_position:  face.box_model.border.position.clone(),
            border_radius:    crtl * mm_to_px,
            border_radius_tr: crtr * mm_to_px,
            border_radius_br: crbr * mm_to_px,
            border_radius_bl: crbl * mm_to_px,
            face_rotation_deg: face.box_model.face_rotation_deg.unwrap_or(0.0),
        })
    }

    // -----------------------------------------------------------------------
    // Chain iteration helper
    // -----------------------------------------------------------------------

    /// Calls `f(is_horizontal, chain_edge_ids)` once per connected chain of edges,
    /// processing horizontal chains before vertical, each chain visited only once.
    fn for_each_chain<F>(&self, mut f: F)
    where F: FnMut(bool, &[EdgeId]) {
        let layout = self.layout;
        let mut visited: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        for target_orientation in [Orientation::Horizontal, Orientation::Vertical] {
            let is_h = target_orientation == Orientation::Horizontal;
            let mut ids: Vec<EdgeId> = layout.edges.values()
                .filter(|e| e.orientation == target_orientation)
                .map(|e| e.id)
                .collect();
            ids.sort_unstable();
            for eid in ids {
                if visited.contains(&eid) { continue; }
                let chain = layout.chain_for_edge(eid);
                for &e in &chain { visited.insert(e); }
                f(is_h, &chain);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Dividers — one per chain
    // -----------------------------------------------------------------------

    pub fn resolve_dividers(&self, root_rect: Rect) -> Vec<ResolvedDivider> {
        let layout = self.layout;
        let (sw, sh) = (root_rect.w, root_rect.h);
        let (ox, oy) = (root_rect.x, root_rect.y);
        let mut dividers = Vec::new();

        self.for_each_chain(|is_h, chain| {
            let has_interior = chain.iter().any(|&e| !layout.is_boundary_edge(e));
            if !has_interior { return; }

            let mut span_lo = f32::INFINITY;
            let mut span_hi = f32::NEG_INFINITY;
            let mut offset  = 0.0_f32;
            let mut max_gap = 0.0_f32;
            let mut rep     = chain[0];

            for &e_id in chain {
                if let Some(e) = layout.edges.get(&e_id) {
                    offset = e.offset;
                    if let Some((lo, hi)) = layout.edge_extent(e_id) {
                        span_lo = span_lo.min(lo);
                        span_hi = span_hi.max(hi);
                    }
                    if !e.is_boundary && e.half_gap > max_gap {
                        max_gap = e.half_gap;
                        rep = e_id;
                    }
                }
            }

            let gap_px = max_gap * self.mm_to_px;
            if is_h {
                dividers.push(ResolvedDivider {
                    segment_id: rep,
                    x:        ox + span_lo * sw,
                    y:        oy + offset  * sh,
                    length:   (span_hi - span_lo) * sw,
                    axis:     SplitAxis::Horizontal,
                    half_gap: gap_px,
                });
            } else {
                dividers.push(ResolvedDivider {
                    segment_id: rep,
                    x:        ox + offset  * sw,
                    y:        oy + span_lo * sh,
                    length:   (span_hi - span_lo) * sh,
                    axis:     SplitAxis::Vertical,
                    half_gap: gap_px,
                });
            }
        });

        dividers
    }

    // -----------------------------------------------------------------------
    // Dividers for hit-testing — one entry per interior twin pair so each
    // segment uses its own half_gap rather than the chain-wide maximum.
    // `segment_id` on every entry still points to the chain representative.
    // -----------------------------------------------------------------------

    pub fn resolve_divider_hits(&self, root_rect: Rect) -> Vec<ResolvedDivider> {
        let layout = self.layout;
        let (sw, sh) = (root_rect.w, root_rect.h);
        let (ox, oy) = (root_rect.x, root_rect.y);
        let mut hits = Vec::new();

        self.for_each_chain(|is_h, chain| {
            if !chain.iter().any(|&eid| !layout.is_boundary_edge(eid)) { return; }

            // Chain rep: same rule as resolve_dividers (edge with max half_gap).
            let mut max_gap = 0.0_f32;
            let mut rep = chain[0];
            for &eid in chain {
                if let Some(e) = layout.edges.get(&eid) {
                    if !e.is_boundary && e.half_gap > max_gap {
                        max_gap = e.half_gap;
                        rep = eid;
                    }
                }
            }

            // One hit zone per interior twin pair (process only Facing::End to
            // visit each pair exactly once; use max of both sides for the radius).
            for &e_id in chain {
                let e = match layout.edges.get(&e_id) {
                    Some(e) if !e.is_boundary && e.facing == Facing::End => e,
                    _ => continue,
                };
                let Some((lo, hi)) = layout.edge_extent(e_id) else { continue };
                let twin_gap = layout.twin(e_id)
                    .and_then(|tid| layout.edges.get(&tid))
                    .map(|t| t.half_gap)
                    .unwrap_or(0.0);
                let seg_gap_px = e.half_gap.max(twin_gap) * self.mm_to_px;

                if is_h {
                    hits.push(ResolvedDivider {
                        segment_id: rep,
                        x:        ox + lo      * sw,
                        y:        oy + e.offset * sh,
                        length:   (hi - lo)    * sw,
                        axis:     SplitAxis::Horizontal,
                        half_gap: seg_gap_px,
                    });
                } else {
                    hits.push(ResolvedDivider {
                        segment_id: rep,
                        x:        ox + e.offset * sw,
                        y:        oy + lo       * sh,
                        length:   (hi - lo)     * sh,
                        axis:     SplitAxis::Vertical,
                        half_gap: seg_gap_px,
                    });
                }
            }
        });

        hits
    }

    // -----------------------------------------------------------------------
    // Twin handles — emitted for chains with > 1 twin pair (for multi-segment
    // chains the TS can show a handle to select / delete individual segments)
    // -----------------------------------------------------------------------

    pub fn resolve_twin_handles(&self, root_rect: Rect) -> Vec<ResolvedTwinHandle> {
        let layout = self.layout;
        let (sw, sh) = (root_rect.w, root_rect.h);
        let (ox, oy) = (root_rect.x, root_rect.y);
        let mut handles = Vec::new();

        self.for_each_chain(|is_h, chain| {
            let interior: Vec<EdgeId> = chain.iter().copied()
                .filter(|&e| !layout.is_boundary_edge(e) && layout.twin(e).is_some())
                .collect();
            if interior.len() / 2 <= 1 { return; }

            for e_id in interior {
                if let Some(e) = layout.edges.get(&e_id) {
                    let (lo, hi) = layout.edge_extent(e_id).unwrap_or((0.0, 0.0));
                    let mid = (lo + hi) / 2.0;
                    if is_h {
                        handles.push(ResolvedTwinHandle {
                            edge_id: e_id,
                            x:      ox + mid      * sw,
                            y:      oy + e.offset * sh,
                            length: (hi - lo)     * sw,
                            axis:   SplitAxis::Horizontal,
                        });
                    } else {
                        handles.push(ResolvedTwinHandle {
                            edge_id: e_id,
                            x:      ox + e.offset * sw,
                            y:      oy + mid      * sh,
                            length: (hi - lo)     * sh,
                            axis:   SplitAxis::Vertical,
                        });
                    }
                }
            }
        });

        handles
    }

    // -----------------------------------------------------------------------
    // Gap inset in canvas px for a face
    // -----------------------------------------------------------------------

    fn gap_inset_px(&self, face_id: FaceId) -> EdgeInsets {
        let layout = self.layout;
        let mm_px  = self.mm_to_px;
        let face   = match layout.faces.get(&face_id) { Some(f) => f, None => return EdgeInsets::default() };

        let top    = layout.edges.get(&face.top_edge_id)   .map(|e| e.half_gap * mm_px).unwrap_or(0.0);
        let bottom = layout.edges.get(&face.bottom_edge_id).map(|e| e.half_gap * mm_px).unwrap_or(0.0);
        let left   = layout.edges.get(&face.left_edge_id)  .map(|e| e.half_gap * mm_px).unwrap_or(0.0);
        let right  = layout.edges.get(&face.right_edge_id) .map(|e| e.half_gap * mm_px).unwrap_or(0.0);

        EdgeInsets { top, bottom, left, right }
    }
}

// ---------------------------------------------------------------------------
// Coordinate utility
// ---------------------------------------------------------------------------

fn norm_to_px(nx: f32, ny: f32, nw: f32, nh: f32, root: Rect) -> Rect {
    Rect::new(root.x + nx * root.w, root.y + ny * root.h, nw * root.w, nh * root.h)
}

// ---------------------------------------------------------------------------
// PDF helpers (mm-coordinate variants)
// ---------------------------------------------------------------------------

pub fn resolve_frames_mm(
    layout: &GridLayout,
    spread_w_mm: f32,
    spread_h_mm: f32,
    bleed_mm: f32,
) -> Vec<(FaceId, Rect)> {
    let root = Rect::new(
        -bleed_mm,
        -bleed_mm,
        spread_w_mm + 2.0 * bleed_mm,
        spread_h_mm + 2.0 * bleed_mm,
    );
    GridResolver::new(layout, &[], 1.0)
        .resolve_frames(root)
        .into_iter()
        .map(|f| (f.id, f.rect))
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "wasm-test"))]
pub(crate) mod test_impls {
    use super::*;
    use crate::grid_layout::GridLayout;

    fn root() -> Rect { Rect::new(0.0, 0.0, 1000.0, 500.0) }

    pub fn single_room_produces_one_frame() {
        let layout = GridLayout::new();
        let r = GridResolver::new(&layout, &[], 1.0);
        let frames = r.resolve_frames(root());
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame.rect.x, 0.0);
        assert_eq!(frame.rect.y, 0.0);
        assert_eq!(frame.rect.w, 1000.0);
        assert_eq!(frame.rect.h, 500.0);
    }

    pub fn h_split_produces_two_frames_and_one_divider() {
        let mut layout = GridLayout::new();
        let f0 = layout.faces.keys().copied().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();
        let r = GridResolver::new(&layout, &[], 1.0);
        let frames   = r.resolve_frames(root());
        let dividers = r.resolve_dividers(root());
        assert_eq!(frames.len(),   2, "expected 2 frames");
        assert_eq!(dividers.len(), 1, "expected 1 divider");
        let d = &dividers[0];
        assert!((d.y - 250.0).abs() < 1.0, "H-divider y should be 250 px, got {}", d.y);
        assert_eq!(d.axis, SplitAxis::Horizontal);
    }

    pub fn gap_shrinks_frame_rect() {
        let mut layout = GridLayout::new();
        let f0 = layout.faces.keys().copied().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();

        let interior_eid = layout.edges.values()
            .find(|e| e.orientation == Orientation::Horizontal && !e.is_boundary)
            .map(|e| e.id)
            .unwrap();
        layout.set_half_gap(interior_eid, 2.0);
        if let Some(twin_id) = layout.twin(interior_eid) {
            layout.set_half_gap(twin_id, 2.0);
        }

        // mm_to_px=10 → half_gap_px=20
        let r = GridResolver::new(&layout, &[], 10.0);
        let frames = r.resolve_frames(root());
        assert_eq!(frames.len(), 2);
        let top = frames.iter().find(|f| f.rect.y < 10.0).unwrap();
        assert!((top.rect.h - 230.0).abs() < 1.0, "top h = {} (expected 230)", top.rect.h);
    }
}

#[cfg(test)]
mod tests {
    use super::test_impls as t;
    #[test] fn single_room_produces_one_frame() { t::single_room_produces_one_frame(); }
    #[test] fn h_split_produces_two_frames_and_one_divider() { t::h_split_produces_two_frames_and_one_divider(); }
    #[test] fn gap_shrinks_frame_rect() { t::gap_shrinks_frame_rect(); }
}
