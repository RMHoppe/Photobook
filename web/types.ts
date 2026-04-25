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

/** A single rendered leaf frame from get_render_list(). */
export interface RenderFrame {
  id: number;
  rect: Rect;
  image_id?: string;
  pan_x: number;
  pan_y: number;
  scale: number;
  rotation_deg: number;
  is_selected: boolean;
  is_ancestor: boolean;
  object_fit: ObjectFit;
  border_width: number;
  border_color: string;
  border_position: BorderPosition;
  node_rotation_deg: number;
}

/** Node background entry from get_node_backgrounds(). */
export interface NodeBg {
  rect: Rect;
  color: string;
}

/** Resizable divider line between two BSP children. */
export interface Divider {
  node_id: number;
  axis: 'v' | 'h';
  x: number;
  y: number;
  length: number;
}

/** Split node border from get_split_node_borders(). */
export interface SplitBorder {
  rect: Rect;
  width_px: number;
  color: string;
  position: BorderPosition;
}

/** All resolved geometry for one spread — produced by a single DFS traversal. */
export interface ResolvedSpread {
  leaves: RenderFrame[];
  dividers: Divider[];
  backgrounds: NodeBg[];
  split_borders: SplitBorder[];
  cross_handles: CrossHandle[];
}

/** Incremental delta returned by get_resolved_spread_delta(). */
export interface SpreadDelta {
  full: ResolvedSpread | null;
  updated_leaves: RenderFrame[] | null;
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

/** Full box model for a node or the merged multi-selection. */
export interface BoxModel {
  margin: EdgeInsets;
  gap: number;
  bg: string;
  border: Border;
  /** Node-level rotation in degrees counter-clockwise. Absent/null = mixed (multi-selection). */
  node_rotation_deg?: number | null;
}

// ---------------------------------------------------------------------------
// Transform / image placement
// ---------------------------------------------------------------------------

/** Image transform stored on a leaf node. */
export interface LeafTransform {
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

/** A free-floating text element (not part of the BSP tree). */
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

/** A structural-rewire or unlock handle on a quadrant layout divider. */
export interface CrossHandle {
  parent_id: number;
  x: number;
  y: number;
  /** "rewire" = flip quadrant axes; "unlock" = move divider independently; "pinwheel_spawn" = spawn a pinwheel. */
  kind: 'rewire' | 'unlock' | 'pinwheel_spawn';
  /** rewire only: true if this segment is the first child of the parent split. */
  first_child: boolean;
  /** Drag direction: 'h' = horizontal (X axis), 'v' = vertical (Y axis). */
  drag_axis: 'h' | 'v';
}

/** Transient visual overlays drawn on top of the spread. */
export interface Overlays {
  marqueeRect: Rect | null;
  splitPreview: SplitPreview | null;
  swapOverlay: SwapOverlay | null;
  edgeDragPreview: EdgeDragPreview | null;
  crossHandleDragPreview: CrossHandleDragPreview | null;
}

export interface CrossHandleDragPreview {
  /** Axis of the new split ('h' = draw horizontal line, 'v' = draw vertical line). */
  axis: 'h' | 'v';
  /** Position in spread-relative px: y for 'h', x for 'v'. */
  position: number;
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
