/// Integration-level tests for the photobook editor API.

#[cfg(test)]
mod tests {
    use crate::PhotobookEditor;
    use crate::grid_layout::OUTER_FACE;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn ed() -> PhotobookEditor {
        // Reset the current spread to a single face so tests that count faces start
        // from a known baseline (Spread::new pre-splits into 2, which would break
        // assertions like "split produces 2 faces").
        let mut e = PhotobookEditor::new(210.0, 297.0, 0.0);
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

    #[test]
    fn split_h_produces_two_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        let ok = ed.split_face_at(f, "h", 0.5);
        assert!(ok, "split_face_at should succeed on a valid face");
        assert_eq!(face_count(&ed), 2);
    }

    #[test]
    fn split_into_n_produces_n_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        let ok = ed.split_face_into_n(f, "h", 4);
        assert!(ok);
        assert_eq!(face_count(&ed), 4);
    }

    #[test]
    fn split_into_quadrant_produces_four_frames() {
        let mut ed = ed();
        let f = first_face(&ed);
        let ok = ed.split_face_into_quadrant_n(f, 2);
        assert!(ok);
        assert_eq!(face_count(&ed), 4);
    }

    #[test]
    fn split_at_noncenter_ratio_creates_unequal_frames() {
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

    #[test]
    fn split_invalid_id_returns_false() {
        let mut ed = ed();
        let ok = ed.split_face_at(99999, "h", 0.5);
        assert!(!ok, "split on unknown id should return false");
        assert_eq!(face_count(&ed), 1);
    }

    // -----------------------------------------------------------------------
    // Merging frames
    // -----------------------------------------------------------------------

    #[test]
    fn delete_interior_divider_merges_frames() {
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

    #[test]
    fn delete_with_no_selection_does_nothing() {
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

    #[test]
    fn divider_gap_defaults_to_zero() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        assert!((ed.get_selected_segment_gap() - 0.0).abs() < 1e-4);
    }

    #[test]
    fn set_and_get_divider_gap() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        ed.set_selected_segment_gap(5.0);
        assert!((ed.get_selected_segment_gap() - 5.0).abs() < 1e-4);
    }

    #[test]
    fn divider_gap_clamped_to_nonnegative() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.split_face_at(f, "h", 0.5);
        let eid = any_interior_edge(&ed).unwrap();
        ed.select_segment(eid);
        ed.set_selected_segment_gap(-3.0);
        assert!((ed.get_selected_segment_gap() - 0.0).abs() < 1e-4);
    }

    #[test]
    fn get_selected_segment_gap_without_selection_returns_zero() {
        let ed = ed();
        assert!((ed.get_selected_segment_gap() - 0.0).abs() < 1e-4);
    }

    #[test]
    fn divider_gap_reflected_in_half_gap() {
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

    #[test]
    fn set_margin_stored_in_box_model() {
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

    #[test]
    fn set_border_width_stored_in_box_model() {
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

    #[test]
    fn set_rotation_stored_in_box_model() {
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

    #[test]
    fn z_index_of_single_frame_is_zero() {
        let ed = ed();
        let f = first_face(&ed);
        assert_eq!(ed.get_face_z_index(f), 0);
    }

    #[test]
    fn move_up_increases_z_index() {
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

    #[test]
    fn select_all_selects_every_face() {
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

    #[test]
    fn selecting_a_seg_clears_face_selection() {
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

    #[test]
    fn selecting_a_face_clears_seg_selection() {
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

    #[test]
    fn select_faces_in_rect_finds_covered_frames() {
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

    #[test]
    fn snap_within_radius_aligns_to_existing_divider() {
        use crate::grid_layout::GridLayout;
        use crate::layout::SplitAxis;
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();

        let snapped = layout.snap(SplitAxis::Horizontal, 0.53, &[], 0.05);
        assert!((snapped - 0.5).abs() < 1e-4,
            "snap should return 0.5 for input 0.53 with radius 0.05, got {snapped}");
    }

    #[test]
    fn snap_outside_radius_returns_original_value() {
        use crate::grid_layout::GridLayout;
        use crate::layout::SplitAxis;
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, crate::layout::SplitAxis::Horizontal).unwrap();

        let snapped = layout.snap(SplitAxis::Horizontal, 0.8, &[], 0.05);
        assert!((snapped - 0.8).abs() < 1e-4,
            "snap should return original value when outside radius, got {snapped}");
    }

    #[test]
    fn snap_excludes_the_dragged_chain() {
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

    #[test]
    fn edge_panel_drag_creates_new_split() {
        let mut ed = ed();
        assert_eq!(face_count(&ed), 1);

        let rep_id = ed.begin_edge_panel_drag("h", false, 500.0, 250.0, 1000.0, 500.0);
        assert_ne!(rep_id, OUTER_FACE);
        assert_eq!(face_count(&ed), 2);

        ed.end_edge_panel_drag();
        assert_eq!(face_count(&ed), 2);
    }

    #[test]
    fn edge_panel_drag_cancel_reverts_layout() {
        let mut ed = ed();
        ed.begin_edge_panel_drag("v", false, 300.0, 250.0, 1000.0, 500.0);
        assert_eq!(face_count(&ed), 2);

        ed.cancel_edge_panel_drag();
        assert_eq!(face_count(&ed), 1);
    }

    // -----------------------------------------------------------------------
    // Boundary edge protection
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_edge_cannot_be_deleted() {
        let mut ed = ed();
        let beid = boundary_edge(&ed);
        ed.select_segment(beid);
        // can_delete_segment returns false for boundary
        assert!(!ed.can_delete_segment(beid));
    }

    #[test]
    fn delete_selected_face() {
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

    #[test]
    fn save_and_load_roundtrip() {
        let mut orig = ed();
        orig.add_page();
        let json = orig.save_state();
        let mut ed2 = ed();
        assert!(ed2.load_state(&json));
        assert_eq!(ed2.doc.spreads.len(), orig.doc.spreads.len());
    }

    #[test]
    fn load_state_rejects_future_schema_version() {
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

    // -----------------------------------------------------------------------
    // Image assignment and transform
    // -----------------------------------------------------------------------

    #[test]
    fn assign_image_sets_id_and_resets_transform() {
        let mut ed = ed();
        let f = first_face(&ed);
        // Set a non-default transform first to confirm it gets reset.
        ed.set_image_transform(f, 0.2, 0.8, 2.0, 45.0);
        ed.assign_image(f, "photo-001.jpg");
        let face = &ed.doc.current_spread().layout.faces[&f];
        assert_eq!(face.image.image_id.as_deref(), Some("photo-001.jpg"));
        assert!((face.image.pan_x - 0.5).abs() < 1e-5, "pan_x should reset to 0.5");
        assert!((face.image.pan_y - 0.5).abs() < 1e-5, "pan_y should reset to 0.5");
        assert!((face.image.scale - 1.0).abs() < 1e-5, "scale should reset to 1.0");
        assert!((face.image.rotation_deg).abs() < 1e-5, "rotation should reset to 0.0");
    }

    #[test]
    fn swap_images_exchanges_ids() {
        let mut ed = ed();
        let f0 = first_face(&ed);
        ed.split_face_at(f0, "v", 0.5);
        let f1 = *ed.doc.current_spread().layout.faces.keys()
            .find(|&&id| id != f0).unwrap();
        ed.assign_image(f0, "img-a.jpg");
        ed.assign_image(f1, "img-b.jpg");
        ed.swap_images(f0, f1);
        let layout = &ed.doc.current_spread().layout;
        assert_eq!(layout.faces[&f0].image.image_id.as_deref(), Some("img-b.jpg"));
        assert_eq!(layout.faces[&f1].image.image_id.as_deref(), Some("img-a.jpg"));
    }

    #[test]
    fn swap_same_face_is_noop() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.assign_image(f, "img-a.jpg");
        ed.swap_images(f, f);
        assert_eq!(
            ed.doc.current_spread().layout.faces[&f].image.image_id.as_deref(),
            Some("img-a.jpg"),
        );
    }

    // -----------------------------------------------------------------------
    // Multi-image drop split
    // -----------------------------------------------------------------------

    #[test]
    fn multi_drop_count_1_returns_original_face_unchanged() {
        let mut ed = ed();
        let f = first_face(&ed);
        let result: Vec<u32> =
            serde_json::from_str(&ed.split_face_for_multi_drop(f, 1, true)).unwrap();
        assert_eq!(result, vec![f]);
        assert_eq!(face_count(&ed), 1, "count=1 should not split");
    }

    #[test]
    fn multi_drop_count_2_produces_two_faces() {
        let mut ed = ed();
        let f = first_face(&ed);
        let result: Vec<u32> =
            serde_json::from_str(&ed.split_face_for_multi_drop(f, 2, true)).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(face_count(&ed), 2);
    }

    #[test]
    fn multi_drop_count_4_produces_four_faces() {
        let mut ed = ed();
        let f = first_face(&ed);
        let result: Vec<u32> =
            serde_json::from_str(&ed.split_face_for_multi_drop(f, 4, true)).unwrap();
        assert_eq!(result.len(), 4);
        assert_eq!(face_count(&ed), 4);
    }

    #[test]
    fn multi_drop_count_3_produces_three_faces() {
        let mut ed = ed();
        let f = first_face(&ed);
        let result: Vec<u32> =
            serde_json::from_str(&ed.split_face_for_multi_drop(f, 3, false)).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(face_count(&ed), 3);
    }

    #[test]
    fn multi_drop_returned_ids_are_all_unique() {
        let mut ed = ed();
        let f = first_face(&ed);
        let result: Vec<u32> =
            serde_json::from_str(&ed.split_face_for_multi_drop(f, 4, true)).unwrap();
        let unique: std::collections::HashSet<u32> = result.iter().copied().collect();
        assert_eq!(unique.len(), result.len(), "all returned face IDs must be distinct");
    }

    // -----------------------------------------------------------------------
    // Low-DPI frame detection
    // -----------------------------------------------------------------------

    // 210 mm page → spread = 420 mm wide; canvas_w=4200, canvas_h=2970 → mm_to_px=10
    fn canvas() -> (f32, f32) { (4200.0, 2970.0) }

    #[test]
    fn low_dpi_empty_when_no_image_assigned() {
        let mut ed = ed();
        let (cw, ch) = canvas();
        let result: serde_json::Value =
            serde_json::from_str(&ed.get_low_dpi_frames(cw, ch)).unwrap();
        assert_eq!(result.as_array().unwrap().len(), 0);
    }

    #[test]
    fn low_dpi_flags_tiny_image_in_full_spread_frame() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.assign_image(f, "tiny.jpg");
        ed.register_image_size("tiny.jpg", 100, 100); // 100×100 px is far too small
        let (cw, ch) = canvas();

        #[derive(serde::Deserialize)] struct Frame { id: u32, effective_dpi: u32 }
        let result: Vec<Frame> =
            serde_json::from_str(&ed.get_low_dpi_frames(cw, ch)).unwrap();
        assert!(!result.is_empty(), "100×100 px image should be flagged");
        assert_eq!(result[0].id, f);
        assert!(result[0].effective_dpi < 300);
    }

    #[test]
    fn low_dpi_does_not_flag_adequate_image() {
        let mut ed = ed();
        let f = first_face(&ed);
        ed.assign_image(f, "hires.jpg");
        // 5000×3600 px at the print frame size exceeds 300 DPI.
        ed.register_image_size("hires.jpg", 5000, 3600);
        let (cw, ch) = canvas();
        let result: serde_json::Value =
            serde_json::from_str(&ed.get_low_dpi_frames(cw, ch)).unwrap();
        assert_eq!(
            result.as_array().unwrap().len(), 0,
            "adequate-resolution image must not be flagged"
        );
    }
}
