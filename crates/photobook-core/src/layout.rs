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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BorderPosition {
    #[default]
    Centered,
    Inner,
    Outer,
    /// Sentinel for multi-selection where nodes disagree on border position.
    /// `#[serde(other)]` also catches any unrecognised string (including "")
    /// so the JS can emit `""` or `"mixed"` to signal "skip this field".
    #[serde(other)]
    Mixed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Border {
    #[serde(default)]
    pub width: f32,
    #[serde(default = "default_border_color")]
    pub color: String,
    #[serde(default)]
    pub position: BorderPosition,
}

fn default_border_color() -> String { "#000000".to_string() }

impl Default for Border {
    fn default() -> Self {
        Border { width: 0.0, color: default_border_color(), position: BorderPosition::Centered }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoxModel {
    pub margin: EdgeInsets,
    /// Background fill colour for this node's content area. Empty string = transparent.
    #[serde(default)]
    pub bg: String,
    #[serde(default)]
    pub border: Border,
    /// Visual rotation of this face in degrees counter-clockwise. None = mixed (multi-selection sentinel).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face_rotation_deg: Option<f32>,
}

impl Default for BoxModel {
    fn default() -> Self {
        BoxModel {
            margin: EdgeInsets::default(),
            bg: String::new(),
            border: Border::default(),
            face_rotation_deg: Some(0.0),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
    pub is_selected: bool,
    pub border_width: f32,
    pub border_color: String,
    pub border_position: BorderPosition,
    /// Face-level visual rotation in degrees (counter-clockwise). Always resolved; never None.
    pub face_rotation_deg: f32,
}

/// A resolved background rect — emitted for every node that has a non-empty `bg` colour.
/// Emitted in z-order (back-to-front) so layering is correct.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedBackground {
    pub rect: Rect,
    pub color: String,
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
}

/// All resolved geometry for one spread.
#[derive(Serialize)]
pub struct ResolvedSpread {
    pub frames:       Vec<ResolvedFrame>,
    pub dividers:     Vec<ResolvedDivider>,
    pub backgrounds:  Vec<ResolvedBackground>,
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
}
