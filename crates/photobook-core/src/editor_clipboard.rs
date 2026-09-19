use std::collections::HashSet;

use wasm_bindgen::prelude::*;

use crate::grid_layout::{FaceId, GridLayout, LayoutPatch};
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    /// Capture the current rectangular frame selection as an opaque JSON
    /// clipboard payload. The outer response lets the UI report invalid
    /// selections without having to understand the payload format.
    pub fn copy_selected_layout(&self) -> String {
        let spread = self.doc.current_spread();
        match spread.layout.make_layout_patch(&self.selection, &spread.pinwheel_centers) {
            Ok(patch) => serde_json::json!({
                "ok": true,
                "clipboard": serde_json::to_string(&patch).unwrap_or_default(),
            }).to_string(),
            Err(error) => serde_json::json!({
                "ok": false,
                "error": error,
            }).to_string(),
        }
    }

    /// Empty means compatible; otherwise the returned text is suitable for a
    /// toast. Kept separate from paste so failed actions do not add no-op undo
    /// snapshots in the TypeScript undo manager.
    pub fn get_layout_paste_error(&self, clipboard: &str) -> String {
        let patch: LayoutPatch = match serde_json::from_str(clipboard) {
            Ok(value) => value,
            Err(_) => return "The copied layout is invalid.".into(),
        };
        if let Err(error) = GridLayout::validate_layout_patch(&patch) {
            return error;
        }
        self.doc.current_spread().layout
            .rectangular_selection_bounds(&self.selection)
            .err()
            .unwrap_or_default()
    }

    /// Replace the selected rectangular region while preserving its outline.
    /// The caller must create the undo snapshot immediately before this call.
    pub fn paste_layout(&mut self, clipboard: &str) -> bool {
        if !self.get_layout_paste_error(clipboard).is_empty() {
            return false;
        }
        let Ok(patch) = serde_json::from_str::<LayoutPatch>(clipboard) else {
            return false;
        };
        let old_selection = self.selection.clone();
        let old_set: HashSet<FaceId> = old_selection.iter().copied().collect();
        self.save_debug_snapshot();

        let replacement = {
            let spread = self.doc.current_spread_mut();
            match spread.layout.replace_selection_with_patch(&old_selection, &patch) {
                Ok(value) => value,
                Err(_) => return false,
            }
        };

        let spread = self.doc.current_spread_mut();
        spread.pinwheel_centers.retain(|id| !old_set.contains(id));
        spread.pinwheel_centers.extend(replacement.pinwheel_centers.iter().copied());
        self.selection = replacement.face_ids;
        self.selected_segments.clear();
        self.mark_structure_dirty();
        true
    }
}
