use crate::layout::{Rect, ResolvedDivider, ResolvedFrame, SplitAxis};
use crate::grid_layout::{EdgeId, FaceId, OUTER_FACE};

const DIVIDER_HIT_RADIUS: f32 = 6.0;

pub struct HitTester {
    frames: Vec<ResolvedFrame>,
    dividers: Vec<ResolvedDivider>,
}

impl HitTester {
    pub fn new(frames: Vec<ResolvedFrame>, dividers: Vec<ResolvedDivider>) -> Self {
        HitTester { frames, dividers }
    }

    /// Returns the FaceId of the topmost face under (x, y), or OUTER_FACE.
    pub fn hit_face(&self, x: f32, y: f32) -> FaceId {
        for frame in self.frames.iter().rev() {
            if frame.rect.contains(x, y) {
                return frame.id;
            }
        }
        OUTER_FACE
    }

    /// Returns (edge_id, axis) of the divider closest to (x,y) within its hit zone.
    pub fn hit_divider(&self, x: f32, y: f32) -> Option<(EdgeId, SplitAxis)> {
        for div in &self.dividers {
            let r = DIVIDER_HIT_RADIUS.max(div.half_gap);
            let hit = match div.axis {
                SplitAxis::Vertical => {
                    (x - div.x).abs() < r && y >= div.y && y <= div.y + div.length
                }
                SplitAxis::Horizontal => {
                    (y - div.y).abs() < r && x >= div.x && x <= div.x + div.length
                }
            };
            if hit {
                return Some((div.segment_id, div.axis));
            }
        }
        None
    }

    /// Get frame rect for a given face id.
    pub fn frame_rect(&self, id: FaceId) -> Option<Rect> {
        self.frames.iter().find(|f| f.id == id).map(|f| f.rect)
    }

    /// Determine split axis hint from mouse position within a frame.
    pub fn split_axis_hint(&self, id: FaceId, mx: f32, my: f32) -> &'static str {
        if let Some(rect) = self.frame_rect(id) {
            let rel_x = (mx - rect.x) / rect.w.max(1.0);
            let rel_y = (my - rect.y) / rect.h.max(1.0);
            let right_bias = (rel_x - 0.5).abs();
            let bottom_bias = (rel_y - 0.5).abs();
            if right_bias >= bottom_bias { "h" } else { "v" }
        } else {
            "v"
        }
    }
}

/// State for an in-progress divider drag.
pub struct DragState {
    pub edge_id: EdgeId,
    pub axis: SplitAxis,
    /// All edges in the same collinear chain as `edge_id` (for chain-move).
    pub chain: Vec<EdgeId>,
}
