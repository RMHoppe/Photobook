use wasm_bindgen::prelude::*;
use std::collections::HashSet;
use crate::PhotobookEditor;
use crate::grid_layout::{EPS, FaceId, Orientation};

// ---------------------------------------------------------------------------
// Public WASM API
// ---------------------------------------------------------------------------

#[wasm_bindgen]
impl PhotobookEditor {
    /// Returns true if ≥2 selected faces tile a complete rectangle (no gaps).
    pub fn selection_is_rectangular(&self) -> bool {
        self.selection_bounding_box().is_some()
    }

    /// Mirror selected faces left ↔ right within their bounding box.
    pub fn flip_selection_h(&mut self) {
        let Some((bx, _by, bw, _bh)) = self.selection_bounding_box() else { return };
        self.save_debug_snapshot();
        let sel: HashSet<FaceId> = self.selection.iter().copied().collect();
        let spread = self.doc.current_spread_mut();

        for edge in spread.layout.edges.values_mut() {
            if !sel.contains(&edge.face_id) || edge.orientation != Orientation::Vertical { continue; }
            edge.offset = bx + (bx + bw) - edge.offset;
            edge.facing = edge.facing.opposite();
            edge.is_boundary = edge.offset.abs() < EPS || (edge.offset - 1.0).abs() < EPS;
        }
        for &id in &sel {
            if let Some(f) = spread.layout.faces.get_mut(&id) {
                std::mem::swap(&mut f.left_edge_id, &mut f.right_edge_id);
            }
        }
        self.mark_structure_dirty();
    }

    /// Mirror selected faces top ↔ bottom within their bounding box.
    pub fn flip_selection_v(&mut self) {
        let Some((_bx, by, _bw, bh)) = self.selection_bounding_box() else { return };
        self.save_debug_snapshot();
        let sel: HashSet<FaceId> = self.selection.iter().copied().collect();
        let spread = self.doc.current_spread_mut();

        for edge in spread.layout.edges.values_mut() {
            if !sel.contains(&edge.face_id) || edge.orientation != Orientation::Horizontal { continue; }
            edge.offset = by + (by + bh) - edge.offset;
            edge.facing = edge.facing.opposite();
            edge.is_boundary = edge.offset.abs() < EPS || (edge.offset - 1.0).abs() < EPS;
        }
        for &id in &sel {
            if let Some(f) = spread.layout.faces.get_mut(&id) {
                std::mem::swap(&mut f.top_edge_id, &mut f.bottom_edge_id);
            }
        }
        self.mark_structure_dirty();
    }

    /// Rotate selected faces 90° clockwise within their bounding box.
    ///
    /// Normalized transform: (nx, ny) → (1−ny, nx).
    /// V at nx → H at ny=nx            (facing unchanged)
    /// H at ny → V at nx=1−ny          (facing flipped)
    /// Face wiring: left←bottom, top←left, right←top, bottom←right
    pub fn rotate_selection_cw(&mut self) {
        let Some((bx, by, bw, bh)) = self.selection_bounding_box() else { return };
        self.save_debug_snapshot();
        let sel: HashSet<FaceId> = self.selection.iter().copied().collect();
        let spread = self.doc.current_spread_mut();

        for edge in spread.layout.edges.values_mut() {
            if !sel.contains(&edge.face_id) { continue; }
            match edge.orientation {
                Orientation::Vertical => {
                    let nx = (edge.offset - bx) / bw;
                    edge.offset = by + nx * bh;
                    edge.orientation = Orientation::Horizontal;
                }
                Orientation::Horizontal => {
                    let ny = (edge.offset - by) / bh;
                    edge.offset = bx + (1.0 - ny) * bw;
                    edge.orientation = Orientation::Vertical;
                    edge.facing = edge.facing.opposite();
                }
            }
            edge.is_boundary = edge.offset.abs() < EPS || (edge.offset - 1.0).abs() < EPS;
        }
        for &id in &sel {
            if let Some(f) = spread.layout.faces.get_mut(&id) {
                let (l, t, r, b) = (f.left_edge_id, f.top_edge_id, f.right_edge_id, f.bottom_edge_id);
                f.left_edge_id   = b;
                f.top_edge_id    = l;
                f.right_edge_id  = t;
                f.bottom_edge_id = r;
            }
        }
        self.mark_structure_dirty();
    }

    /// Rotate selected faces 90° counter-clockwise within their bounding box.
    ///
    /// Normalized transform: (nx, ny) → (ny, 1−nx).
    /// V at nx → H at ny=1−nx          (facing flipped)
    /// H at ny → V at nx=ny            (facing unchanged)
    /// Face wiring: left←top, top←right, right←bottom, bottom←left
    pub fn rotate_selection_ccw(&mut self) {
        let Some((bx, by, bw, bh)) = self.selection_bounding_box() else { return };
        self.save_debug_snapshot();
        let sel: HashSet<FaceId> = self.selection.iter().copied().collect();
        let spread = self.doc.current_spread_mut();

        for edge in spread.layout.edges.values_mut() {
            if !sel.contains(&edge.face_id) { continue; }
            match edge.orientation {
                Orientation::Vertical => {
                    let nx = (edge.offset - bx) / bw;
                    edge.offset = by + (1.0 - nx) * bh;
                    edge.orientation = Orientation::Horizontal;
                    edge.facing = edge.facing.opposite();
                }
                Orientation::Horizontal => {
                    let ny = (edge.offset - by) / bh;
                    edge.offset = bx + ny * bw;
                    edge.orientation = Orientation::Vertical;
                }
            }
            edge.is_boundary = edge.offset.abs() < EPS || (edge.offset - 1.0).abs() < EPS;
        }
        for &id in &sel {
            if let Some(f) = spread.layout.faces.get_mut(&id) {
                let (l, t, r, b) = (f.left_edge_id, f.top_edge_id, f.right_edge_id, f.bottom_edge_id);
                f.left_edge_id   = t;
                f.top_edge_id    = r;
                f.right_edge_id  = b;
                f.bottom_edge_id = l;
            }
        }
        self.mark_structure_dirty();
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    /// Returns Some((bx, by, bw, bh)) when ≥2 selected faces tile a complete rectangle.
    pub(crate) fn selection_bounding_box(&self) -> Option<(f32, f32, f32, f32)> {
        if self.selection.len() < 2 { return None; }
        let layout = &self.doc.current_spread().layout;

        let mut bx1 = f32::MAX;
        let mut by1 = f32::MAX;
        let mut bx2 = f32::MIN;
        let mut by2 = f32::MIN;
        let mut total_area = 0.0_f32;

        for &id in &self.selection {
            let (x, y, w, h) = layout.face_rect(id)?;
            bx1 = bx1.min(x);
            by1 = by1.min(y);
            bx2 = bx2.max(x + w);
            by2 = by2.max(y + h);
            total_area += w * h;
        }

        let bw = bx2 - bx1;
        let bh = by2 - by1;
        let box_area = bw * bh;
        if box_area < EPS { return None; }
        // Faces must tile the bounding box with no gaps (allow 0.1% tolerance).
        if (total_area / box_area - 1.0).abs() > 1e-3 { return None; }

        Some((bx1, by1, bw, bh))
    }
}
