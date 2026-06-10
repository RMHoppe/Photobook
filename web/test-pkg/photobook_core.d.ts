/* tslint:disable */
/* eslint-disable */

export class PhotobookEditor {
    free(): void;
    [Symbol.dispose](): void;
    add_page(): void;
    /**
     * Add a new text element at (x_mm, y_mm) on the current spread.
     * Returns the new element's unique ID.
     */
    add_text_element(x_mm: number, y_mm: number): number;
    assign_image(node_id: number, image_id: string): void;
    /**
     * Begin a drag of a divider chain.
     *
     * When `full_chain` is true the entire connected chain at the same offset is
     * moved together. When false only the selected twin pair (two edges) is moved,
     * which breaks the chain at its endpoints on the first mouse movement.
     */
    begin_divider_drag(edge_id: number, full_chain: boolean, canvas_w: number, canvas_h: number): void;
    begin_edge_panel_drag(axis: string, new_is_first: boolean, mouse_x: number, mouse_y: number, canvas_w: number, canvas_h: number): number;
    /**
     * Prepare for a pinwheel spawn from the given X-junction.
     */
    begin_pinwheel_spawn(tl_id: number, tr_id: number, bl_id: number, br_id: number, junction_nx: number, junction_ny: number): void;
    /**
     * Returns true if the edge can be deleted (interior, non-boundary).
     */
    can_delete_segment(segment_id: number): boolean;
    can_redo(): boolean;
    can_undo(): boolean;
    cancel_edge_panel_drag(): void;
    /**
     * Abort the spawn, restoring the original layout.
     */
    cancel_pinwheel_spawn(): void;
    /**
     * Zero out the half_gap on every edge belonging to a selected face.
     */
    clear_selection_gaps(): void;
    /**
     * Delete an edge (twin pair) by ID. Returns true on success.
     */
    delete_segment(segment_id: number): boolean;
    /**
     * Delete all currently selected faces.
     * Pinwheel centre faces are dissolved (restoring the X-junction) rather than deleted.
     */
    delete_selected(): boolean;
    /**
     * Delete all currently selected segments.
     */
    delete_selected_segment(): boolean;
    /**
     * Delete the text element with `id` from the current spread.
     */
    delete_text_element(id: number): void;
    /**
     * Redistribute interior vertical dividers so all columns have equal width.
     */
    distribute_selection_h(): void;
    /**
     * Redistribute interior horizontal dividers so all rows have equal height.
     */
    distribute_selection_v(): void;
    end_divider_drag(canvas_w: number, canvas_h: number): void;
    end_edge_panel_drag(): void;
    /**
     * Confirm the current spawn.
     */
    end_pinwheel_spawn(): void;
    export_pdf(images_json: string, fonts_json: string): Uint8Array;
    /**
     * Mirror selected faces left ↔ right within their bounding box.
     */
    flip_selection_h(): void;
    /**
     * Mirror selected faces top ↔ bottom within their bounding box.
     */
    flip_selection_v(): void;
    get_all_selected(): string;
    get_bleed_mm(): number;
    get_box_model(): string;
    /**
     * Returns `{a, b, axis}` where `a` = Facing::End side (left/top of the
     * visual gap) and `b` = Facing::Start side (right/bottom of the gap).
     * Either value is JSON `null` when the segments in the chain disagree.
     */
    get_chain_half_gaps(edge_id: number): string;
    get_current_spread_index(): number;
    get_current_spread_info(): string;
    get_debug_layout_dump(): string;
    get_dirty_spread_indices(): string;
    get_dividers(canvas_w: number, canvas_h: number): string;
    /**
     * Returns `{a, b, axis}` for a specific edge and its twin only — no chain expansion.
     * Used when a single twin pair is selected via its handle.
     */
    get_edge_pair_half_gaps(edge_id: number): string;
    get_endpapers(): boolean;
    get_face_box_model(): string;
    get_face_z_index(id: number): number;
    get_frame_transform(face_id: number): string;
    get_low_dpi_frames(canvas_w: number, canvas_h: number): string;
    get_margin_step_mm(): number;
    get_page_size_mm(): string;
    /**
     * Return the pinwheel centre face IDs as a JSON array.
     */
    get_pinwheel_centers(): string;
    get_print_dpi(): number;
    get_render_list(canvas_w: number, canvas_h: number): string;
    get_resolved_spread_delta(canvas_w: number, canvas_h: number): string;
    get_safe_zone_mm(): number;
    get_selected(): number;
    /**
     * Returns the first selected segment ID, or OUTER_FACE if none.
     */
    get_selected_segment(): number;
    get_selected_segment_count(): number;
    /**
     * Returns `{a, b, axis}` for the first selected divider chain.
     * `a` = Facing::End side (left for vertical, top for horizontal).
     * `b` = Facing::Start side (right for vertical, bottom for horizontal).
     */
    get_selected_segment_half_gaps(): string;
    get_selected_transform_handles(canvas_w: number, canvas_h: number): string;
    get_selection_count(): number;
    /**
     * Returns `{h, v}` — current half_gap on the inner edges of the selection.
     * `h` = half_gap on Vertical inner edges (gap between side-by-side frames).
     * `v` = half_gap on Horizontal inner edges (gap between stacked frames).
     * `null` means no inner edges of that orientation exist, or values are mixed.
     */
    get_selection_inner_gaps(): string;
    /**
     * Returns `{top, right, bottom, left}` for the outer edges of the current
     * frame selection. An edge is "outer" if it borders a non-selected face or
     * the spread boundary. `null` in any slot means the outer edges on that
     * axis have mixed values.
     */
    get_selection_outer_margins(): string;
    get_spine_min_mm(): number;
    get_spine_mm_per_page(): number;
    get_spread_count(): number;
    get_spread_left_bg(): string;
    get_spread_right_bg(): string;
    get_spreads_info(): string;
    /**
     * Return JSON array of all text elements on the current spread.
     */
    get_text_elements(): string;
    get_thumbnail_data(spread_idx: number, thumb_w: number, thumb_h: number): string;
    get_transform_box_model(): string;
    /**
     * Returns a JSON array of all image IDs that are assigned to at least one
     * face across all spreads in the document.
     */
    get_used_image_ids(): string;
    /**
     * Return all X-junctions as a JSON array of
     * `{nx, ny, tl_id, tr_id, bl_id, br_id}` (normalised spread coords).
     */
    get_xjunctions(): string;
    hit_test(x: number, y: number, canvas_w: number, canvas_h: number): number;
    hovered_divider(canvas_w: number, canvas_h: number): number;
    is_segment_selected(segment_id: number): boolean;
    is_selected(id: number): boolean;
    load_state(json: string): boolean;
    move_face_z_order(id: number, direction: string): void;
    move_spread(from_idx: number, to_idx: number): void;
    /**
     * Quick position update for a text element (used during drag, avoids full JSON round-trip).
     */
    move_text_element(id: number, x_mm: number, y_mm: number): void;
    /**
     * Move selection to the neighbour in `direction` (up/down/left/right).
     */
    navigate(direction: string): void;
    constructor(page_width_mm: number, page_height_mm: number, bleed_mm: number);
    /**
     * Phase 1 of the staged export. Decodes images/fonts and pre-allocates
     * one PDF page per spread. Returns the total spread count so the caller
     * can loop over `pdf_export_spread`. Returns 0 on failure.
     */
    pdf_export_begin(images_json: string, fonts_json: string): number;
    /**
     * Phase 1 of the staged export using pre-staged raw bytes (no base64/JSON overhead).
     * Consumes the staging buffers. Returns the total spread count, 0 on failure.
     */
    pdf_export_begin_v2(): number;
    /**
     * Phase 3 of the staged export. Serialises and returns the finished PDF,
     * then clears the internal state.
     */
    pdf_export_finish(): Uint8Array;
    /**
     * Phase 2 of the staged export. Renders one spread into the PDF.
     * Call this `total` times (the value returned by `pdf_export_begin`).
     * Returns a JSON string with per-phase timing data for profiling.
     */
    pdf_export_spread(): string;
    /**
     * Stage raw font bytes for the next `pdf_export_begin_v2` call.
     */
    pdf_stage_font(family: string, bold: boolean, italic: boolean, bytes: Uint8Array): void;
    /**
     * Stage raw image bytes for the next `pdf_export_begin_v2` call.
     * The bytes are the original encoded file (JPEG, PNG, …); no base64 needed.
     */
    pdf_stage_image(id: string, bytes: Uint8Array): void;
    redo(): boolean;
    register_image_size(image_id: string, width_px: number, height_px: number): void;
    remove_page(spread_idx: number): void;
    reset_undo(): void;
    /**
     * Rotate selected faces 90° counter-clockwise within their bounding box.
     *
     * Normalized transform: (nx, ny) → (ny, 1−nx).
     * V at nx → H at ny=1−nx          (facing flipped)
     * H at ny → V at nx=ny            (facing unchanged)
     * Face wiring: left←top, top←right, right←bottom, bottom←left
     */
    rotate_selection_ccw(): void;
    /**
     * Rotate selected faces 90° clockwise within their bounding box.
     *
     * Normalized transform: (nx, ny) → (1−ny, nx).
     * V at nx → H at ny=nx            (facing unchanged)
     * H at ny → V at nx=1−ny          (facing flipped)
     * Face wiring: left←bottom, top←left, right←top, bottom←right
     */
    rotate_selection_cw(): void;
    save_state(): string;
    /**
     * Select all faces and all interior edges in the current spread.
     */
    select_all(): void;
    select_all_in_rect(rx: number, ry: number, rw: number, rh: number, canvas_w: number, canvas_h: number): void;
    /**
     * Replace the face selection with a single face (or clear if OUTER_FACE).
     * Also clears segment selection (plain-click behaviour).
     */
    select_face(id: number): void;
    select_faces_in_rect(rx: number, ry: number, rw: number, rh: number, canvas_w: number, canvas_h: number): void;
    /**
     * Replace the segment selection with a single edge, clearing face selection.
     * Passing OUTER_FACE clears segment selection only.
     */
    select_segment(segment_id: number): void;
    /**
     * Returns true if ≥2 selected faces tile a complete rectangle (no gaps).
     */
    selection_is_rectangular(): boolean;
    set_box_model(json: string): void;
    /**
     * Set half_gap on the Facing::End edges of the chain (left/top side of gap).
     */
    set_chain_half_gap_a(edge_id: number, v: number): void;
    /**
     * Set half_gap on the Facing::Start edges of the chain (right/bottom side of gap).
     */
    set_chain_half_gap_b(edge_id: number, v: number): void;
    set_current_spread(spread_idx: number): void;
    set_endpapers(enabled: boolean): void;
    set_face_box_model(json: string): void;
    set_face_box_model_field(face_id: number, field: string, value: number): void;
    set_face_frame_rotation(face_id: number, rotation_deg: number): void;
    set_face_rotation_deg(deg: number): void;
    set_image_transform(node_id: number, pan_x: number, pan_y: number, scale: number, rotation_deg: number, flip_h: boolean, flip_v: boolean): void;
    set_mouse_pos(x: number, y: number): void;
    set_node_margin(top: number, right: number, bottom: number, left: number): void;
    set_page_settings(width_mm: number, height_mm: number, bleed_mm: number, safe_zone_mm: number, spine_mm_per_page: number, spine_min_mm: number, margin_step_mm: number, print_dpi: number): void;
    /**
     * Set half_gap on the Facing::End (left/top) side of all selected chains.
     */
    set_selected_segment_half_gap_a(v: number): void;
    /**
     * Set half_gap on the Facing::Start (right/bottom) side of all selected chains.
     */
    set_selected_segment_half_gap_b(v: number): void;
    /**
     * Set half_gap on all inner edges of the current selection.
     * `json` = `{h?: number|null, v?: number|null}`.
     * `h` applies to Vertical inner edges; `v` applies to Horizontal inner edges.
     * `null` fields are skipped.
     */
    set_selection_inner_gaps(json: string): void;
    /**
     * Set the half-gap on the outer edges of the current frame selection.
     * Outer edges are those bordering a non-selected face or the spread boundary.
     * `null` fields in the JSON are skipped.
     *
     * After applying outer-edge margins, a second pass adjusts concave corners:
     * if a selected frame has a corner where BOTH edges are interior (facing other
     * selected frames), and those adjacent frames each have an outer edge on the same
     * side at that vertex, the inner frame shrinks and the outer frames expand so the
     * gap wraps cleanly around the corner without gaps or overlaps.
     */
    set_selection_outer_margins(json: string): void;
    set_snap_disabled(disabled: boolean): void;
    set_spread_left_bg(color: string): void;
    set_spread_right_bg(color: string): void;
    /**
     * Push the current document onto the undo stack and clear redo.
     */
    snapshot_undo(): void;
    split_axis_hint(canvas_w: number, canvas_h: number): string;
    split_axis_hint_for(id: number, canvas_w: number, canvas_h: number): string;
    split_face_at(id: number, axis: string, ratio: number): boolean;
    /**
     * Split `face_id` into `count` leaf faces using recursive binary halving with
     * alternating axes, then return the leaf face IDs as a JSON array in traversal
     * order (first half before second half at each level).
     *
     * `prefer_vertical` selects the axis of the first cut:
     *   true  → vertical (left / right)
     *   false → horizontal (top / bottom)
     *
     * Subsequent levels alternate the axis automatically.
     */
    split_face_for_multi_drop(face_id: number, count: number, prefer_vertical: boolean): string;
    split_face_into_n(id: number, axis: string, n: number): boolean;
    split_face_into_quadrant_n(id: number, n: number): boolean;
    swap_images(node_a: number, node_b: number): void;
    toggle_all_in_rect(rx: number, ry: number, rw: number, rh: number, canvas_w: number, canvas_h: number): void;
    toggle_faces_in_rect(rx: number, ry: number, rw: number, rh: number, canvas_w: number, canvas_h: number): void;
    /**
     * Toggle a segment in/out of the selection without touching face selection.
     * (cmd/ctrl-click behaviour.)
     */
    toggle_segment(segment_id: number): void;
    /**
     * Toggle a face in/out of the selection without touching segment selection.
     * (cmd/ctrl-click behaviour.)
     */
    toggle_selection(id: number): void;
    undo(): boolean;
    update_divider_drag(mouse_x: number, mouse_y: number, canvas_w: number, canvas_h: number): void;
    update_edge_panel_drag(mouse_x: number, mouse_y: number, canvas_w: number, canvas_h: number): void;
    /**
     * Update the live spawn preview with the current mouse position (normalised).
     */
    update_pinwheel_spawn(mouse_nx: number, mouse_ny: number): void;
    /**
     * Update a text element by full replacement (matched by id field in JSON).
     */
    update_text_element(json: string): void;
}

export function compute_image_cover(frame_w: number, frame_h: number, img_w: number, img_h: number, pan_x: number, pan_y: number, user_scale: number, rotation_deg: number): string;

export function init_panic_hook(): void;

export function wasm_test_list(): string;

export function wasm_test_run(name: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_photobookeditor_free: (a: number, b: number) => void;
    readonly compute_image_cover: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly init_panic_hook: () => void;
    readonly photobookeditor_add_page: (a: number) => void;
    readonly photobookeditor_add_text_element: (a: number, b: number, c: number) => number;
    readonly photobookeditor_assign_image: (a: number, b: number, c: number, d: number) => void;
    readonly photobookeditor_begin_divider_drag: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_begin_edge_panel_drag: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly photobookeditor_begin_pinwheel_spawn: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly photobookeditor_can_delete_segment: (a: number, b: number) => number;
    readonly photobookeditor_can_redo: (a: number) => number;
    readonly photobookeditor_can_undo: (a: number) => number;
    readonly photobookeditor_cancel_edge_panel_drag: (a: number) => void;
    readonly photobookeditor_cancel_pinwheel_spawn: (a: number) => void;
    readonly photobookeditor_clear_selection_gaps: (a: number) => void;
    readonly photobookeditor_delete_segment: (a: number, b: number) => number;
    readonly photobookeditor_delete_selected: (a: number) => number;
    readonly photobookeditor_delete_selected_segment: (a: number) => number;
    readonly photobookeditor_delete_text_element: (a: number, b: number) => void;
    readonly photobookeditor_distribute_selection_h: (a: number) => void;
    readonly photobookeditor_distribute_selection_v: (a: number) => void;
    readonly photobookeditor_end_divider_drag: (a: number, b: number, c: number) => void;
    readonly photobookeditor_end_edge_panel_drag: (a: number) => void;
    readonly photobookeditor_end_pinwheel_spawn: (a: number) => void;
    readonly photobookeditor_export_pdf: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly photobookeditor_flip_selection_h: (a: number) => void;
    readonly photobookeditor_flip_selection_v: (a: number) => void;
    readonly photobookeditor_get_all_selected: (a: number) => [number, number];
    readonly photobookeditor_get_bleed_mm: (a: number) => number;
    readonly photobookeditor_get_box_model: (a: number) => [number, number];
    readonly photobookeditor_get_chain_half_gaps: (a: number, b: number) => [number, number];
    readonly photobookeditor_get_current_spread_index: (a: number) => number;
    readonly photobookeditor_get_current_spread_info: (a: number) => [number, number];
    readonly photobookeditor_get_debug_layout_dump: (a: number) => [number, number];
    readonly photobookeditor_get_dirty_spread_indices: (a: number) => [number, number];
    readonly photobookeditor_get_dividers: (a: number, b: number, c: number) => [number, number];
    readonly photobookeditor_get_edge_pair_half_gaps: (a: number, b: number) => [number, number];
    readonly photobookeditor_get_endpapers: (a: number) => number;
    readonly photobookeditor_get_face_z_index: (a: number, b: number) => number;
    readonly photobookeditor_get_frame_transform: (a: number, b: number) => [number, number];
    readonly photobookeditor_get_low_dpi_frames: (a: number, b: number, c: number) => [number, number];
    readonly photobookeditor_get_margin_step_mm: (a: number) => number;
    readonly photobookeditor_get_page_size_mm: (a: number) => [number, number];
    readonly photobookeditor_get_pinwheel_centers: (a: number) => [number, number];
    readonly photobookeditor_get_print_dpi: (a: number) => number;
    readonly photobookeditor_get_render_list: (a: number, b: number, c: number) => [number, number];
    readonly photobookeditor_get_resolved_spread_delta: (a: number, b: number, c: number) => [number, number];
    readonly photobookeditor_get_safe_zone_mm: (a: number) => number;
    readonly photobookeditor_get_selected: (a: number) => number;
    readonly photobookeditor_get_selected_segment: (a: number) => number;
    readonly photobookeditor_get_selected_segment_count: (a: number) => number;
    readonly photobookeditor_get_selected_segment_half_gaps: (a: number) => [number, number];
    readonly photobookeditor_get_selected_transform_handles: (a: number, b: number, c: number) => [number, number];
    readonly photobookeditor_get_selection_count: (a: number) => number;
    readonly photobookeditor_get_selection_inner_gaps: (a: number) => [number, number];
    readonly photobookeditor_get_selection_outer_margins: (a: number) => [number, number];
    readonly photobookeditor_get_spine_min_mm: (a: number) => number;
    readonly photobookeditor_get_spine_mm_per_page: (a: number) => number;
    readonly photobookeditor_get_spread_count: (a: number) => number;
    readonly photobookeditor_get_spread_left_bg: (a: number) => [number, number];
    readonly photobookeditor_get_spread_right_bg: (a: number) => [number, number];
    readonly photobookeditor_get_spreads_info: (a: number) => [number, number];
    readonly photobookeditor_get_text_elements: (a: number) => [number, number];
    readonly photobookeditor_get_thumbnail_data: (a: number, b: number, c: number, d: number) => [number, number];
    readonly photobookeditor_get_transform_box_model: (a: number) => [number, number];
    readonly photobookeditor_get_used_image_ids: (a: number) => [number, number];
    readonly photobookeditor_get_xjunctions: (a: number) => [number, number];
    readonly photobookeditor_hit_test: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly photobookeditor_hovered_divider: (a: number, b: number, c: number) => number;
    readonly photobookeditor_is_segment_selected: (a: number, b: number) => number;
    readonly photobookeditor_is_selected: (a: number, b: number) => number;
    readonly photobookeditor_load_state: (a: number, b: number, c: number) => number;
    readonly photobookeditor_move_face_z_order: (a: number, b: number, c: number, d: number) => void;
    readonly photobookeditor_move_spread: (a: number, b: number, c: number) => void;
    readonly photobookeditor_move_text_element: (a: number, b: number, c: number, d: number) => void;
    readonly photobookeditor_navigate: (a: number, b: number, c: number) => void;
    readonly photobookeditor_new: (a: number, b: number, c: number) => number;
    readonly photobookeditor_pdf_export_begin: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly photobookeditor_pdf_export_begin_v2: (a: number) => number;
    readonly photobookeditor_pdf_export_finish: (a: number) => [number, number];
    readonly photobookeditor_pdf_export_spread: (a: number) => [number, number];
    readonly photobookeditor_pdf_stage_font: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly photobookeditor_pdf_stage_image: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_redo: (a: number) => number;
    readonly photobookeditor_register_image_size: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_remove_page: (a: number, b: number) => void;
    readonly photobookeditor_reset_undo: (a: number) => void;
    readonly photobookeditor_rotate_selection_ccw: (a: number) => void;
    readonly photobookeditor_rotate_selection_cw: (a: number) => void;
    readonly photobookeditor_save_state: (a: number) => [number, number];
    readonly photobookeditor_select_all: (a: number) => void;
    readonly photobookeditor_select_all_in_rect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly photobookeditor_select_face: (a: number, b: number) => void;
    readonly photobookeditor_select_faces_in_rect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly photobookeditor_select_segment: (a: number, b: number) => void;
    readonly photobookeditor_selection_is_rectangular: (a: number) => number;
    readonly photobookeditor_set_box_model: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_chain_half_gap_a: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_chain_half_gap_b: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_current_spread: (a: number, b: number) => void;
    readonly photobookeditor_set_endpapers: (a: number, b: number) => void;
    readonly photobookeditor_set_face_box_model: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_face_box_model_field: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_set_face_frame_rotation: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_face_rotation_deg: (a: number, b: number) => void;
    readonly photobookeditor_set_image_transform: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly photobookeditor_set_mouse_pos: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_node_margin: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_set_page_settings: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly photobookeditor_set_selected_segment_half_gap_a: (a: number, b: number) => void;
    readonly photobookeditor_set_selected_segment_half_gap_b: (a: number, b: number) => void;
    readonly photobookeditor_set_selection_inner_gaps: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_selection_outer_margins: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_snap_disabled: (a: number, b: number) => void;
    readonly photobookeditor_set_spread_left_bg: (a: number, b: number, c: number) => void;
    readonly photobookeditor_set_spread_right_bg: (a: number, b: number, c: number) => void;
    readonly photobookeditor_snapshot_undo: (a: number) => void;
    readonly photobookeditor_split_axis_hint: (a: number, b: number, c: number) => [number, number];
    readonly photobookeditor_split_axis_hint_for: (a: number, b: number, c: number, d: number) => [number, number];
    readonly photobookeditor_split_face_at: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly photobookeditor_split_face_for_multi_drop: (a: number, b: number, c: number, d: number) => [number, number];
    readonly photobookeditor_split_face_into_n: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly photobookeditor_split_face_into_quadrant_n: (a: number, b: number, c: number) => number;
    readonly photobookeditor_swap_images: (a: number, b: number, c: number) => void;
    readonly photobookeditor_toggle_all_in_rect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly photobookeditor_toggle_faces_in_rect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly photobookeditor_toggle_segment: (a: number, b: number) => void;
    readonly photobookeditor_toggle_selection: (a: number, b: number) => void;
    readonly photobookeditor_undo: (a: number) => number;
    readonly photobookeditor_update_divider_drag: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_update_edge_panel_drag: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly photobookeditor_update_pinwheel_spawn: (a: number, b: number, c: number) => void;
    readonly photobookeditor_update_text_element: (a: number, b: number, c: number) => void;
    readonly wasm_test_list: () => [number, number];
    readonly wasm_test_run: (a: number, b: number) => void;
    readonly photobookeditor_get_face_box_model: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
