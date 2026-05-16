use wasm_bindgen::prelude::*;
use crate::layout::{FrameTransform, SplitAxis};
use crate::grid_layout::FaceId;
use crate::grid_resolver::GridResolver;
use crate::utils::image_cover_factors;
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Image assignment and transform
    // -----------------------------------------------------------------------

    pub fn swap_images(&mut self, node_a: u32, node_b: u32) {
        if node_a == node_b { return; }
        let layout = &self.doc.current_spread().layout;
        let (Some(a_leaf), Some(b_leaf)) = (
            layout.faces.get(&node_a).map(|f| f.image.clone()),
            layout.faces.get(&node_b).map(|f| f.image.clone()),
        ) else { return };
        let layout = &mut self.doc.current_spread_mut().layout;
        if let Some(f) = layout.faces.get_mut(&node_a) { f.image = b_leaf; }
        if let Some(f) = layout.faces.get_mut(&node_b) { f.image = a_leaf; }
        self.mark_structure_dirty();
    }

    pub fn assign_image(&mut self, node_id: u32, image_id: &str) {
        if let Some(face) = self.doc.current_spread_mut().layout.faces.get_mut(&node_id) {
            face.image.image_id  = Some(image_id.to_string());
            face.image.pan_x     = 0.5;
            face.image.pan_y     = 0.5;
            face.image.scale     = 1.0;
            face.image.rotation_deg = 0.0;
        }
        self.mark_leaf_dirty(node_id);
    }

    pub fn set_image_transform(
        &mut self,
        node_id: u32,
        pan_x: f32,
        pan_y: f32,
        scale: f32,
        rotation_deg: f32,
    ) {
        if let Some(face) = self.doc.current_spread_mut().layout.faces.get_mut(&node_id) {
            face.image.pan_x        = pan_x.clamp(0.0, 1.0);
            face.image.pan_y        = pan_y.clamp(0.0, 1.0);
            face.image.scale        = scale.max(1.0);
            face.image.rotation_deg = rotation_deg;
        }
        self.mark_leaf_dirty(node_id);
    }

    pub fn get_frame_transform(&self, face_id: u32) -> String {
        let t = self.doc.current_spread().layout.faces.get(&face_id)
            .map(|f| FrameTransform {
                pan_x:        f.image.pan_x,
                pan_y:        f.image.pan_y,
                scale:        f.image.scale,
                rotation_deg: f.image.rotation_deg,
            })
            .unwrap_or(FrameTransform { pan_x: 0.5, pan_y: 0.5, scale: 1.0, rotation_deg: 0.0 });
        serde_json::to_string(&t).unwrap_or_default()
    }

    pub fn set_face_frame_rotation(&mut self, face_id: u32, rotation_deg: f32) {
        if let Some(face) = self.doc.current_spread_mut().layout.faces.get_mut(&face_id) {
            face.box_model.face_rotation_deg = Some(rotation_deg);
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // DPI checks
    // -----------------------------------------------------------------------

    pub fn register_image_size(&mut self, image_id: &str, width_px: u32, height_px: u32) {
        self.image_sizes.insert(image_id.to_string(), (width_px, height_px));
    }

    /// Split `face_id` into `count` leaf faces using recursive binary halving with
    /// alternating axes, then return the leaf face IDs as a JSON array in traversal
    /// order (first half before second half at each level).
    ///
    /// `prefer_vertical` selects the axis of the first cut:
    ///   true  → vertical (left / right)
    ///   false → horizontal (top / bottom)
    ///
    /// Subsequent levels alternate the axis automatically.
    pub fn split_face_for_multi_drop(&mut self, face_id: u32, count: u32, prefer_vertical: bool) -> String {
        if count <= 1 {
            return serde_json::json!([face_id]).to_string();
        }
        self.save_debug_snapshot();
        let ids = self.split_recursive_binary(face_id, count, prefer_vertical);
        self.mark_structure_dirty();
        serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into())
    }

    /// Returns a JSON array of all image IDs that are assigned to at least one
    /// face across all spreads in the document.
    pub fn get_used_image_ids(&self) -> String {
        let mut ids: std::collections::HashSet<&str> = Default::default();
        for spread in &self.doc.spreads {
            for face in spread.layout.faces.values() {
                if let Some(id) = &face.image.image_id {
                    ids.insert(id.as_str());
                }
            }
        }
        let ids_vec: Vec<&str> = ids.into_iter().collect();
        serde_json::to_string(&ids_vec).unwrap_or_else(|_| "[]".into())
    }

    pub fn get_low_dpi_frames(&mut self, canvas_w: f32, canvas_h: f32) -> String {
        let spread_idx = self.doc.current_spread;
        let w_bits = canvas_w.to_bits();
        let h_bits = canvas_h.to_bits();
        if !self.low_dpi_dirty {
            if let Some(ref c) = self.low_dpi_cache {
                if c.canvas_w_bits == w_bits && c.canvas_h_bits == h_bits && c.spread_idx == spread_idx {
                    return c.json.clone();
                }
            }
        }
        let spread = self.doc.current_spread();
        let mm_to_px = self.mm_to_px(canvas_w);
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let frames = GridResolver::new(&spread.layout, &[], mm_to_px)
            .resolve_frames(root_rect);
        let print_dpi = self.doc.print_dpi;
        let nat_dpi = 300.0_f32;

        #[derive(serde::Serialize)]
        struct LowDpiFrame { id: FaceId, effective_dpi: u32 }

        let low_dpi: Vec<LowDpiFrame> = frames.iter().filter_map(|frame| {
            let image_id = frame.image_id.as_ref()?;
            let &(img_w, img_h) = self.image_sizes.get(image_id.as_str())?;
            if img_w == 0 || img_h == 0 { return None; }

            let frame_w_mm = frame.rect.w / mm_to_px;
            let frame_h_mm = frame.rect.h / mm_to_px;
            if frame_w_mm <= 0.0 || frame_h_mm <= 0.0 { return None; }

            let nat_w_mm = img_w as f32 / nat_dpi * 25.4;
            let nat_h_mm = img_h as f32 / nat_dpi * 25.4;
            if nat_w_mm <= 0.0 || nat_h_mm <= 0.0 { return None; }

            let (_, _, total_scale) = image_cover_factors(
                frame_w_mm, frame_h_mm, nat_w_mm, nat_h_mm, frame.rotation_deg, frame.scale,
            );
            let effective_dpi = nat_dpi / total_scale;
            if effective_dpi < print_dpi {
                Some(LowDpiFrame { id: frame.id, effective_dpi: effective_dpi.round() as u32 })
            } else {
                None
            }
        }).collect();

        let json = serde_json::to_string(&low_dpi).unwrap_or_else(|_| "[]".into());
        self.low_dpi_cache = Some(crate::LowDpiCache {
            canvas_w_bits: w_bits,
            canvas_h_bits: h_bits,
            spread_idx,
            json: json.clone(),
        });
        self.low_dpi_dirty = false;
        json
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    /// Recursively split `face_id` into `count` leaves using binary halving.
    /// At each level the current axis is used, then flipped for both children.
    /// Returns the leaf IDs in traversal order (first subtree before second).
    fn split_recursive_binary(&mut self, face_id: FaceId, count: u32, vertical: bool) -> Vec<FaceId> {
        if count <= 1 { return vec![face_id]; }

        let layout = &self.doc.current_spread().layout;
        let Some((rx, ry, rw, rh)) = layout.face_rect(face_id) else { return vec![face_id]; };

        let left_count  = count / 2;
        let right_count = count - left_count;
        let ratio = left_count as f32 / count as f32;

        let (axis, pos) = if vertical {
            (SplitAxis::Vertical,   rx + ratio * rw)
        } else {
            (SplitAxis::Horizontal, ry + ratio * rh)
        };

        // Perform the split. The original face_id retains the first (left/top) half.
        let split_ok = {
            let layout = &mut self.doc.current_spread_mut().layout;
            layout.split_face(face_id, pos, axis).is_some()
        };
        if !split_ok { return vec![face_id]; }

        // Probe the centre of the second (right/bottom) half to find its ID.
        let second_probe = if vertical {
            ((pos + rx + rw) / 2.0, ry + rh * 0.5)
        } else {
            (rx + rw * 0.5, (pos + ry + rh) / 2.0)
        };
        let layout = &self.doc.current_spread().layout;
        let second_id = match layout.face_at(second_probe.0, second_probe.1) {
            Some(id) if id != face_id => id,
            _ => return vec![face_id], // probe hit the wrong face — bail gracefully
        };

        let mut result = self.split_recursive_binary(face_id,  left_count,  !vertical);
        result.extend(self.split_recursive_binary(second_id, right_count, !vertical));
        result
    }
}
