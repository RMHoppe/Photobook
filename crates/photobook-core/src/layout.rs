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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Border {
    /// Legacy single-width field — used as fallback when per-side fields are absent (old saves).
    #[serde(default)]
    pub width: f32,
    /// Per-side widths in mm. None = mixed (multi-selection sentinel).
    /// When any per-side field is Some, all rendering uses these instead of `width`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_top: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_right: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_bottom: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_left: Option<f32>,
    #[serde(default = "default_border_color")]
    pub color: String,
    #[serde(default)]
    pub position: BorderPosition,
    /// Corner radius in mm. 0 = sharp corners.
    #[serde(default)]
    pub radius: f32,
}

fn default_border_color() -> String { "#000000".to_string() }

impl Default for Border {
    fn default() -> Self {
        Border {
            width: 0.0,
            width_top: None, width_right: None, width_bottom: None, width_left: None,
            color: default_border_color(),
            position: BorderPosition::Centered,
            radius: 0.0,
        }
    }
}

impl Border {
    /// Returns (top, right, bottom, left) widths in mm.
    /// Uses per-side fields when any are present; falls back to uniform `width`.
    pub fn side_widths(&self) -> (f32, f32, f32, f32) {
        if self.width_top.is_some() || self.width_right.is_some()
            || self.width_bottom.is_some() || self.width_left.is_some()
        {
            (
                self.width_top.unwrap_or(0.0),
                self.width_right.unwrap_or(0.0),
                self.width_bottom.unwrap_or(0.0),
                self.width_left.unwrap_or(0.0),
            )
        } else {
            (self.width, self.width, self.width, self.width)
        }
    }

    pub fn any_nonzero(&self) -> bool {
        let (t, r, b, l) = self.side_widths();
        t > 0.0 || r > 0.0 || b > 0.0 || l > 0.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BoxModel {
    pub margin: MarginInsets,
    #[serde(default)]
    pub border: Border,
    /// Visual rotation of this face in degrees counter-clockwise. None = mixed (multi-selection sentinel).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face_rotation_deg: Option<f32>,
}

impl Default for BoxModel {
    fn default() -> Self {
        BoxModel {
            margin: MarginInsets::default(),
            border: Border::default(),
            face_rotation_deg: Some(0.0),
        }
    }
}

/// Per-face margin insets in mm. `None` = "mixed" sentinel for multi-selection;
/// `None` resolves to 0 mm for layout purposes. Allows negative values so frames
/// can overlap with their neighbours.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MarginInsets {
    pub top:    Option<f32>,
    pub right:  Option<f32>,
    pub bottom: Option<f32>,
    pub left:   Option<f32>,
}

impl Default for MarginInsets {
    fn default() -> Self {
        MarginInsets { top: Some(0.0), right: Some(0.0), bottom: Some(0.0), left: Some(0.0) }
    }
}

impl MarginInsets {
    /// Convert to concrete `EdgeInsets` by replacing `None` with 0.
    pub fn resolve(&self) -> EdgeInsets {
        EdgeInsets {
            top:    self.top.unwrap_or(0.0),
            right:  self.right.unwrap_or(0.0),
            bottom: self.bottom.unwrap_or(0.0),
            left:   self.left.unwrap_or(0.0),
        }
    }
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
    pub is_selected: bool,
    pub border_width_top: f32,
    pub border_width_right: f32,
    pub border_width_bottom: f32,
    pub border_width_left: f32,
    pub border_color: String,
    pub border_position: BorderPosition,
    /// Corner radius in canvas px (converted from mm). 0 = sharp corners.
    pub border_radius: f32,
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
}
