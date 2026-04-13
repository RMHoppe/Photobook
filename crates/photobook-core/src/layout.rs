use serde::{Deserialize, Serialize};
use crate::bsp::{BspKind, BspTree, NodeId, SplitAxis};

fn default_border_color()    -> String { "#000000".to_string() }
fn default_border_position() -> String { "centered".to_string() }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Border {
    #[serde(default)]
    pub width: f32,
    #[serde(default = "default_border_color")]
    pub color: String,
    #[serde(default = "default_border_position")]
    pub position: String,
}

impl Default for Border {
    fn default() -> Self {
        Border {
            width: 0.0,
            color: default_border_color(),
            position: default_border_position(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BoxModel {
    pub margin: EdgeInsets,
    /// gap between the two children of a split node (mm)
    pub gap: f32,
    /// Background fill colour for this node's content area. Empty string = transparent.
    #[serde(default)]
    pub bg: String,
    #[serde(default)]
    pub border: Border,
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

/// A resolved image frame leaf (for canvas / hit-testing).
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedLeaf {
    pub id: NodeId,
    pub rect: Rect,
    pub image_id: Option<String>,
    pub object_fit: String,
    pub pan_x: f32,
    pub pan_y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub is_selected: bool,
    pub is_ancestor: bool,
    pub border_width: f32,
    pub border_color: String,
    pub border_position: String,
}

/// A resolved background rect — emitted for every node that has a non-empty `bg` colour.
/// Emitted in tree-walk order (parents before children) so layering is correct.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedBackground {
    pub rect: Rect,
    pub color: String,
}

/// A resolved divider line for drag-resize.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedDivider {
    pub node_id: NodeId,
    pub x: f32,
    pub y: f32,
    pub length: f32,
    pub axis: String, // "h" = horizontal line, "v" = vertical
    /// Half the gap in canvas px — used to widen the hit zone to cover the full gap.
    pub half_gap: f32,
}

/// Compute the two child rects produced by splitting `rect` along `axis` at `ratio` with `gap`.
/// `gap` must already be in the same coordinate unit as `rect` (canvas px or mm).
fn split_children(rect: Rect, axis: SplitAxis, ratio: f32, gap: f32) -> (Rect, Rect) {
    match axis {
        SplitAxis::Horizontal => {
            let total = rect.h;
            let first_h = (total * ratio - gap / 2.0).max(0.0);
            let second_h = (total - first_h - gap).max(0.0);
            (
                Rect::new(rect.x, rect.y, rect.w, first_h),
                Rect::new(rect.x, rect.y + first_h + gap, rect.w, second_h),
            )
        }
        SplitAxis::Vertical => {
            let total = rect.w;
            let first_w = (total * ratio - gap / 2.0).max(0.0);
            let second_w = (total - first_w - gap).max(0.0);
            (
                Rect::new(rect.x, rect.y, first_w, rect.h),
                Rect::new(rect.x + first_w + gap, rect.y, second_w, rect.h),
            )
        }
    }
}

pub struct LayoutResolver<'a> {
    tree: &'a BspTree,
    selected: NodeId,
    ancestors: Vec<NodeId>,
    /// Multiplier to convert stored mm values to the coordinate unit of the root rect.
    /// Use `canvas_px / spread_mm` for canvas rendering, `1.0` for mm-space (PDF).
    mm_to_px: f32,
}

impl<'a> LayoutResolver<'a> {
    pub fn new(tree: &'a BspTree, selected: NodeId, mm_to_px: f32) -> Self {
        let ancestors = tree.ancestors(selected);
        LayoutResolver { tree, selected, ancestors, mm_to_px }
    }

    pub fn resolve_leaves(&self, root_rect: Rect) -> Vec<ResolvedLeaf> {
        let mut out = Vec::new();
        self.walk_leaves(self.tree.root, root_rect, &mut out);
        out
    }

    pub fn resolve_dividers(&self, root_rect: Rect) -> Vec<ResolvedDivider> {
        let mut out = Vec::new();
        self.walk_dividers(self.tree.root, root_rect, &mut out);
        out
    }

    /// Resolve background rects for every node that has a non-empty `bg` colour.
    /// Returns in tree-walk order (parents first).
    pub fn resolve_backgrounds(&self, root_rect: Rect) -> Vec<ResolvedBackground> {
        let mut out = Vec::new();
        self.walk_backgrounds(self.tree.root, root_rect, &mut out);
        out
    }

    /// Return the content rect (after margin) of the node with the given id, or `None`.
    pub fn resolve_node_rect(&self, target_id: NodeId, root_rect: Rect) -> Option<Rect> {
        self.find_node_rect(self.tree.root, root_rect, target_id)
    }

    /// Return `(outer, inner)` rects for the given node: outer is before margin, inner after.
    pub fn resolve_node_outer_inner(&self, target_id: NodeId, root_rect: Rect) -> Option<(Rect, Rect)> {
        self.find_node_outer_inner(self.tree.root, root_rect, target_id)
    }

    // -----------------------------------------------------------------------
    // Private walkers
    // -----------------------------------------------------------------------

    fn walk_leaves(&self, id: NodeId, rect: Rect, out: &mut Vec<ResolvedLeaf>) {
        let node = match self.tree.get(id) {
            Some(n) => n,
            None => return,
        };

        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        // Extract border fields before matching (borrow-checker).
        let border_width    = node.box_model.border.width * self.mm_to_px;
        let border_color    = node.box_model.border.color.clone();
        let border_position = node.box_model.border.position.clone();

        match &node.kind {
            BspKind::Leaf(leaf) => {
                out.push(ResolvedLeaf {
                    id,
                    rect: inner,
                    image_id: leaf.image_id.clone(),
                    object_fit: format!("{:?}", leaf.object_fit).to_lowercase(),
                    pan_x: leaf.pan_x,
                    pan_y: leaf.pan_y,
                    scale: leaf.scale,
                    rotation_deg: leaf.rotation_deg,
                    is_selected: id == self.selected,
                    is_ancestor: self.ancestors.contains(&id),
                    border_width,
                    border_color,
                    border_position,
                });
            }
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                self.walk_leaves(split.first_child, first_rect, out);
                self.walk_leaves(split.second_child, second_rect, out);
            }
        }
    }

    fn walk_dividers(&self, id: NodeId, rect: Rect, out: &mut Vec<ResolvedDivider>) {
        let node = match self.tree.get(id) {
            Some(n) => n,
            None => return,
        };

        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        match &node.kind {
            BspKind::Leaf(_) => {}
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                let divider = match split.axis {
                    SplitAxis::Horizontal => ResolvedDivider {
                        node_id: id,
                        x: inner.x,
                        y: first_rect.y + first_rect.h + gap_px / 2.0,
                        length: inner.w,
                        axis: "h".into(),
                        half_gap: gap_px / 2.0,
                    },
                    SplitAxis::Vertical => ResolvedDivider {
                        node_id: id,
                        x: first_rect.x + first_rect.w + gap_px / 2.0,
                        y: inner.y,
                        length: inner.h,
                        axis: "v".into(),
                        half_gap: gap_px / 2.0,
                    },
                };
                out.push(divider);
                self.walk_dividers(split.first_child, first_rect, out);
                self.walk_dividers(split.second_child, second_rect, out);
            }
        }
    }

    fn walk_backgrounds(&self, id: NodeId, rect: Rect, out: &mut Vec<ResolvedBackground>) {
        let node = match self.tree.get(id) {
            Some(n) => n,
            None => return,
        };

        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        if !node.box_model.bg.is_empty() {
            out.push(ResolvedBackground { rect: inner, color: node.box_model.bg.clone() });
        }

        match &node.kind {
            BspKind::Leaf(_) => {}
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                self.walk_backgrounds(split.first_child, first_rect, out);
                self.walk_backgrounds(split.second_child, second_rect, out);
            }
        }
    }

    fn find_node_rect(&self, id: NodeId, rect: Rect, target_id: NodeId) -> Option<Rect> {
        let node = self.tree.get(id)?;
        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        if id == target_id {
            return Some(inner);
        }

        match &node.kind {
            BspKind::Leaf(_) => None,
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                self.find_node_rect(split.first_child, first_rect, target_id)
                    .or_else(|| self.find_node_rect(split.second_child, second_rect, target_id))
            }
        }
    }

    fn find_node_outer_inner(&self, id: NodeId, rect: Rect, target_id: NodeId) -> Option<(Rect, Rect)> {
        let node = self.tree.get(id)?;
        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        if id == target_id {
            return Some((rect, inner));
        }

        match &node.kind {
            BspKind::Leaf(_) => None,
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                self.find_node_outer_inner(split.first_child, first_rect, target_id)
                    .or_else(|| self.find_node_outer_inner(split.second_child, second_rect, target_id))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Free helpers (used by PDF export)
// ---------------------------------------------------------------------------

/// Resolve image-frame leaves in mm coordinates (for PDF placement).
/// The root rect includes bleed on all sides so edge-touching frames naturally
/// extend into the bleed area without any post-hoc adjustment.
pub fn resolve_mm(
    tree: &BspTree,
    page_w_mm: f32,
    page_h_mm: f32,
    bleed_mm: f32,
) -> Vec<(NodeId, Rect)> {
    let root_rect = Rect::new(
        -bleed_mm, -bleed_mm,
        page_w_mm + 2.0 * bleed_mm,
        page_h_mm + 2.0 * bleed_mm,
    );
    let resolver = LayoutResolver::new(tree, crate::bsp::NULL_ID, 1.0);
    resolver
        .resolve_leaves(root_rect)
        .into_iter()
        .map(|l| (l.id, l.rect))
        .collect()
}

/// Resolve node backgrounds in mm coordinates (for PDF drawing).
/// The root rect includes bleed so backgrounds cover the full bleed-extended area.
pub fn resolve_backgrounds_mm(
    tree: &BspTree,
    spread_w_mm: f32,
    spread_h_mm: f32,
    bleed_mm: f32,
) -> Vec<ResolvedBackground> {
    let root_rect = Rect::new(
        -bleed_mm, -bleed_mm,
        spread_w_mm + 2.0 * bleed_mm,
        spread_h_mm + 2.0 * bleed_mm,
    );
    let resolver = LayoutResolver::new(tree, crate::bsp::NULL_ID, 1.0);
    resolver.resolve_backgrounds(root_rect)
}
