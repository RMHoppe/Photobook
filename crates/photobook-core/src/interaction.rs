use crate::bsp::{NodeId, SplitAxis};
use crate::layout::{Rect, ResolvedDivider, ResolvedLeaf};

const DIVIDER_HIT_RADIUS: f32 = 6.0;

pub struct HitTester {
    leaves: Vec<ResolvedLeaf>,
    dividers: Vec<ResolvedDivider>,
}

impl HitTester {
    pub fn new(leaves: Vec<ResolvedLeaf>, dividers: Vec<ResolvedDivider>) -> Self {
        HitTester { leaves, dividers }
    }

    /// Returns the NodeId of the topmost leaf under (x, y), or NULL_ID.
    pub fn hit_leaf(&self, x: f32, y: f32) -> NodeId {
        for leaf in self.leaves.iter().rev() {
            if leaf.rect.contains(x, y) {
                return leaf.id;
            }
        }
        crate::bsp::NULL_ID
    }

    /// Returns (node_id, axis) of the divider closest to (x,y) within its hit zone.
    /// The hit zone is at least DIVIDER_HIT_RADIUS wide, but expands to cover the full gap.
    pub fn hit_divider(&self, x: f32, y: f32) -> Option<(NodeId, SplitAxis)> {
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
                return Some((div.node_id, div.axis));
            }
        }
        None
    }

    /// Get leaf rect for a given node id.
    pub fn leaf_rect(&self, id: NodeId) -> Option<Rect> {
        self.leaves.iter().find(|l| l.id == id).map(|l| l.rect)
    }

    /// Determine split axis hint from mouse position within a leaf frame.
    /// Returns Vertical if cursor is in the right half, Horizontal if in the bottom half.
    /// Tie-break: use the axis that is more extreme.
    pub fn split_axis_hint(&self, id: NodeId, mx: f32, my: f32) -> &'static str {
        if let Some(rect) = self.leaf_rect(id) {
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

/// State machine for dragging a divider border.
pub struct DragState {
    pub node_id: NodeId,
    pub axis: SplitAxis,
    /// Other split nodes whose divider is aligned with `node_id` and should move together.
    pub locked_ids: Vec<NodeId>,
}
