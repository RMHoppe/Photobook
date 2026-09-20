// wasm-bridge.ts — Typed wrappers around the JSON-returning WASM methods.
//
// Every method on PhotobookEditor that returns a JSON string has a corresponding
// typed function here that calls JSON.parse and casts to the correct interface.
// Callers import from here instead of calling editor.get_xxx() + JSON.parse() directly,
// so a Rust field rename produces a TypeScript compile error rather than a silent undefined.

import { PhotobookEditor, compute_image_cover } from './pkg/photobook_core.js';
import type {
  SpreadInfo, SpreadSummary, PageSize, ExportSettings,
  PreflightRules, PreflightIssue,
  RenderFrame, Divider, LowDpiFrame, FrameImageInfo,
  BoxModel, FrameTransform,
  ImageCoverResult, TextElement,
  ResolvedSpread, SpreadDelta, XJunction, ChainHalfGaps, MultiDividerGaps,
  MarginInsets,
  InnerGaps,
  BoundaryGap,
  LayoutCopyResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Spread / page
// ---------------------------------------------------------------------------

export function getSpreadInfo(editor: PhotobookEditor): SpreadInfo {
  return JSON.parse(editor.get_current_spread_info()) as SpreadInfo;
}

export function getSpreadsInfo(editor: PhotobookEditor): SpreadSummary[] {
  return JSON.parse(editor.get_spreads_info()) as SpreadSummary[];
}

export function getPageSizeMm(editor: PhotobookEditor): PageSize {
  return JSON.parse(editor.get_page_size_mm()) as PageSize;
}

export function getExportSettings(editor: PhotobookEditor): ExportSettings {
  return JSON.parse(editor.get_export_settings()) as ExportSettings;
}

export function getPreflightReport(editor: PhotobookEditor, rules: PreflightRules): PreflightIssue[] {
  return JSON.parse(editor.get_preflight_report(JSON.stringify(rules))) as PreflightIssue[];
}


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function getRenderList(editor: PhotobookEditor, w: number, h: number): RenderFrame[] {
  return JSON.parse(editor.get_render_list(w, h)) as RenderFrame[];
}

export function getDividers(editor: PhotobookEditor, w: number, h: number): Divider[] {
  return JSON.parse(editor.get_dividers(w, h)) as Divider[];
}

export function getFrameImageInfo(editor: PhotobookEditor, faceId: number, w: number, h: number): FrameImageInfo | null {
  return JSON.parse(editor.get_frame_image_info(faceId, w, h)) as FrameImageInfo | null;
}

export function getLowDpiFrames(editor: PhotobookEditor, w: number, h: number): LowDpiFrame[] {
  return JSON.parse(editor.get_low_dpi_frames(w, h)) as LowDpiFrame[];
}

// ---------------------------------------------------------------------------
// Chain half-gaps (per-side)
// ---------------------------------------------------------------------------

export function getSelectedSegmentHalfGaps(editor: PhotobookEditor): MultiDividerGaps {
  return JSON.parse(editor.get_selected_segment_half_gaps()) as MultiDividerGaps;
}

export function setSelectedSegmentHalfGapAAxis(editor: PhotobookEditor, axis: 'h' | 'v', v: number): void {
  editor.set_selected_segment_half_gap_a_axis(axis, v);
}

export function setSelectedSegmentHalfGapBAxis(editor: PhotobookEditor, axis: 'h' | 'v', v: number): void {
  editor.set_selected_segment_half_gap_b_axis(axis, v);
}

export function getEdgePairHalfGaps(editor: PhotobookEditor, edgeId: number): ChainHalfGaps {
  return JSON.parse(editor.get_edge_pair_half_gaps(edgeId)) as ChainHalfGaps;
}

export function getBoundaryChainGap(editor: PhotobookEditor, edgeId: number): BoundaryGap {
  return JSON.parse(editor.get_boundary_chain_gap(edgeId)) as BoundaryGap;
}

export function setBoundaryChainGap(editor: PhotobookEditor, edgeId: number, v: number): void {
  editor.set_boundary_chain_gap(edgeId, v);
}

export function isSelectedSegmentBoundary(editor: PhotobookEditor): boolean {
  return editor.is_selected_segment_boundary();
}

// ---------------------------------------------------------------------------
// Box model / transform
// ---------------------------------------------------------------------------

export function getBoxModel(editor: PhotobookEditor): BoxModel {
  return JSON.parse(editor.get_box_model()) as BoxModel;
}

export function getFrameTransform(editor: PhotobookEditor, faceId: number): FrameTransform | null {
  return JSON.parse(editor.get_frame_transform(faceId)) as FrameTransform | null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function getAllSelected(editor: PhotobookEditor): number[] {
  return JSON.parse(editor.get_all_selected()) as number[];
}

export function copySelectedLayout(editor: PhotobookEditor): LayoutCopyResult {
  return JSON.parse(editor.copy_selected_layout()) as LayoutCopyResult;
}

export function getLayoutPasteError(editor: PhotobookEditor, clipboard: string): string {
  return editor.get_layout_paste_error(clipboard);
}

export function pasteLayout(editor: PhotobookEditor, clipboard: string): boolean {
  return editor.paste_layout(clipboard);
}

// ---------------------------------------------------------------------------
// Outer margin (selection-group perimeter)
// ---------------------------------------------------------------------------

export function getSelectionOuterMargins(editor: PhotobookEditor): MarginInsets {
  return JSON.parse(editor.get_selection_outer_margins()) as MarginInsets;
}

export function setSelectionOuterMargins(editor: PhotobookEditor, margins: MarginInsets): void {
  editor.set_selection_outer_margins(JSON.stringify(margins));
}

export function getInnerEdgeOffsets(editor: PhotobookEditor): string {
  return editor.get_inner_edge_offsets();
}

export function setSelectionOuterMarginsAndAdjust(
  editor: PhotobookEditor,
  margins: MarginInsets,
  originalOffsets: string,
  originalMargins: MarginInsets,
): void {
  editor.set_selection_outer_margins_and_adjust(JSON.stringify(margins), originalOffsets, JSON.stringify(originalMargins));
}

export function getSelectionInnerGaps(editor: PhotobookEditor): InnerGaps {
  return JSON.parse(editor.get_selection_inner_gaps()) as InnerGaps;
}

export function setSelectionInnerGaps(editor: PhotobookEditor, gaps: InnerGaps): void {
  editor.set_selection_inner_gaps(JSON.stringify(gaps));
}

export function clearSelectionGaps(editor: PhotobookEditor): void {
  editor.clear_selection_gaps();
}

export function selectionHasTransformations(editor: PhotobookEditor): boolean {
  return editor.selection_has_transformations();
}

// ---------------------------------------------------------------------------
// Text elements
// ---------------------------------------------------------------------------

export function getTextElements(editor: PhotobookEditor): TextElement[] {
  return JSON.parse(editor.get_text_elements()) as TextElement[];
}

export function addTextElement(editor: PhotobookEditor, x_mm: number, y_mm: number): number {
  return editor.add_text_element(x_mm, y_mm);
}

export function updateTextElement(editor: PhotobookEditor, el: TextElement): void {
  editor.update_text_element(JSON.stringify(el));
}

export function deleteTextElement(editor: PhotobookEditor, id: number): void {
  editor.delete_text_element(id);
}

export function moveTextElement(editor: PhotobookEditor, id: number, x_mm: number, y_mm: number): void {
  editor.move_text_element(id, x_mm, y_mm);
}

// ---------------------------------------------------------------------------
// Incremental rendering — delta protocol
// ---------------------------------------------------------------------------

export function getResolvedSpreadDelta(editor: PhotobookEditor, w: number, h: number): SpreadDelta {
  return JSON.parse(editor.get_resolved_spread_delta(w, h)) as SpreadDelta;
}

export function getThumbnailData(editor: PhotobookEditor, spreadIdx: number, w: number, h: number): RenderFrame[] {
  return JSON.parse(editor.get_thumbnail_data(spreadIdx, w, h)) as RenderFrame[];
}

export function getDirtySpreadIndices(editor: PhotobookEditor): number[] {
  return JSON.parse(editor.get_dirty_spread_indices()) as number[];
}

// ---------------------------------------------------------------------------
// Pinwheel
// ---------------------------------------------------------------------------

export function getXJunctions(editor: PhotobookEditor): XJunction[] {
  return JSON.parse(editor.get_xjunctions()) as XJunction[];
}

// ---------------------------------------------------------------------------
// Multi-image drop
// ---------------------------------------------------------------------------

/**
 * Split `faceId` into `count` leaf faces using recursive binary halving with
 * alternating axes, and return the leaf face IDs in traversal order.
 * `preferVertical` controls the first cut direction.
 */
export function splitFaceForMultiDrop(
  editor: PhotobookEditor,
  faceId: number,
  count: number,
  preferVertical: boolean,
): number[] {
  return JSON.parse(editor.split_face_for_multi_drop(faceId, count, preferVertical)) as number[];
}

// ---------------------------------------------------------------------------
// Image usage query
// ---------------------------------------------------------------------------

/** Returns the set of image IDs that are placed on at least one spread. */
export function getUsedImageIds(editor: PhotobookEditor): Set<string> {
  return new Set(JSON.parse(editor.get_used_image_ids()) as string[]);
}

// ---------------------------------------------------------------------------
// Image cover geometry
// ---------------------------------------------------------------------------

/** Typed wrapper for the free WASM function `compute_image_cover`. */
export function computeImageCover(
  frameW: number, frameH: number,
  imgW: number, imgH: number,
  panX: number, panY: number,
  userScale: number,
  rotationDeg: number,
): ImageCoverResult | null {
  return JSON.parse(
    compute_image_cover(frameW, frameH, imgW, imgH, panX, panY, userScale, rotationDeg),
  ) as ImageCoverResult | null;
}
