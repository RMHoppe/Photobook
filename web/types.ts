// types.ts — Shared TypeScript interfaces mirroring Rust structs serialised over the WASM boundary.
// All shapes are inferred from the JSON each wasm-bindgen method returns.

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Canvas-space rectangle. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas spread rectangle (same shape as Rect, named separately for clarity). */
export type SpreadRect = Rect;

// ---------------------------------------------------------------------------
// Spread / page
// ---------------------------------------------------------------------------

/** Layout info for the currently displayed spread. */
export interface SpreadInfo {
  kind: 'cover' | 'content';
  width_mm: number;
  height_mm: number;
  spine_mm: number;
  page_width_mm: number;
  left_bg: string;
  right_bg: string;
}

/** Lightweight summary used in the footer thumbnail strip. */
export interface SpreadSummary {
  id: number;
  label: string;
  kind: 'cover' | 'content';
}

/** Page dimensions in mm (get_page_size_mm). */
export interface PageSize {
  width_mm: number;
  height_mm: number;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type ObjectFit = 'cover' | 'contain' | 'fill';
export type BorderPosition = 'inner' | 'centered' | 'outer' | 'mixed' | '';

/** A single rendered frame from get_render_list(). */
export interface RenderFrame {
  id: number;
  /** Inner content rect — after gap and margin insets. */
  rect: Rect;
  /** Outer face rect — after gap, before margin. Used for selection highlight. */
  face_rect: Rect;
  image_id?: string;
  pan_x: number;
  pan_y: number;
  scale: number;
  rotation_deg: number;
  is_selected: boolean;
  object_fit: ObjectFit;
  border_width: number;
  border_color: string;
  border_position: BorderPosition;
  face_rotation_deg: number;
}

/** Resizable divider line between two rooms. */
export interface Divider {
  segment_id: number;
  axis: 'v' | 'h';
  x: number;
  y: number;
  length: number;
}

/** All resolved geometry for one spread. */
export interface ResolvedSpread {
  frames: RenderFrame[];
  dividers: Divider[];
  twin_handles: TwinHandle[];
}

/** Incremental delta returned by get_resolved_spread_delta(). */
export interface SpreadDelta {
  full: ResolvedSpread | null;
  updated_frames: RenderFrame[] | null;
}

/** DPI warning badge hit area (computed in canvas, not from WASM). */
export interface DpiBadge {
  cx: number;
  cy: number;
  r: number;
  effectiveDpi: number;
  printDpi: number;
}

/** Low-DPI frame entry from get_low_dpi_frames(). */
export interface LowDpiFrame {
  id: number;
  effective_dpi: number;
}

// ---------------------------------------------------------------------------
// Box model
// ---------------------------------------------------------------------------

/** Margin / padding insets in mm. */
export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Border styling. */
export interface Border {
  width: number;
  color: string;
  position: BorderPosition;
}

/** Full box model for a face or the merged multi-selection. */
export interface BoxModel {
  margin: EdgeInsets;
  border: Border;
  /** Face-level rotation in degrees counter-clockwise. Absent/null = mixed (multi-selection). */
  face_rotation_deg?: number | null;
}

// ---------------------------------------------------------------------------
// Transform / image placement
// ---------------------------------------------------------------------------

/** Image transform stored on a frame. */
export interface FrameTransform {
  pan_x: number;
  pan_y: number;
  scale: number;
  rotation_deg: number;
}

/** Transform handle pair for the selected node (margin-drag UI). */
export interface TransformHandles {
  outer: Rect;
  inner: Rect;
}

/** Result of compute_image_cover() — geometry for rendering a covered image. */
export interface ImageCoverResult {
  sw: number;
  sh: number;
  overflow_x: number;
  overflow_y: number;
  pan_off_x: number;
  pan_off_y: number;
}

// ---------------------------------------------------------------------------
// Text elements
// ---------------------------------------------------------------------------

/** A free-floating text element on the spread. */
export interface TextElement {
  id: number;
  content: string;
  /** X position of top-left corner in mm from spread left. */
  x_mm: number;
  /** Y position of top-left corner in mm from spread top. */
  y_mm: number;
  font_family: string;
  /** Font size in typographic points (1 pt = 1/72 inch). */
  font_size_pt: number;
  /** Text colour as "#RRGGBB". */
  color: string;
  /** Rotation in degrees counter-clockwise. */
  rotation_deg: number;
  bold: boolean;
  italic: boolean;
  /** "left" | "center" | "right" */
  align: string;
}

// ---------------------------------------------------------------------------
// Interaction overlays
// ---------------------------------------------------------------------------

/** A point where two interior chains cross — spawns a pinwheel on drag. */
export interface XJunction {
  /** Normalised x (0–1) within the spread. */
  nx: number;
  /** Normalised y (0–1) within the spread. */
  ny: number;
  tl_id: number;
  tr_id: number;
  bl_id: number;
  br_id: number;
}

/** Handle for selecting an individual segment in a multi-segment divider chain. */
export interface TwinHandle {
  edge_id: number;
  /** Midpoint of the segment in canvas px (spread origin as 0,0). */
  x: number;
  y: number;
  /** Segment length in canvas px — used to draw the selection highlight. */
  length: number;
  axis: 'h' | 'v';
}

/** Transient visual overlays drawn on top of the spread. */
export interface Overlays {
  marqueeRect: Rect | null;
  splitPreview: SplitPreview | null;
  swapOverlay: SwapOverlay | null;
  edgeDragPreview: EdgeDragPreview | null;
}

export interface EdgeDragPreview {
  axis: 'h' | 'v';
  ratio: number;
  newIsFirst: boolean;
}

export interface SplitPreview {
  frameRect: Rect;
  axis: 'v' | 'h' | 'quadrant';
  ratio: number;
  numCuts: number;
}

export interface SwapOverlay {
  sourceId: number;
  targetId: number | null;
}

// ---------------------------------------------------------------------------
// Settings panel data
// ---------------------------------------------------------------------------

/** Data exchanged between main.ts and ProjectSettingsPanel. */
export interface ProjectSettingsData {
  page_width_mm: number;
  page_height_mm: number;
  bleed_mm: number;
  safe_zone_mm: number;
  spine_mm_per_page: number;
  spine_min_mm: number;
  margin_step_mm: number;
  print_dpi: number;
}

/** Data exchanged between main.ts and SpreadSettingsPanel. */
export interface SpreadSettingsData {
  margin_top: number;
  margin_right: number;
  margin_bottom: number;
  margin_left: number;
  left_bg: string;
  right_bg: string;
}
