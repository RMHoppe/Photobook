use wasm_bindgen::prelude::*;
use crate::bsp::{BspKind, NodeId};
use crate::layout::{LayoutResolver, LeafTransform};
use crate::utils::image_cover_factors;
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Image assignment and transform
    // -----------------------------------------------------------------------

    /// Swap the image (and its transform) between two leaf nodes.
    pub fn swap_images(&mut self, node_a: u32, node_b: u32) {
        if node_a == node_b { return; }
        let tree = &self.doc.current_spread().tree;
        let (Some(a), Some(b)) = (tree.get_leaf_data(node_a), tree.get_leaf_data(node_b)) else { return; };
        let tree = &mut self.doc.current_spread_mut().tree;
        if let Some(n) = tree.get_mut(node_a) {
            if let BspKind::Leaf(ref mut l) = n.kind { *l = b; }
        }
        if let Some(n) = tree.get_mut(node_b) {
            if let BspKind::Leaf(ref mut l) = n.kind { *l = a; }
        }
        self.mark_structure_dirty();
    }

    pub fn assign_image(&mut self, node_id: u32, image_id: &str) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            if let BspKind::Leaf(ref mut l) = node.kind {
                l.image_id = Some(image_id.to_string());
                l.pan_x = 0.5;
                l.pan_y = 0.5;
                l.scale = 1.0;
                l.rotation_deg = 0.0;
            }
        }
        self.mark_leaf_dirty(node_id);
    }

    /// Update the image transform for a leaf node.
    pub fn set_image_transform(
        &mut self,
        node_id: u32,
        pan_x: f32,
        pan_y: f32,
        scale: f32,
        rotation_deg: f32,
    ) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            if let BspKind::Leaf(ref mut l) = node.kind {
                l.pan_x = pan_x.clamp(0.0, 1.0);
                l.pan_y = pan_y.clamp(0.0, 1.0);
                l.scale = scale.max(1.0);
                l.rotation_deg = rotation_deg;
            }
        }
        self.mark_leaf_dirty(node_id);
    }

    /// Return `{pan_x, pan_y, scale, rotation_deg}` JSON for a leaf node.
    pub fn get_leaf_transform(&self, node_id: u32) -> String {
        let t = self.doc.current_spread().tree.get(node_id)
            .and_then(|n| if let BspKind::Leaf(ref l) = n.kind {
                Some(LeafTransform { pan_x: l.pan_x, pan_y: l.pan_y, scale: l.scale, rotation_deg: l.rotation_deg })
            } else { None })
            .unwrap_or(LeafTransform { pan_x: 0.5, pan_y: 0.5, scale: 1.0, rotation_deg: 0.0 });
        serde_json::to_string(&t).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Per-node frame transform (used for multi-selection randomization)
    // -----------------------------------------------------------------------

    pub fn set_node_frame_rotation(&mut self, node_id: u32, rotation_deg: f32) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(node_id) {
            node.box_model.node_rotation_deg = Some(rotation_deg);
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // DPI checks
    // -----------------------------------------------------------------------

    /// Register the source pixel dimensions for an image.
    pub fn register_image_size(&mut self, image_id: &str, width_px: u32, height_px: u32) {
        self.image_sizes.insert(image_id.to_string(), (width_px, height_px));
    }

    /// Returns a JSON array of `{id, effective_dpi}` for frames whose images fall below the
    /// document's print DPI at the current layout and user-scale settings.
    /// Result is cached; re-computed only when `low_dpi_dirty` is set.
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
        let resolver = LayoutResolver::new(&spread.tree, &[], mm_to_px);
        let leaves = resolver.resolve_leaves(root_rect);
        let print_dpi = self.doc.print_dpi;
        let nat_dpi = 300.0_f32;

        #[derive(serde::Serialize)]
        struct LowDpiFrame { id: NodeId, effective_dpi: u32 }

        let low_dpi: Vec<LowDpiFrame> = leaves.iter().filter_map(|leaf| {
            let image_id = leaf.image_id.as_ref()?;
            let &(img_w, img_h) = self.image_sizes.get(image_id.as_str())?;
            if img_w == 0 || img_h == 0 { return None; }

            let frame_w_mm = leaf.rect.w / mm_to_px;
            let frame_h_mm = leaf.rect.h / mm_to_px;
            if frame_w_mm <= 0.0 || frame_h_mm <= 0.0 { return None; }

            let nat_w_mm = img_w as f32 / nat_dpi * 25.4;
            let nat_h_mm = img_h as f32 / nat_dpi * 25.4;
            if nat_w_mm <= 0.0 || nat_h_mm <= 0.0 { return None; }

            let (_, _, total_scale) = image_cover_factors(
                frame_w_mm, frame_h_mm, nat_w_mm, nat_h_mm, leaf.rotation_deg, leaf.scale,
            );
            let effective_dpi = nat_dpi / total_scale;
            if effective_dpi < print_dpi {
                Some(LowDpiFrame { id: leaf.id, effective_dpi: effective_dpi.round() as u32 })
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
