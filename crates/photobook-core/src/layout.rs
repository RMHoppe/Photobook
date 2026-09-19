use serde::{Deserialize, Serialize};


#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ObjectFit {
    #[default]
    Cover,
    Contain,
    Fill,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Copy)]
pub enum SplitAxis {
    #[serde(rename = "h")]
    Horizontal,
    #[serde(rename = "v")]
    Vertical,
}

// ---------------------------------------------------------------------------
// Box model types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BorderPosition {
    #[default]
    Centered,
    Inner,
    Outer,
}

/// Stored border styling — always concrete per-side / per-corner values.
/// Multi-selection "mixed" states live only in the box-model editor DTO
/// (`editor_box_model.rs`), never in the document.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Border {
    /// Per-side widths in mm (0 = no border on that side).
    #[serde(default)]
    pub width_top: f32,
    #[serde(default)]
    pub width_right: f32,
    #[serde(default)]
    pub width_bottom: f32,
    #[serde(default)]
    pub width_left: f32,
    #[serde(default = "default_border_color")]
    pub color: String,
    #[serde(default)]
    pub position: BorderPosition,
    /// Per-corner radii in mm (0 = sharp corner).
    #[serde(default)]
    pub radius_tl: f32,
    #[serde(default)]
    pub radius_tr: f32,
    #[serde(default)]
    pub radius_br: f32,
    #[serde(default)]
    pub radius_bl: f32,
}

fn default_border_color() -> String { "#000000".to_string() }

impl Default for Border {
    fn default() -> Self {
        Border {
            width_top: 0.0, width_right: 0.0, width_bottom: 0.0, width_left: 0.0,
            color: default_border_color(),
            position: BorderPosition::Centered,
            radius_tl: 0.0, radius_tr: 0.0, radius_br: 0.0, radius_bl: 0.0,
        }
    }
}

impl Border {
    /// Returns (top, right, bottom, left) widths in mm.
    pub fn side_widths(&self) -> (f32, f32, f32, f32) {
        (self.width_top, self.width_right, self.width_bottom, self.width_left)
    }

    pub fn any_nonzero(&self) -> bool {
        self.width_top > 0.0 || self.width_right > 0.0
            || self.width_bottom > 0.0 || self.width_left > 0.0
    }

    /// Returns (TL, TR, BR, BL) corner radii in mm.
    pub fn corner_radii(&self) -> (f32, f32, f32, f32) {
        (self.radius_tl, self.radius_tr, self.radius_br, self.radius_bl)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct BoxModel {
    #[serde(default)]
    pub border: Border,
    /// Visual rotation of this face in degrees counter-clockwise.
    #[serde(default)]
    pub face_rotation_deg: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct EdgeInsets {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl EdgeInsets {
    /// Scale every side by `factor` (used to convert mm → canvas px).
    pub fn scale(&self, factor: f32) -> EdgeInsets {
        EdgeInsets {
            top:    self.top    * factor,
            right:  self.right  * factor,
            bottom: self.bottom * factor,
            left:   self.left   * factor,
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Copy, Serialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Rect { x, y, w, h }
    }

    /// Shrink rect by edge insets (already in the same coordinate unit as the rect).
    pub fn inset(&self, e: &EdgeInsets) -> Rect {
        Rect {
            x: self.x + e.left,
            y: self.y + e.top,
            w: (self.w - e.left - e.right).max(0.0),
            h: (self.h - e.top - e.bottom).max(0.0),
        }
    }

    pub fn contains(&self, px: f32, py: f32) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

// ---------------------------------------------------------------------------
// Resolved output types
// ---------------------------------------------------------------------------

/// A face fully resolved into canvas pixel coordinates, ready for drawing.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedFrame {
    pub id: u32,
    /// Inner content rect — after gap and margin insets. Used for image/border rendering.
    pub rect: Rect,
    /// Raw face boundary in canvas px (before gap and margin insets). Used for selection highlight.
    pub face_rect: Rect,
    pub image_id: Option<String>,
    pub object_fit: ObjectFit,
    pub pan_x: f32,
    pub pan_y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub is_selected: bool,
    pub border_width_top: f32,
    pub border_width_right: f32,
    pub border_width_bottom: f32,
    pub border_width_left: f32,
    pub border_color: String,
    pub border_position: BorderPosition,
    /// Per-corner radii in canvas px. `border_radius` = TL, then TR, BR, BL.
    pub border_radius: f32,
    pub border_radius_tr: f32,
    pub border_radius_br: f32,
    pub border_radius_bl: f32,
    /// Face-level visual rotation in degrees (counter-clockwise). Always resolved; never None.
    pub face_rotation_deg: f32,
}

/// A resolved divider line for drag-resize.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedDivider {
    pub segment_id: u32,
    pub x: f32,
    pub y: f32,
    pub length: f32,
    pub axis: SplitAxis,
    /// Half the gap in canvas px — used to widen the hit zone to cover the full gap.
    pub half_gap: f32,
    /// True for the four outer spread edges (not draggable, gap-only).
    pub is_boundary: bool,
}

/// All resolved geometry for one spread.
#[derive(Serialize)]
pub struct ResolvedSpread {
    pub frames:       Vec<ResolvedFrame>,
    pub dividers:     Vec<ResolvedDivider>,
    pub twin_handles: Vec<ResolvedTwinHandle>,
}

/// A twin handle shown at the midpoint of a divider segment in a multi-pair chain.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedTwinHandle {
    pub edge_id: u32,
    /// Midpoint of the segment in canvas px (diamond hit-test position).
    pub x: f32,
    pub y: f32,
    /// Segment length in canvas px (for drawing the selection highlight).
    pub length: f32,
    pub axis: SplitAxis,
}

/// Outer/inner rects for the selected node's transform handles.
#[derive(Serialize)]
pub struct TransformHandles {
    pub outer: Rect,
    pub inner: Rect,
}

/// Image pan/scale/rotation state for a frame (face).
#[derive(Serialize)]
pub struct FrameTransform {
    pub pan_x: f32,
    pub pan_y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub flip_h: bool,
    pub flip_v: bool,
}
