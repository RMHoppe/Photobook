use wasm_bindgen::prelude::*;
use crate::layout::SplitAxis;
use crate::grid_layout::{EdgeId, FaceId, OUTER_FACE};
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------------

    /// Replace the face selection with a single face (or clear if OUTER_FACE).
    /// Also clears segment selection (plain-click behaviour).
    pub fn select_face(&mut self, id: u32) {
        self.selected_segments.clear();
        if id == OUTER_FACE {
            self.selection.clear();
        } else if self.doc.current_spread().layout.faces.contains_key(&id) {
            self.selection = vec![id];
        }
        self.mark_structure_dirty();
    }

    /// Toggle a face in/out of the selection without touching segment selection.
    /// (cmd/ctrl-click behaviour.)
    pub fn toggle_selection(&mut self, id: u32) {
        if id == OUTER_FACE { return; }
        if !self.doc.current_spread().layout.faces.contains_key(&id) { return; }
        if let Some(pos) = self.selection.iter().position(|&x| x == id) {
            self.selection.remove(pos);
        } else {
            self.selection.push(id);
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // Edge (divider) selection
    // -----------------------------------------------------------------------

    /// Replace the segment selection with a single edge, clearing face selection.
    /// Passing OUTER_FACE clears segment selection only.
    pub fn select_segment(&mut self, segment_id: u32) {
        self.selection.clear();
        self.selected_segments.clear();
        if segment_id != OUTER_FACE {
            let valid = self.doc.current_spread().layout.contains_edge(segment_id);
            if valid { self.selected_segments.push(segment_id); }
        }
        self.mark_structure_dirty();
    }

    /// Toggle a segment in/out of the selection without touching face selection.
    /// (cmd/ctrl-click behaviour.)
    pub fn toggle_segment(&mut self, segment_id: u32) {
        if segment_id == OUTER_FACE { return; }
        let valid = self.doc.current_spread().layout.contains_edge(segment_id);
        if !valid { return; }
        if let Some(pos) = self.selected_segments.iter().position(|&x| x == segment_id) {
            self.selected_segments.remove(pos);
        } else {
            self.selected_segments.push(segment_id);
        }
        self.mark_structure_dirty();
    }

    /// Returns the first selected segment ID, or OUTER_FACE if none.
    pub fn get_selected_segment(&self) -> u32 {
        self.selected_segments.first().copied().unwrap_or(OUTER_FACE)
    }

    pub fn get_selected_segment_count(&self) -> u32 {
        self.selected_segments.len() as u32
    }

    pub fn is_segment_selected(&self, segment_id: u32) -> bool {
        self.selected_segments.contains(&segment_id)
    }

    /// Returns true if the edge can be deleted (interior, non-boundary).
    pub fn can_delete_segment(&self, segment_id: u32) -> bool {
        let layout = &self.doc.current_spread().layout;
        layout.contains_edge(segment_id) && !layout.is_boundary_edge(segment_id)
    }

    /// Delete an edge (twin pair) by ID. Returns true on success.
    pub fn delete_segment(&mut self, segment_id: u32) -> bool {
        self.save_debug_snapshot();
        let deleted = self.doc.current_spread_mut().layout.delete_twin_pair(segment_id).is_some();
        if deleted {
            self.selected_segments.retain(|&x| x != segment_id);
            self.mark_structure_dirty();
        }
        deleted
    }

    /// Delete all currently selected segments.
    pub fn delete_selected_segment(&mut self) -> bool {
        if self.selected_segments.is_empty() { return false; }
        self.save_debug_snapshot();
        let ids: Vec<EdgeId> = self.selected_segments.drain(..).collect();
        let mut any = false;
        for id in ids {
            if self.doc.current_spread_mut().layout.delete_twin_pair(id).is_some() {
                any = true;
            }
        }
        if any { self.mark_structure_dirty(); }
        any
    }

    pub fn is_selected(&self, id: u32) -> bool {
        self.selection.contains(&id)
    }

    pub fn get_selection_count(&self) -> u32 {
        self.selection.len() as u32
    }

    pub fn get_all_selected(&self) -> String {
        serde_json::to_string(&self.selection).unwrap_or_else(|_| "[]".into())
    }

    /// Select all faces and all interior edges in the current spread.
    pub fn select_all(&mut self) {
        let layout = &self.doc.current_spread().layout;
        self.selection = layout.faces.keys().copied().collect();
        self.selected_segments = layout.edges.values()
            .filter(|e| !e.is_boundary)
            .map(|e| e.id)
            .collect();
        self.mark_structure_dirty();
    }

    pub fn select_faces_in_rect(&mut self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) {
        self.selected_segments.clear();
        self.selection.clear();
        for id in self.collect_faces_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.selection.push(id);
        }
        self.mark_structure_dirty();
    }

    pub fn toggle_faces_in_rect(&mut self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) {
        self.selected_segments.clear();
        for id in self.collect_faces_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.toggle_selection(id);
        }
        self.mark_structure_dirty();
    }

    pub fn select_all_in_rect(&mut self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) {
        self.selection.clear();
        self.selected_segments.clear();
        for id in self.collect_faces_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.selection.push(id);
        }
        for id in self.collect_edges_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.selected_segments.push(id);
        }
        self.mark_structure_dirty();
    }

    pub fn toggle_all_in_rect(&mut self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) {
        for id in self.collect_faces_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.toggle_selection(id);
        }
        for id in self.collect_edges_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.toggle_segment(id);
        }
        self.mark_structure_dirty();
    }

    /// Move selection to the neighbour in `direction` (up/down/left/right).
    pub fn navigate(&mut self, direction: &str) {
        let Some(id) = self.selected_one() else { return };
        let layout = &self.doc.current_spread().layout;
        let Some((rx, ry, rw, rh)) = layout.face_rect(id) else { return };

        const PROBE: f32 = 0.005;
        let (cx, cy) = (rx + rw * 0.5, ry + rh * 0.5);
        let target = match direction {
            "up"    => layout.face_at(cx, ry - PROBE),
            "down"  => layout.face_at(cx, ry + rh + PROBE),
            "left"  => layout.face_at(rx - PROBE, cy),
            "right" => layout.face_at(rx + rw + PROBE, cy),
            _ => return,
        };
        if let Some(next_id) = target {
            if next_id != id {
                self.selection = vec![next_id];
                self.mark_structure_dirty();
            }
        }
    }

    pub fn get_selected(&self) -> u32 {
        self.selected_one().unwrap_or(OUTER_FACE)
    }

    // -----------------------------------------------------------------------
    // Layout mutation
    // -----------------------------------------------------------------------

    pub fn split_face_at(&mut self, id: u32, axis: &str, ratio: f32) -> bool {
        self.save_debug_snapshot();
        self.split_face_inner(id, axis, ratio.clamp(0.05, 0.95))
    }

    pub fn split_face_into_n(&mut self, id: u32, axis: &str, n: u32) -> bool {
        if n == 0 { return false; }
        if n == 1 { return true; }
        self.save_debug_snapshot();
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        let faces = self.split_into_n_collect(id, split_axis, n);
        if let Some(&first) = faces.first() {
            self.selection = vec![first];
        }
        self.mark_structure_dirty();
        true
    }

    pub fn split_face_into_quadrant_n(&mut self, id: u32, n: u32) -> bool {
        if n == 0 { return false; }
        self.save_debug_snapshot();
        let v_faces = self.split_into_n_collect(id, SplitAxis::Vertical, n);
        let first = v_faces.first().copied();
        for face in v_faces {
            self.split_into_n_collect(face, SplitAxis::Horizontal, n);
        }
        if let Some(first_id) = first {
            self.selection = vec![first_id];
        }
        self.mark_structure_dirty();
        true
    }

    /// Delete all currently selected faces.
    /// Pinwheel centre faces are dissolved (restoring the X-junction) rather than deleted.
    pub fn delete_selected(&mut self) -> bool {
        if self.selection.is_empty() { return false; }
        self.save_debug_snapshot();
        let ids: Vec<FaceId> = self.selection.drain(..).collect();
        let mut any_deleted = false;
        for id in ids {
            if self.doc.current_spread().pinwheel_centers.contains(&id) {
                if self.doc.current_spread_mut().layout.dissolve_pinwheel_center(id) {
                    self.doc.current_spread_mut().pinwheel_centers.retain(|&c| c != id);
                    any_deleted = true;
                }
            } else {
                if self.doc.current_spread().layout.face_rect(id).is_none() { continue; }
                if self.doc.current_spread_mut().layout.delete_face(id) {
                    any_deleted = true;
                }
            }
        }
        if any_deleted { self.mark_structure_dirty(); }
        any_deleted
    }

    // -----------------------------------------------------------------------
    // Z-order
    // -----------------------------------------------------------------------

    pub fn get_face_z_index(&self, id: u32) -> i32 {
        self.doc.current_spread().layout.faces.get(&id)
            .map(|f| f.z_index)
            .unwrap_or(0)
    }

    pub fn move_face_z_order(&mut self, id: u32, direction: &str) {
        self.save_debug_snapshot();
        let layout = &self.doc.current_spread().layout;
        let mut entries: Vec<(i32, u32)> = layout.faces.values()
            .map(|f| (f.z_index, f.id))
            .collect();
        entries.sort_by_key(|(z, fid)| (*z, *fid));

        let Some(cur_pos) = entries.iter().position(|(_, fid)| *fid == id) else { return };
        match direction {
            "up"    if cur_pos + 1 < entries.len() => entries.swap(cur_pos, cur_pos + 1),
            "down"  if cur_pos > 0                 => entries.swap(cur_pos, cur_pos - 1),
            "front" if cur_pos + 1 < entries.len() => { let e = entries.remove(cur_pos); entries.push(e); }
            "back"  if cur_pos > 0                 => { let e = entries.remove(cur_pos); entries.insert(0, e); }
            _ => return,
        }
        let spread = &mut self.doc.current_spread_mut();
        for (new_z, (_, fid)) in entries.iter().enumerate() {
            if let Some(face) = spread.layout.faces.get_mut(fid) {
                face.z_index = new_z as i32;
            }
        }
        self.mark_structure_dirty();
    }

}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    /// Split face `id` along `axis` at `ratio` (relative to the face's own extent).
    pub(crate) fn split_face_inner(&mut self, id: FaceId, axis: &str, ratio: f32) -> bool {
        let layout = &self.doc.current_spread().layout;
        let Some((rx, ry, rw, rh)) = layout.face_rect(id) else { return false };
        let pos = match axis {
            "h" => ry + ratio * rh,
            _   => rx + ratio * rw,
        };
        let layout = &mut self.doc.current_spread_mut().layout;
        let ok = match axis {
            "h" => layout.split_face(id, pos, SplitAxis::Horizontal).is_some(),
            _   => layout.split_face(id, pos, SplitAxis::Vertical).is_some(),
        };
        if ok { self.mark_structure_dirty(); }
        ok
    }

    /// Split face `id` into `n` equal parts along `axis`.
    /// Returns the resulting face IDs in order (top→bottom or left→right).
    pub(crate) fn split_into_n_collect(&mut self, id: FaceId, axis: SplitAxis, n: u32) -> Vec<FaceId> {
        if n <= 1 { return vec![id]; }
        let mut current_id = id;
        let mut faces = Vec::with_capacity(n as usize);
        for i in 0..(n - 1) {
            let layout = &self.doc.current_spread().layout;
            let Some((rx, ry, rw, rh)) = layout.face_rect(current_id) else { break };
            let ratio = 1.0 / (n - i) as f32;
            let pos = match axis {
                SplitAxis::Horizontal => ry + ratio * rh,
                SplitAxis::Vertical   => rx + ratio * rw,
            };
            let ok = {
                let layout = &mut self.doc.current_spread_mut().layout;
                layout.split_face(current_id, pos, axis).is_some()
            };
            if !ok { break; }
            faces.push(current_id);
            let layout = &self.doc.current_spread().layout;
            let probe = match axis {
                SplitAxis::Horizontal => (rx + rw * 0.5, (pos + ry + rh) / 2.0),
                SplitAxis::Vertical   => ((pos + rx + rw) / 2.0, ry + rh * 0.5),
            };
            current_id = layout.face_at(probe.0, probe.1).unwrap_or(current_id);
        }
        faces.push(current_id);
        faces
    }
}
