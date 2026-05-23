// Exported only when building with --features wasm-test targeting wasm32.
// Each test is called individually; panics propagate as JS exceptions (via
// console_error_panic_hook::throw_str) which the JS runner catches per-test.
#![cfg(all(target_arch = "wasm32", feature = "wasm-test"))]

use wasm_bindgen::prelude::*;

const TEST_NAMES: &[&str] = &[
    // editor_tests
    "split_h_produces_two_frames",
    "split_into_n_produces_n_frames",
    "split_into_quadrant_produces_four_frames",
    "split_at_noncenter_ratio_creates_unequal_frames",
    "split_invalid_id_returns_false",
    "delete_interior_divider_merges_frames",
    "delete_with_no_selection_does_nothing",
    "divider_gap_defaults_to_zero",
    "set_and_get_divider_gap",
    "divider_gap_clamped_to_nonnegative",
    "get_selected_segment_gap_without_selection_returns_zero",
    "divider_gap_reflected_in_half_gap",
    "set_margin_stored_in_box_model",
    "set_border_width_stored_in_box_model",
    "set_rotation_stored_in_box_model",
    "z_index_of_single_frame_is_zero",
    "move_up_increases_z_index",
    "select_all_selects_every_face",
    "selecting_a_seg_clears_face_selection",
    "selecting_a_face_clears_seg_selection",
    "select_faces_in_rect_finds_covered_frames",
    "snap_within_radius_aligns_to_existing_divider",
    "snap_outside_radius_returns_original_value",
    "snap_excludes_the_dragged_chain",
    "edge_panel_drag_creates_new_split",
    "edge_panel_drag_cancel_reverts_layout",
    "boundary_edge_cannot_be_deleted",
    "delete_selected_face",
    "save_and_load_roundtrip",
    "load_state_rejects_future_schema_version",
    // grid_resolver tests
    "single_room_produces_one_frame",
    "h_split_produces_two_frames_and_one_divider",
    "gap_shrinks_frame_rect",
    // grid_layout tests
    "drag_bounds_lo_lt_hi_after_h_split",
    "drag_bounds_lo_lt_hi_after_v_split",
];

#[wasm_bindgen]
pub fn wasm_test_list() -> String {
    serde_json::to_string(TEST_NAMES).unwrap()
}

// Runs a single named test. Panics on failure — the caller (JS) wraps in try/catch.
#[wasm_bindgen]
pub fn wasm_test_run(name: &str) {
    // Ensure panics become catchable JS exceptions rather than trapping the instance.
    console_error_panic_hook::set_once();

    use crate::editor_tests::test_impls as et;
    use crate::grid_resolver::test_impls as grt;
    use crate::grid_layout::test_impls as glt;

    match name {
        "split_h_produces_two_frames"                       => et::split_h_produces_two_frames(),
        "split_into_n_produces_n_frames"                    => et::split_into_n_produces_n_frames(),
        "split_into_quadrant_produces_four_frames"          => et::split_into_quadrant_produces_four_frames(),
        "split_at_noncenter_ratio_creates_unequal_frames"   => et::split_at_noncenter_ratio_creates_unequal_frames(),
        "split_invalid_id_returns_false"                    => et::split_invalid_id_returns_false(),
        "delete_interior_divider_merges_frames"             => et::delete_interior_divider_merges_frames(),
        "delete_with_no_selection_does_nothing"             => et::delete_with_no_selection_does_nothing(),
        "divider_gap_defaults_to_zero"                      => et::divider_gap_defaults_to_zero(),
        "set_and_get_divider_gap"                           => et::set_and_get_divider_gap(),
        "divider_gap_clamped_to_nonnegative"                => et::divider_gap_clamped_to_nonnegative(),
        "get_selected_segment_gap_without_selection_returns_zero" => et::get_selected_segment_gap_without_selection_returns_zero(),
        "divider_gap_reflected_in_half_gap"                 => et::divider_gap_reflected_in_half_gap(),
        "set_margin_stored_in_box_model"                    => et::set_margin_stored_in_box_model(),
        "set_border_width_stored_in_box_model"              => et::set_border_width_stored_in_box_model(),
        "set_rotation_stored_in_box_model"                  => et::set_rotation_stored_in_box_model(),
        "z_index_of_single_frame_is_zero"                   => et::z_index_of_single_frame_is_zero(),
        "move_up_increases_z_index"                         => et::move_up_increases_z_index(),
        "select_all_selects_every_face"                     => et::select_all_selects_every_face(),
        "selecting_a_seg_clears_face_selection"             => et::selecting_a_seg_clears_face_selection(),
        "selecting_a_face_clears_seg_selection"             => et::selecting_a_face_clears_seg_selection(),
        "select_faces_in_rect_finds_covered_frames"         => et::select_faces_in_rect_finds_covered_frames(),
        "snap_within_radius_aligns_to_existing_divider"     => et::snap_within_radius_aligns_to_existing_divider(),
        "snap_outside_radius_returns_original_value"        => et::snap_outside_radius_returns_original_value(),
        "snap_excludes_the_dragged_chain"                   => et::snap_excludes_the_dragged_chain(),
        "edge_panel_drag_creates_new_split"                 => et::edge_panel_drag_creates_new_split(),
        "edge_panel_drag_cancel_reverts_layout"             => et::edge_panel_drag_cancel_reverts_layout(),
        "boundary_edge_cannot_be_deleted"                   => et::boundary_edge_cannot_be_deleted(),
        "delete_selected_face"                              => et::delete_selected_face(),
        "save_and_load_roundtrip"                           => et::save_and_load_roundtrip(),
        "load_state_rejects_future_schema_version"          => et::load_state_rejects_future_schema_version(),
        "single_room_produces_one_frame"                    => grt::single_room_produces_one_frame(),
        "h_split_produces_two_frames_and_one_divider"       => grt::h_split_produces_two_frames_and_one_divider(),
        "gap_shrinks_frame_rect"                            => grt::gap_shrinks_frame_rect(),
        "drag_bounds_lo_lt_hi_after_h_split"                => glt::drag_bounds_lo_lt_hi_after_h_split(),
        "drag_bounds_lo_lt_hi_after_v_split"                => glt::drag_bounds_lo_lt_hi_after_v_split(),
        _ => panic!("unknown test: {name}"),
    }
}
