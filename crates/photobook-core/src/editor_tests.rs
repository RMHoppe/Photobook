/// Integration-level tests for the photobook editor API.

#[cfg(any(test, feature = "wasm-test"))]
pub(crate) mod test_impls {
    use crate::PhotobookEditor;
    use crate::grid_layout::OUTER_FACE;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn ed() -> PhotobookEditor {
        let mut e = PhotobookEditor::new(210.0, 297.0, 0.0);
        // Spread::new() pre-splits vertically for the two-page layout; reset to
        // a single face so tests have a predictable baseline.
        e.doc.current_spread_mut().layout = crate::grid_layout::GridLayout::new();
        e
    }

    fn face_count(ed: &PhotobookEditor) -> usize {
        ed.doc.current_spread().layout.faces.len()
    }

    fn first_face(ed: &PhotobookEditor) -> u32 {
        *ed.doc.current_spread().layout.faces.keys().next().unwrap()
    }

    fn any_interior_edge(ed: &PhotobookEditor) -> Option<u32> {
        let layout = &ed.doc.current_spread().layout;
        layout.edges.values().find(|e| !e.is_boundary).map(|e| e.id)
    }

    fn boundary_edge(ed: &PhotobookEditor) -> u32 {
        let layout = &ed.doc.current_spread().layout;
        layout.edges.values()
            .find(|e| e.is_boundary)
            .map(|e| e.id)
            .unwrap()
    }

    // -----------------------------------------------------------------------
    // Splitting frames
    // -----------------------------------------------------------------------

    pub fn split_h_produces_two_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        let ok = ed.split_face_at(f, "h", 0.5);
        assert!(ok, "split_face_at should succeed on a valid face");
        assert_eq!(face_count(&ed), 2);
    }

    pub fn split_into_n_produces_n_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        let ok = ed.split_face_into_n(f, "h", 4);
        assert!(ok);
        assert_eq!(face_count(&ed), 4);
    }

    pub fn split_into_quadrant_produces_four_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        let ok = ed.split_face_into_quadrant_n(f, 2);
        assert!(ok);
        assert_eq!(face_count(&ed), 4);
    }

    pub fn split_at_noncenter_ratio_creates_unequal_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "v", 0.25);
        let layout = &ed.doc.current_spread().layout;
        let rects: Vec<_> = layout.faces.values()
            .filter_map(|face| layout.face_rect(face.id))
            .collect();
        assert_eq!(rects.len(), 2);
        let widths: Vec<f32> = rects.iter().map(|(_, _, w, _)| *w).collect();
        let small = widths.iter().cloned().fold(f32::MAX, f32::min);
        let large = widths.iter().cloned().fold(f32::MIN, f32::max);
        assert!((large / small - 3.0).abs() < 0.01, "widths should be 1:3, got {small:.4}:{large:.4}");
    }

    pub fn split_invalid_id_returns_false() {
        let mut ed = ed();
        let ok = ed.split_face_at(99999, "h", 0.5);
        assert!(!ok, "split on unknown id should return false");
        assert_eq!(face_count(&ed), 1);
    }

    // -----------------------------------------------------------------------
    // Merging frames
    // -----------------------------------------------------------------------

    pub fn delete_interior_divider_merges_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        assert_eq!(face_count(&ed), 2);

        let eid = any_interior_edge(&ed).expect("split should create an interior edge");
        ed.select_segment(eid);
        let ok = ed.delete_selected_segment();
        assert!(ok, "delete_selected_segment should succeed for a valid interior edge");
        assert_eq!(face_count(&ed), 1, "frames should merge back to one");
    }

    pub fn delete_with_no_selection_does_nothing() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let ok = ed.delete_selected_segment();
        assert!(!ok);
        assert_eq!(face_count(&ed), 2);
    }

    // -----------------------------------------------------------------------
    // Divider gap
    // -----------------------------------------------------------------------

    pub fn divider_gap_defaults_to_zero() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        assert!((ed.get_selected_segment_gap() - 0.0).abs() < 1e-4);
    }

    pub fn set_and_get_divider_gap() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        ed.set_selected_segment_gap(5.0);
        assert!((ed.get_selected_segment_gap() - 5.0).abs() < 1e-4);
    }

    pub fn divider_gap_clamped_to_nonnegative() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        ed.set_selected_segment_gap(-3.0);
        assert!((ed.get_selected_segment_gap() - 0.0).abs() < 1e-4);
    }

    pub fn get_selected_segment_gap_without_selection_returns_zero() {
        let ed = ed();
        assert!((ed.get_selected_segment_gap() - 0.0).abs() < 1e-4);
    }

    pub fn divider_gap_reflected_in_half_gap() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        ed.set_selected_segment_gap(4.0);

        // The resolved divider should expose a positive half_gap.
        let dividers: Vec<serde_json::Value> =
            serde_json::from_str(&ed.get_dividers(1000.0, 500.0)).unwrap();
        assert_eq!(dividers.len(), 1);
        let half_gap = dividers[0]["half_gap"].as_f64().unwrap_or(-1.0);
        assert!(half_gap > 0.0, "half_gap should be positive when gap=4mm, got {half_gap}");
    }

    // -----------------------------------------------------------------------
    // Frame properties
    // -----------------------------------------------------------------------

    pub fn set_margin_stored_in_box_model() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.select_face(f);

        let json = r##"{"margin":{"top":8.0,"right":4.0,"bottom":2.0,"left":1.0},"border":{"width":0.0,"color":"#000000","position":"centered"},"face_rotation_deg":0.0}"##;
        ed.set_face_box_model(json);

        let bm: serde_json::Value = serde_json::from_str(&ed.get_face_box_model()).unwrap();
        assert!((bm["margin"]["top"].as_f64().unwrap() - 8.0).abs() < 1e-3);
        assert!((bm["margin"]["right"].as_f64().unwrap() - 4.0).abs() < 1e-3);
        assert!((bm["margin"]["bottom"].as_f64().unwrap() - 2.0).abs() < 1e-3);
        assert!((bm["margin"]["left"].as_f64().unwrap() - 1.0).abs() < 1e-3);
    }

    pub fn set_border_width_stored_in_box_model() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.select_face(f);

        let json = r##"{"margin":{"top":0.0,"right":0.0,"bottom":0.0,"left":0.0},"border":{"width":2.5,"color":"#0000ff","position":"inner"},"face_rotation_deg":0.0}"##;
        ed.set_face_box_model(json);

        let bm: serde_json::Value = serde_json::from_str(&ed.get_face_box_model()).unwrap();
        // get_face_box_model normalises to per-side fields.
        assert!((bm["border"]["width_top"].as_f64().unwrap() - 2.5).abs() < 1e-3);
        assert_eq!(bm["border"]["color"].as_str().unwrap(), "#0000ff");
        assert_eq!(bm["border"]["position"].as_str().unwrap(), "inner");
    }

    pub fn set_rotation_stored_in_box_model() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.select_face(f);

        let json = r##"{"margin":{"top":0.0,"right":0.0,"bottom":0.0,"left":0.0},"border":{"width":0.0,"color":"#000000","position":"centered"},"face_rotation_deg":45.0}"##;
        ed.set_face_box_model(json);

        let bm: serde_json::Value = serde_json::from_str(&ed.get_face_box_model()).unwrap();
        let rot = bm["face_rotation_deg"].as_f64().unwrap_or(-1.0);
        assert!((rot - 45.0).abs() < 1e-3, "rotation should be 45°, got {rot}");
    }

    // -----------------------------------------------------------------------
    // Z-order
    // -----------------------------------------------------------------------

    pub fn z_index_of_single_frame_is_zero() {
        let ed = ed();
        let f = first_face(&ed);
        assert_eq!(ed.get_face_z_index(f), 0);
    }

    pub fn move_up_increases_z_index() {
        let mut ed = ed();
        let f0 = first_face(&ed);
        ed.split_face_at(f0, "h", 0.5);

        let mut faces: Vec<u32> = ed.doc.current_spread().layout.faces.keys().copied().collect();
        faces.sort();
        let (fa, fb) = (faces[0], faces[1]);

        ed.move_face_z_order(fa, "up");

        let za = ed.get_face_z_index(fa);
        let zb = ed.get_face_z_index(fb);
        assert_ne!(za, zb);
        assert!(za > zb, "fa should now be above fb after move_up");
    }

    // -----------------------------------------------------------------------
    // Multi-selection
    // -----------------------------------------------------------------------

    pub fn select_all_selects_every_face() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let f2 = *ed.doc.current_spread().layout.faces.keys()
            .find(|&&id| id != f).unwrap();
        ed.split_face_at(f2, "v", 0.5);
        assert_eq!(face_count(&ed), 3);

        ed.select_all();
        assert_eq!(ed.get_selection_count() as usize, 3);
    }

    pub fn selecting_a_seg_clears_face_selection() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.select_face(f);
        assert_eq!(ed.get_selection_count(), 1);

        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);

        assert_eq!(ed.get_selection_count(), 0);
        assert_eq!(ed.get_selected_segment(), eid);
    }

    pub fn selecting_a_face_clears_seg_selection() {
        let mut ed = ed();
        let f0 = first_face(&ed);
        ed.split_face_at(f0, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        assert_eq!(ed.get_selected_segment(), eid);

        let f = *ed.doc.current_spread().layout.faces.keys().next().unwrap();
        ed.select_face(f);
        assert_eq!(ed.get_selected_segment(), OUTER_FACE);
        assert_eq!(ed.get_selection_count(), 1);
    }

    pub fn select_faces_in_rect_finds_covered_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "v", 0.5);
        assert_eq!(face_count(&ed), 2);

        ed.select_faces_in_rect(0.0, 0.0, 200.0, 500.0, 1000.0, 500.0);
        assert_eq!(ed.get_selection_count(), 1);
    }

    // -----------------------------------------------------------------------
    // Snapping
    // -----------------------------------------------------------------------

    pub fn snap_within_radius_aligns_to_existing_divider() {
        use crate::grid_layout::GridLayout;
        use crate::layout::SplitAxis;
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();

        let snapped = layout.snap(SplitAxis::Horizontal, 0.53, &[], 0.05);
        assert!((snapped - 0.5).abs() < 1e-4,
            "snap should return 0.5 for input 0.53 with radius 0.05, got {snapped}");
    }

    pub fn snap_outside_radius_returns_original_value() {
        use crate::grid_layout::GridLayout;
        use crate::layout::SplitAxis;
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();

        let snapped = layout.snap(SplitAxis::Horizontal, 0.8, &[], 0.05);
        assert!((snapped - 0.8).abs() < 1e-4,
            "snap should return original value when outside radius, got {snapped}");
    }

    pub fn snap_excludes_the_dragged_chain() {
        use crate::grid_layout::GridLayout;
        use crate::layout::SplitAxis;
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();
        let eid = layout.edges.values()
            .find(|e| !e.is_boundary)
            .map(|e| e.id)
            .unwrap();
        let chain = layout.chain_for_edge(eid);

        // With the chain excluded, snap to 0.5 should not snap to itself
        let snapped = layout.snap(SplitAxis::Horizontal, 0.5, &chain, 0.05);
        // No other interior divider, so returns input unchanged
        assert!((snapped - 0.5).abs() < 1e-4);
    }

    // -----------------------------------------------------------------------
    // Edge panel drag
    // -----------------------------------------------------------------------

    pub fn edge_panel_drag_creates_new_split() {
        let mut ed = ed();
        assert_eq!(face_count(&ed), 1);

        let rep_id = ed.begin_edge_panel_drag("h", false, 500.0, 250.0, 1000.0, 500.0);
        assert_ne!(rep_id, OUTER_FACE);
        assert_eq!(face_count(&ed), 2);

        ed.end_edge_panel_drag();
        assert_eq!(face_count(&ed), 2);
    }

    pub fn edge_panel_drag_cancel_reverts_layout() {
        let mut ed = ed();
        ed.begin_edge_panel_drag("v", false, 300.0, 250.0, 1000.0, 500.0);
        assert_eq!(face_count(&ed), 2);

        ed.cancel_edge_panel_drag();
        assert_eq!(face_count(&ed), 1);
    }

    // -----------------------------------------------------------------------
    // Boundary edge protection
    // -----------------------------------------------------------------------

    pub fn boundary_edge_cannot_be_deleted() {
        let mut ed = ed();
        let beid = boundary_edge(&ed);
        ed.select_segment(beid);
        // can_delete_segment returns false for boundary
        assert!(!ed.can_delete_segment(beid));
    }

    pub fn delete_selected_face() {
        let mut ed = ed();
        let f0 = first_face(&ed);
        ed.split_face_at(f0, "h", 0.5);
        assert_eq!(face_count(&ed), 2);

        let f1 = *ed.doc.current_spread().layout.faces.keys()
            .find(|&&id| id != f0).unwrap();
        ed.selection = vec![f1];
        let ok = ed.delete_selected();
        assert!(ok);
        assert_eq!(face_count(&ed), 1);
    }

    // -----------------------------------------------------------------------
    // Save / load state
    // -----------------------------------------------------------------------

    pub fn save_and_load_roundtrip() {
        let mut orig = ed();
        orig.add_page();
        let json = orig.save_state();
        let mut ed2 = ed();
        assert!(ed2.load_state(&json));
        assert_eq!(ed2.doc.spreads.len(), orig.doc.spreads.len());
    }

    pub fn load_state_rejects_future_schema_version() {
        let mut ed = ed();
        // Inject a schema_version that doesn't exist yet.
        let json = ed.save_state().replace("\"schema_version\":1", "\"schema_version\":999");
        // Also handle the case where schema_version was not present (default), so inject it.
        let json = if json.contains("schema_version") {
            json
        } else {
            json.replacen('{', "{\"schema_version\":999,", 1)
        };
        assert!(!ed.load_state(&json));
    }
}

#[cfg(test)]
mod tests {
    use super::test_impls as t;
    #[test] fn split_h_produces_two_frames() { t::split_h_produces_two_frames(); }
    #[test] fn split_into_n_produces_n_frames() { t::split_into_n_produces_n_frames(); }
    #[test] fn split_into_quadrant_produces_four_frames() { t::split_into_quadrant_produces_four_frames(); }
    #[test] fn split_at_noncenter_ratio_creates_unequal_frames() { t::split_at_noncenter_ratio_creates_unequal_frames(); }
    #[test] fn split_invalid_id_returns_false() { t::split_invalid_id_returns_false(); }
    #[test] fn delete_interior_divider_merges_frames() { t::delete_interior_divider_merges_frames(); }
    #[test] fn delete_with_no_selection_does_nothing() { t::delete_with_no_selection_does_nothing(); }
    #[test] fn divider_gap_defaults_to_zero() { t::divider_gap_defaults_to_zero(); }
    #[test] fn set_and_get_divider_gap() { t::set_and_get_divider_gap(); }
    #[test] fn divider_gap_clamped_to_nonnegative() { t::divider_gap_clamped_to_nonnegative(); }
    #[test] fn get_selected_segment_gap_without_selection_returns_zero() { t::get_selected_segment_gap_without_selection_returns_zero(); }
    #[test] fn divider_gap_reflected_in_half_gap() { t::divider_gap_reflected_in_half_gap(); }
    #[test] fn set_margin_stored_in_box_model() { t::set_margin_stored_in_box_model(); }
    #[test] fn set_border_width_stored_in_box_model() { t::set_border_width_stored_in_box_model(); }
    #[test] fn set_rotation_stored_in_box_model() { t::set_rotation_stored_in_box_model(); }
    #[test] fn z_index_of_single_frame_is_zero() { t::z_index_of_single_frame_is_zero(); }
    #[test] fn move_up_increases_z_index() { t::move_up_increases_z_index(); }
    #[test] fn select_all_selects_every_face() { t::select_all_selects_every_face(); }
    #[test] fn selecting_a_seg_clears_face_selection() { t::selecting_a_seg_clears_face_selection(); }
    #[test] fn selecting_a_face_clears_seg_selection() { t::selecting_a_face_clears_seg_selection(); }
    #[test] fn select_faces_in_rect_finds_covered_frames() { t::select_faces_in_rect_finds_covered_frames(); }
    #[test] fn snap_within_radius_aligns_to_existing_divider() { t::snap_within_radius_aligns_to_existing_divider(); }
    #[test] fn snap_outside_radius_returns_original_value() { t::snap_outside_radius_returns_original_value(); }
    #[test] fn snap_excludes_the_dragged_chain() { t::snap_excludes_the_dragged_chain(); }
    #[test] fn edge_panel_drag_creates_new_split() { t::edge_panel_drag_creates_new_split(); }
    #[test] fn edge_panel_drag_cancel_reverts_layout() { t::edge_panel_drag_cancel_reverts_layout(); }
    #[test] fn boundary_edge_cannot_be_deleted() { t::boundary_edge_cannot_be_deleted(); }
    #[test] fn delete_selected_face() { t::delete_selected_face(); }
    #[test] fn save_and_load_roundtrip() { t::save_and_load_roundtrip(); }
    #[test] fn load_state_rejects_future_schema_version() { t::load_state_rejects_future_schema_version(); }
}
