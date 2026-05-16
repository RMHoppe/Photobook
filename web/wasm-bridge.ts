// wasm-bridge.ts — Typed wrappers around the JSON-returning WASM methods.
//
// Every method on PhotobookEditor that returns a JSON string has a corresponding
// typed function here that calls JSON.parse and casts to the correct interface.
// Callers import from here instead of calling editor.get_xxx() + JSON.parse() directly,
// so a Rust field rename produces a TypeScript compile error rather than a silent undefined.

import { PhotobookEditor, compute_image_cover } from './pkg/photobook_core.js';
import type {
  SpreadInfo, SpreadSummary, PageSize,
  RenderFrame, FaceBg, Divider, LowDpiFrame,
  BoxModel, FrameTransform, TransformHandles,
  ImageCoverResult, TextElement,
  ResolvedSpread, SpreadDelta, XJunction,
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

export function getDefaultSpreadMargin(editor: PhotobookEditor): { top: number; right: number; bottom: number; left: number } {
  return JSON.parse(editor.get_default_spread_margin_mm()) as { top: number; right: number; bottom: number; left: number };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function getRenderList(editor: PhotobookEditor, w: number, h: number): RenderFrame[] {
  return JSON.parse(editor.get_render_list(w, h)) as RenderFrame[];
}

export function getFaceBackgrounds(editor: PhotobookEditor, w: number, h: number): FaceBg[] {
  return JSON.parse(editor.get_face_backgrounds(w, h)) as FaceBg[];
}

export function getDividers(editor: PhotobookEditor, w: number, h: number): Divider[] {
  return JSON.parse(editor.get_dividers(w, h)) as Divider[];
}

export function getLowDpiFrames(editor: PhotobookEditor, w: number, h: number): LowDpiFrame[] {
  return JSON.parse(editor.get_low_dpi_frames(w, h)) as LowDpiFrame[];
}

// ---------------------------------------------------------------------------
// Gap (per-chain half_gap)
// ---------------------------------------------------------------------------

export function getChainGap(editor: PhotobookEditor, edgeId: number): number {
  return editor.get_chain_gap(edgeId);
}

export function setChainGap(editor: PhotobookEditor, edgeId: number, gapMm: number): void {
  editor.set_chain_gap(edgeId, gapMm);
}

// ---------------------------------------------------------------------------
// Box model / transform
// ---------------------------------------------------------------------------

export function getBoxModel(editor: PhotobookEditor): BoxModel {
  return JSON.parse(editor.get_box_model()) as BoxModel;
}

export function getTransformBoxModel(editor: PhotobookEditor): BoxModel {
  return JSON.parse(editor.get_transform_box_model()) as BoxModel;
}

export function getFrameTransform(editor: PhotobookEditor, faceId: number): FrameTransform | null {
  return JSON.parse(editor.get_frame_transform(faceId)) as FrameTransform | null;
}

export function getSelectedTransformHandles(
  editor: PhotobookEditor,
  w: number,
  h: number,
): TransformHandles | null {
  return JSON.parse(editor.get_selected_transform_handles(w, h)) as TransformHandles | null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function getAllSelected(editor: PhotobookEditor): number[] {
  return JSON.parse(editor.get_all_selected()) as number[];
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
