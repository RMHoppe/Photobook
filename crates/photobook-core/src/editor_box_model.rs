use wasm_bindgen::prelude::*;
use crate::layout::{Border, BorderPosition, BoxModel, MarginInsets};
use crate::grid_layout::FaceId;
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Box model reads
    // -----------------------------------------------------------------------

    pub fn get_box_model(&self) -> String {
        if self.selection.is_empty() {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        }
        let bms: Vec<BoxModel> = self.selection.iter()
            .filter_map(|&id| self.doc.current_spread().layout.faces.get(&id).map(|f| f.box_model.clone()))
            .collect();
        Self::merge_box_models_json(&bms)
    }

    pub fn get_face_box_model(&self) -> String {
        self.get_box_model()
    }

    pub fn get_transform_box_model(&self) -> String {
        let Some(id) = self.transform_target_node() else {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        };
        let bm = self.doc.current_spread().layout.faces.get(&id)
            .map(|f| f.box_model.clone())
            .unwrap_or_default();
        serde_json::to_string(&bm).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Box model writes
    // -----------------------------------------------------------------------

    pub fn set_box_model(&mut self, json: &str) {
        let bm: BoxModel = match serde_json::from_str(json) { Ok(v) => v, Err(_) => return };
        if self.selection.is_empty() { return; }
        for id in self.selection.clone() {
            self.apply_box_model_to_node(id, &bm);
        }
        self.mark_structure_dirty();
    }

    pub fn set_node_margin(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let Some(id) = self.transform_target_node() else { return };
        if let Some(face) = self.doc.current_spread_mut().layout.faces.get_mut(&id) {
            face.box_model.margin.top    = Some(top);
            face.box_model.margin.right  = Some(right);
            face.box_model.margin.bottom = Some(bottom);
            face.box_model.margin.left   = Some(left);
        }
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

    /// Returns the gap (full, mm) of the first selected divider chain.
    pub fn get_selected_segment_gap(&self) -> f32 {
        self.selected_segments.first()
            .map(|&eid| self.get_chain_gap(eid))
            .unwrap_or(0.0)
    }

    /// Sets the gap on all selected divider chains.
    pub fn set_selected_segment_gap(&mut self, gap: f32) {
        for eid in self.selected_segments.clone() {
            self.set_chain_gap(eid, gap);
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    pub(crate) fn apply_box_model_to_node(&mut self, id: FaceId, bm: &BoxModel) {
        const MIXED_STR: &str = "__mixed__";
        if let Some(face) = self.doc.current_spread_mut().layout.faces.get_mut(&id) {
            let r = &mut face.box_model;
            if let Some(v) = bm.margin.top    { r.margin.top    = Some(v); }
            if let Some(v) = bm.margin.right  { r.margin.right  = Some(v); }
            if let Some(v) = bm.margin.bottom { r.margin.bottom = Some(v); }
            if let Some(v) = bm.margin.left   { r.margin.left   = Some(v); }
            if bm.border.width  >= 0.0 { r.border.width  = bm.border.width; }
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

    pub(crate) fn merge_box_models_json(bms: &[BoxModel]) -> String {
        if bms.is_empty() {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        }
        if bms.len() == 1 {
            return serde_json::to_string(&bms[0]).unwrap_or_default();
        }
        let f = &bms[0];
        let rest = &bms[1..];
        let mf  = |v: f32,        agree: bool| -> f32        { if agree { v }    else { -1.0 } };
        let mfm = |v: Option<f32>, agree: bool| -> Option<f32> { if agree { v } else { None } };
        let ms = |v: &str, agree: bool| -> String {
            if agree { v.to_string() } else { "__mixed__".to_string() }
        };
        let merged = BoxModel {
            margin: MarginInsets {
                top:    mfm(f.margin.top,    rest.iter().all(|b| b.margin.top    == f.margin.top)),
                right:  mfm(f.margin.right,  rest.iter().all(|b| b.margin.right  == f.margin.right)),
                bottom: mfm(f.margin.bottom, rest.iter().all(|b| b.margin.bottom == f.margin.bottom)),
                left:   mfm(f.margin.left,   rest.iter().all(|b| b.margin.left   == f.margin.left)),
            },
            border: Border {
                width: mf(f.border.width, rest.iter().all(|b| b.border.width == f.border.width)),
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
