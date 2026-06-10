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
  /** Which page is non-printable, or null for normal spreads. */
  endpaper_side: 'left' | 'right' | null;
}

/** Lightweight summary used in the footer thumbnail strip. */
export interface SpreadSummary {
  id: number;
  label: string;
  kind: 'cover' | 'content';
  endpaper_side: 'left' | 'right' | null;
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
  flip_h: boolean;
  flip_v: boolean;
  is_selected: boolean;
  object_fit: ObjectFit;
  border_width_top: number;
  border_width_right: number;
  border_width_bottom: number;
  border_width_left: number;
  border_color: string;
  border_position: BorderPosition;
  /** Per-corner radii in canvas px (TL/TR/BR/BL). */
  border_radius: number;
  border_radius_tr: number;
  border_radius_br: number;
  border_radius_bl: number;
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
  /** Legacy uniform width — only present in old saves; new code always uses per-side fields. */
  width?: number;
  /** Per-side widths in mm. null = mixed (multi-selection sentinel). */
  width_top?: number | null;
  width_right?: number | null;
  width_bottom?: number | null;
  width_left?: number | null;
  color: string;
  position: BorderPosition;
  /** Corner radius in mm. 0 = sharp corners. -1 = mixed (multi-selection sentinel). */
  radius: number;
  /** Per-corner radii in mm (TL/TR/BR/BL). null = mixed sentinel; absent = use uniform `radius`. */
  radius_tl?: number | null;
  radius_tr?: number | null;
  radius_br?: number | null;
  radius_bl?: number | null;
}

/** Face margin insets in mm. null = mixed (multi-selection sentinel); allows negative values. */
export interface MarginInsets {
  top:    number | null;
  right:  number | null;
  bottom: number | null;
  left:   number | null;
}

/** Inner-gap values for a frame selection. null = no inner edges of that axis, or mixed. */
export interface InnerGaps {
  h: number | null;  // half_gap on vertical dividers (gap between side-by-side frames)
  v: number | null;  // half_gap on horizontal dividers (gap between stacked frames)
}

/** Full box model for a face or the merged multi-selection. */
export interface BoxModel {
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
  flip_h: boolean;
  flip_v: boolean;
}

/** Transform handle pair for the selected node (margin-drag UI). */
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
  underline: boolean;
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
  imageDropPreview: ImageDropPreview | null;
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

export type DropZone = 'center' | 'top' | 'right' | 'bottom' | 'left';

export interface ImageDropPreview {
  frameRect: Rect;
  zone: DropZone;
  hasExistingImage: boolean;
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
  endpapers: boolean;
}

/** Data exchanged between main.ts and SpreadSettingsPanel. */
export interface SpreadSettingsData {
  left_bg: string;
  right_bg: string;
}

/** Half-gap values for a selected divider chain, returned by get_selected_segment_half_gaps. */
export interface ChainHalfGaps {
  /** Facing::End side — left for vertical dividers, top for horizontal. null = mixed across segments. */
  a: number | null;
  /** Facing::Start side — right for vertical dividers, bottom for horizontal. null = mixed across segments. */
  b: number | null;
  /** 'h' = horizontal divider (splits top/bottom), 'v' = vertical (splits left/right). */
  axis: 'h' | 'v';
}
