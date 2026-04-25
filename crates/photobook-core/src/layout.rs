use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use crate::bsp::{BspKind, BspTree, NodeId, ObjectFit, PinwheelData, PinwheelOrientation, SplitAxis};

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
    /// gap between the two children of a split node (mm)
    pub gap: f32,
    /// Background fill colour for this node's content area. Empty string = transparent.
    #[serde(default)]
    pub bg: String,
    #[serde(default)]
    pub border: Border,
    /// Visual rotation of this node in degrees counter-clockwise. None = mixed (multi-selection sentinel).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_rotation_deg: Option<f32>,
}

impl Default for BoxModel {
    fn default() -> Self {
        BoxModel {
            margin: EdgeInsets::default(),
            gap: 0.0,
            bg: String::new(),
            border: Border::default(),
            node_rotation_deg: Some(0.0),
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

/// A resolved image frame leaf (for canvas / hit-testing).
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedLeaf {
    pub id: NodeId,
    pub rect: Rect,
    pub image_id: Option<String>,
    pub object_fit: ObjectFit,
    pub pan_x: f32,
    pub pan_y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub is_selected: bool,
    pub is_ancestor: bool,
    pub border_width: f32,
    pub border_color: String,
    pub border_position: BorderPosition,
    /// Node-level visual rotation in degrees (counter-clockwise). Always resolved; never None.
    pub node_rotation_deg: f32,
}

/// A resolved background rect — emitted for every node that has a non-empty `bg` colour.
/// Emitted in tree-walk order (parents before children) so layering is correct.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedBackground {
    pub rect: Rect,
    pub color: String,
}

/// A resolved border for a split node — drawn around its combined content rect.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedSplitBorder {
    pub rect: Rect,
    pub width_px: f32,
    pub color: String,
    pub position: BorderPosition,
}

/// A resolved divider line for drag-resize.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedDivider {
    pub node_id: NodeId,
    pub x: f32,
    pub y: f32,
    pub length: f32,
    pub axis: SplitAxis,
    /// Half the gap in canvas px — used to widen the hit zone to cover the full gap.
    pub half_gap: f32,
}

/// All resolved geometry for one spread — produced by a single DFS traversal.
#[derive(Serialize)]
pub struct ResolvedSpread {
    pub leaves:        Vec<ResolvedLeaf>,
    pub dividers:      Vec<ResolvedDivider>,
    pub backgrounds:   Vec<ResolvedBackground>,
    pub split_borders: Vec<ResolvedSplitBorder>,
    pub cross_handles: Vec<ResolvedCrossHandle>,
}

/// A cross handle appearing at a shared edge between panels.
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedCrossHandle {
    pub parent_id: NodeId,
    pub x: f32,
    pub y: f32,
    /// "rewire", "unlock", or "pinwheel_spawn"
    pub kind: String,
    /// rewire only: true = this segment belongs to the first child of the parent split.
    pub first_child: bool,
    /// Drag direction: "h" = horizontal (X), "v" = vertical (Y).
    pub drag_axis: SplitAxis,
}

/// Outer/inner rects for the selected node's transform handles.
#[derive(Serialize)]
pub struct TransformHandles {
    pub outer: Rect,
    pub inner: Rect,
}

/// Image pan/scale/rotation state for a leaf node.
#[derive(Serialize)]
pub struct LeafTransform {
    pub pan_x: f32,
    pub pan_y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
}

// ---------------------------------------------------------------------------
// Pinwheel geometry helpers (pub(crate) so editor_pinwheel.rs can use them)
// ---------------------------------------------------------------------------

/// Compute the 5 content rects for a pinwheel node given its inner rect.
/// Returns (center, top, right, bottom, left).
/// Compute the 5 content rects for a pinwheel with per-splitter gap values.
/// Each gap_* parameter is the full gap in canvas pixels for the corresponding splitter boundary.
///
/// CW mapping: top_splitter→cx1, right_splitter→cy1, bottom_splitter→cx2, left_splitter→cy2
/// CCW mapping: top_splitter→cx2, right_splitter→cy2, bottom_splitter→cx1, left_splitter→cy1
pub(crate) fn pinwheel_content_rects(
    p: &PinwheelData, inner: Rect,
    gap_top: f32, gap_right: f32, gap_bottom: f32, gap_left: f32,
) -> (Rect, Rect, Rect, Rect, Rect) {
    let l = inner.x;
    let r = inner.x + inner.w;
    let t = inner.y;
    let b = inner.y + inner.h;
    let w = inner.w;
    let h = inner.h;

    let cx1 = l + p.x_top.min(p.x_bottom) * w;
    let cx2 = l + p.x_top.max(p.x_bottom) * w;
    let cy1 = t + p.y_right.min(p.y_left) * h;
    let cy2 = t + p.y_right.max(p.y_left) * h;

    if p.orientation == PinwheelOrientation::Clockwise {
        // top_spl at cx1 (g1), right_spl at cy1 (g2), bottom_spl at cx2 (g3), left_spl at cy2 (g4)
        let (g1, g2, g3, g4) = (gap_top/2.0, gap_right/2.0, gap_bottom/2.0, gap_left/2.0);
        let center = Rect::new(cx1+g1, cy1+g2, (cx2-cx1-g1-g3).max(0.0), (cy2-cy1-g2-g4).max(0.0));
        let top    = Rect::new(cx1+g1, t,      (r-cx1-g1).max(0.0),      (cy1-t-g2).max(0.0));
        let right  = Rect::new(cx2+g3, cy1+g2, (r-cx2-g3).max(0.0),      (b-cy1-g2).max(0.0));
        let bottom = Rect::new(l,      cy2+g4, (cx2-l-g3).max(0.0),      (b-cy2-g4).max(0.0));
        let left   = Rect::new(l,      t,      (cx1-l-g1).max(0.0),      (cy2-t-g4).max(0.0));
        (center, top, right, bottom, left)
    } else {
        // top_spl at cx2 (g1), right_spl at cy2 (g2), bottom_spl at cx1 (g3), left_spl at cy1 (g4)
        let (g1, g2, g3, g4) = (gap_top/2.0, gap_right/2.0, gap_bottom/2.0, gap_left/2.0);
        let center = Rect::new(cx1+g3, cy1+g4, (cx2-cx1-g3-g1).max(0.0), (cy2-cy1-g4-g2).max(0.0));
        let top    = Rect::new(l,      t,      (cx2-l-g1).max(0.0),      (cy1-t-g4).max(0.0));
        let right  = Rect::new(cx2+g1, t,      (r-cx2-g1).max(0.0),      (cy2-t-g2).max(0.0));
        let bottom = Rect::new(cx1+g3, cy2+g2, (r-cx1-g3).max(0.0),      (b-cy2-g2).max(0.0));
        let left   = Rect::new(l,      cy1+g4, (cx1-l-g3).max(0.0),      (b-cy1-g4).max(0.0));
        (center, top, right, bottom, left)
    }
}

/// Compute the 4 splitter divider segments for a pinwheel with per-splitter half-gap values.
/// Each segment spans the full visual line including the center cell edge, so the entire
/// divider is draggable.
pub(crate) fn pinwheel_splitter_dividers(
    p: &PinwheelData, inner: Rect,
    hg_top: f32, hg_right: f32, hg_bottom: f32, hg_left: f32,
) -> [ResolvedDivider; 4] {
    let l = inner.x;
    let r = inner.x + inner.w;
    let t = inner.y;
    let b = inner.y + inner.h;
    let w = inner.w;
    let h = inner.h;

    let cx1 = l + p.x_top.min(p.x_bottom) * w;
    let cx2 = l + p.x_top.max(p.x_bottom) * w;
    let cy1 = t + p.y_right.min(p.y_left) * h;
    let cy2 = t + p.y_right.max(p.y_left) * h;

    if p.orientation == PinwheelOrientation::Clockwise {
        [
            ResolvedDivider { node_id: p.top_splitter,    x: cx1, y: t,   length: (cy2-t).max(0.0),   axis: SplitAxis::Vertical,   half_gap: hg_top },
            ResolvedDivider { node_id: p.right_splitter,  x: cx1, y: cy1, length: (r-cx1).max(0.0),   axis: SplitAxis::Horizontal, half_gap: hg_right },
            ResolvedDivider { node_id: p.bottom_splitter, x: cx2, y: cy1, length: (b-cy1).max(0.0),   axis: SplitAxis::Vertical,   half_gap: hg_bottom },
            ResolvedDivider { node_id: p.left_splitter,   x: l,   y: cy2, length: (cx2-l).max(0.0),   axis: SplitAxis::Horizontal, half_gap: hg_left },
        ]
    } else {
        [
            ResolvedDivider { node_id: p.top_splitter,    x: cx2, y: t,   length: (cy2-t).max(0.0),   axis: SplitAxis::Vertical,   half_gap: hg_top },
            ResolvedDivider { node_id: p.right_splitter,  x: cx1, y: cy2, length: (r-cx1).max(0.0),   axis: SplitAxis::Horizontal, half_gap: hg_right },
            ResolvedDivider { node_id: p.bottom_splitter, x: cx1, y: cy1, length: (b-cy1).max(0.0),   axis: SplitAxis::Vertical,   half_gap: hg_bottom },
            ResolvedDivider { node_id: p.left_splitter,   x: l,   y: cy1, length: (cx2-l).max(0.0),   axis: SplitAxis::Horizontal, half_gap: hg_left },
        ]
    }
}

// ---------------------------------------------------------------------------
// Layout resolver
// ---------------------------------------------------------------------------

/// Compute the two child rects produced by splitting `rect` along `axis` at `ratio` with `gap`.
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
    selection: HashSet<NodeId>,
    ancestors: HashSet<NodeId>,
    mm_to_px: f32,
}

impl<'a> LayoutResolver<'a> {
    pub fn new(tree: &'a BspTree, selection: &[NodeId], mm_to_px: f32) -> Self {
        let selection: HashSet<NodeId> = selection.iter().copied().collect();
        let ancestors: HashSet<NodeId> = {
            let mut seen = HashSet::new();
            for &id in &selection {
                seen.extend(tree.ancestors(id));
            }
            seen
        };
        LayoutResolver { tree, selection, ancestors, mm_to_px }
    }

    /// Single DFS that collects all render data in one pass.
    pub fn resolve_all(&self, root_rect: Rect) -> ResolvedSpread {
        let mut leaves_raw: Vec<(i32, usize, ResolvedLeaf)> = Vec::new();
        let mut dividers   = Vec::new();
        let mut backgrounds = Vec::new();
        let mut split_borders = Vec::new();
        let mut bsp_idx = 0usize;
        let selection  = &self.selection;
        let ancestors  = &self.ancestors;
        let mm_to_px   = self.mm_to_px;
        let tree       = self.tree;

        self.walk_tree(self.tree.root, root_rect, &mut |node, inner| {
            if !node.box_model.bg.is_empty() {
                backgrounds.push(ResolvedBackground { rect: inner, color: node.box_model.bg.clone() });
            }
            match &node.kind {
                BspKind::Leaf(leaf) => {
                    leaves_raw.push((node.z_index, bsp_idx, ResolvedLeaf {
                        id: node.id,
                        rect: inner,
                        image_id: leaf.image_id.clone(),
                        object_fit: leaf.object_fit.clone(),
                        pan_x: leaf.pan_x,
                        pan_y: leaf.pan_y,
                        scale: leaf.scale,
                        rotation_deg: leaf.rotation_deg,
                        is_selected: selection.contains(&node.id),
                        is_ancestor: ancestors.contains(&node.id),
                        border_width: node.box_model.border.width * mm_to_px,
                        border_color: node.box_model.border.color.clone(),
                        border_position: node.box_model.border.position.clone(),
                        node_rotation_deg: node.box_model.node_rotation_deg.unwrap_or(0.0),
                    }));
                    bsp_idx += 1;
                }
                BspKind::Split(split) => {
                    let gap_px = node.box_model.gap * mm_to_px;
                    let (first_rect, _) = split_children(inner, split.axis, split.ratio, gap_px);
                    dividers.push(match split.axis {
                        SplitAxis::Horizontal => ResolvedDivider {
                            node_id: node.id,
                            x: inner.x,
                            y: first_rect.y + first_rect.h + gap_px / 2.0,
                            length: inner.w,
                            axis: SplitAxis::Horizontal,
                            half_gap: gap_px / 2.0,
                        },
                        SplitAxis::Vertical => ResolvedDivider {
                            node_id: node.id,
                            x: first_rect.x + first_rect.w + gap_px / 2.0,
                            y: inner.y,
                            length: inner.h,
                            axis: SplitAxis::Vertical,
                            half_gap: gap_px / 2.0,
                        },
                    });
                    if node.box_model.border.width > 0.0 {
                        split_borders.push(ResolvedSplitBorder {
                            rect: inner,
                            width_px: node.box_model.border.width * mm_to_px,
                            color: node.box_model.border.color.clone(),
                            position: node.box_model.border.position.clone(),
                        });
                    }
                }
                BspKind::Pinwheel(p) => {
                    let g = |id| tree.get(id).map_or(0.0, |n| n.box_model.gap * mm_to_px / 2.0);
                    for div in &pinwheel_splitter_dividers(p, inner, g(p.top_splitter), g(p.right_splitter), g(p.bottom_splitter), g(p.left_splitter)) {
                        dividers.push(div.clone());
                    }
                }
                BspKind::PinwheelSplitter(_) => {}
            }
        });

        leaves_raw.sort_by_key(|(z, pos, _)| (*z, *pos as i32));
        let leaves = leaves_raw.into_iter().map(|(_, _, l)| l).collect();
        let cross_handles = compute_cross_handles_from_tree(self.tree, &dividers);
        ResolvedSpread { leaves, dividers, backgrounds, split_borders, cross_handles }
    }

    pub fn resolve_leaves(&self, root_rect: Rect) -> Vec<ResolvedLeaf> {
        let mut collected: Vec<(i32, usize, ResolvedLeaf)> = Vec::new();
        let mut bsp_idx = 0usize;
        let selection = &self.selection;
        let ancestors = &self.ancestors;
        let mm_to_px = self.mm_to_px;
        self.walk_tree(self.tree.root, root_rect, &mut |node, inner| {
            let BspKind::Leaf(leaf) = &node.kind else { return };
            collected.push((node.z_index, bsp_idx, ResolvedLeaf {
                id: node.id,
                rect: inner,
                image_id: leaf.image_id.clone(),
                object_fit: leaf.object_fit.clone(),
                pan_x: leaf.pan_x,
                pan_y: leaf.pan_y,
                scale: leaf.scale,
                rotation_deg: leaf.rotation_deg,
                is_selected: selection.contains(&node.id),
                is_ancestor: ancestors.contains(&node.id),
                border_width: node.box_model.border.width * mm_to_px,
                border_color: node.box_model.border.color.clone(),
                border_position: node.box_model.border.position.clone(),
                node_rotation_deg: node.box_model.node_rotation_deg.unwrap_or(0.0),
            }));
            bsp_idx += 1;
        });
        collected.sort_by_key(|(z, pos, _)| (*z, *pos as i32));
        collected.into_iter().map(|(_, _, leaf)| leaf).collect()
    }

    pub fn resolve_dividers(&self, root_rect: Rect) -> Vec<ResolvedDivider> {
        let mut out = Vec::new();
        let mm_to_px = self.mm_to_px;
        let tree = self.tree;
        self.walk_tree(self.tree.root, root_rect, &mut |node, inner| {
            match &node.kind {
                BspKind::Split(split) => {
                    let gap_px = node.box_model.gap * mm_to_px;
                    let (first_rect, _) = split_children(inner, split.axis, split.ratio, gap_px);
                    let divider = match split.axis {
                        SplitAxis::Horizontal => ResolvedDivider {
                            node_id: node.id,
                            x: inner.x,
                            y: first_rect.y + first_rect.h + gap_px / 2.0,
                            length: inner.w,
                            axis: SplitAxis::Horizontal,
                            half_gap: gap_px / 2.0,
                        },
                        SplitAxis::Vertical => ResolvedDivider {
                            node_id: node.id,
                            x: first_rect.x + first_rect.w + gap_px / 2.0,
                            y: inner.y,
                            length: inner.h,
                            axis: SplitAxis::Vertical,
                            half_gap: gap_px / 2.0,
                        },
                    };
                    out.push(divider);
                }
                BspKind::Pinwheel(p) => {
                    let g = |id| tree.get(id).map_or(0.0, |n| n.box_model.gap * mm_to_px / 2.0);
                    for div in &pinwheel_splitter_dividers(p, inner, g(p.top_splitter), g(p.right_splitter), g(p.bottom_splitter), g(p.left_splitter)) {
                        out.push(div.clone());
                    }
                }
                _ => {}
            }
        });
        out
    }

    /// Resolve background rects for every node that has a non-empty `bg` colour.
    pub fn resolve_backgrounds(&self, root_rect: Rect) -> Vec<ResolvedBackground> {
        let mut out = Vec::new();
        self.walk_tree(self.tree.root, root_rect, &mut |node, inner| {
            if !node.box_model.bg.is_empty() {
                out.push(ResolvedBackground { rect: inner, color: node.box_model.bg.clone() });
            }
        });
        out
    }

    /// Resolve borders for all split nodes that have a non-zero border width.
    pub fn resolve_split_borders(&self, root_rect: Rect) -> Vec<ResolvedSplitBorder> {
        let mut out = Vec::new();
        let mm_to_px = self.mm_to_px;
        self.walk_tree(self.tree.root, root_rect, &mut |node, inner| {
            if matches!(&node.kind, BspKind::Split(_)) && node.box_model.border.width > 0.0 {
                out.push(ResolvedSplitBorder {
                    rect: inner,
                    width_px: node.box_model.border.width * mm_to_px,
                    color: node.box_model.border.color.clone(),
                    position: node.box_model.border.position.clone(),
                });
            }
        });
        out
    }

    /// Find cross handles using tree-based detection.
    pub fn resolve_cross_handles(&self, root_rect: Rect) -> Vec<ResolvedCrossHandle> {
        let dividers = self.resolve_dividers(root_rect);
        compute_cross_handles_from_tree(self.tree, &dividers)
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
    // Private: generic tree walker
    // -----------------------------------------------------------------------

    fn walk_tree(&self, id: NodeId, rect: Rect, f: &mut impl FnMut(&crate::bsp::BspNode, Rect)) {
        let Some(node) = self.tree.get(id) else { return };
        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        // Compute child routing before calling f (so closures can borrow node data).
        let children: Vec<(NodeId, Rect)> = match &node.kind {
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (fr, sr) = split_children(inner, split.axis, split.ratio, gap_px);
                vec![(split.first_child, fr), (split.second_child, sr)]
            }
            BspKind::Pinwheel(p) => {
                let g = |id| self.tree.get(id).map_or(0.0, |n| n.box_model.gap * self.mm_to_px);
                let (cr, tr, rr, br, lr) = pinwheel_content_rects(p, inner, g(p.top_splitter), g(p.right_splitter), g(p.bottom_splitter), g(p.left_splitter));
                vec![
                    (p.center, cr),
                    (p.top,    tr),
                    (p.right,  rr),
                    (p.bottom, br),
                    (p.left,   lr),
                ]
            }
            _ => vec![],
        };

        f(node, inner);

        for (child_id, child_rect) in children {
            self.walk_tree(child_id, child_rect, f);
        }
    }

    // -----------------------------------------------------------------------
    // Private: targeted node search (early exit, not suitable for walk_tree)
    // -----------------------------------------------------------------------

    fn find_node_rect(&self, id: NodeId, rect: Rect, target_id: NodeId) -> Option<Rect> {
        let node = self.tree.get(id)?;
        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);

        if id == target_id {
            return Some(inner);
        }

        match &node.kind {
            BspKind::Leaf(_) => None,
            BspKind::PinwheelSplitter(_) => None,
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                self.find_node_rect(split.first_child, first_rect, target_id)
                    .or_else(|| self.find_node_rect(split.second_child, second_rect, target_id))
            }
            BspKind::Pinwheel(p) => {
                let g = |id| self.tree.get(id).map_or(0.0, |n| n.box_model.gap * self.mm_to_px);
                let (cr, tr, rr, br, lr) = pinwheel_content_rects(p, inner, g(p.top_splitter), g(p.right_splitter), g(p.bottom_splitter), g(p.left_splitter));
                // Also check if target is one of the 4 splitter nodes (return pinwheel's inner rect)
                if [p.top_splitter, p.right_splitter, p.bottom_splitter, p.left_splitter].contains(&target_id) {
                    return Some(inner);
                }
                self.find_node_rect(p.center, cr, target_id)
                    .or_else(|| self.find_node_rect(p.top,    tr, target_id))
                    .or_else(|| self.find_node_rect(p.right,  rr, target_id))
                    .or_else(|| self.find_node_rect(p.bottom, br, target_id))
                    .or_else(|| self.find_node_rect(p.left,   lr, target_id))
            }
        }
    }

    fn find_node_outer_inner(&self, id: NodeId, rect: Rect, target_id: NodeId) -> Option<(Rect, Rect)> {
        let node = self.tree.get(id)?;
        let margin_px = node.box_model.margin.scale(self.mm_to_px);
        let inner = rect.inset(&margin_px);
        let outer = rect;

        if id == target_id {
            return Some((outer, inner));
        }

        match &node.kind {
            BspKind::Leaf(_) => None,
            BspKind::PinwheelSplitter(_) => None,
            BspKind::Split(split) => {
                let gap_px = node.box_model.gap * self.mm_to_px;
                let (first_rect, second_rect) =
                    split_children(inner, split.axis, split.ratio, gap_px);
                self.find_node_outer_inner(split.first_child, first_rect, target_id)
                    .or_else(|| self.find_node_outer_inner(split.second_child, second_rect, target_id))
            }
            BspKind::Pinwheel(p) => {
                let g = |id| self.tree.get(id).map_or(0.0, |n| n.box_model.gap * self.mm_to_px);
                let (cr, tr, rr, br, lr) = pinwheel_content_rects(p, inner, g(p.top_splitter), g(p.right_splitter), g(p.bottom_splitter), g(p.left_splitter));
                self.find_node_outer_inner(p.center, cr, target_id)
                    .or_else(|| self.find_node_outer_inner(p.top,    tr, target_id))
                    .or_else(|| self.find_node_outer_inner(p.right,  rr, target_id))
                    .or_else(|| self.find_node_outer_inner(p.bottom, br, target_id))
                    .or_else(|| self.find_node_outer_inner(p.left,   lr, target_id))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tree-based cross-handle detection
// ---------------------------------------------------------------------------

/// Detect X-junction cross handles using tree traversal.
/// Emits "rewire" and "unlock" handles for qualifying junctions, plus
/// "pinwheel_spawn" handles at the junction centre for 2×2 leaf configurations.
pub(crate) fn compute_cross_handles_from_tree(
    tree: &BspTree,
    dividers: &[ResolvedDivider],
) -> Vec<ResolvedCrossHandle> {
    const ALIGN_PX: f32 = 3.0;

    let divider_map: HashMap<NodeId, &ResolvedDivider> =
        dividers.iter().map(|d| (d.node_id, d)).collect();

    let mut handles = Vec::new();

    // --- V-primary junctions ---
    for (&p_id, p_node) in &tree.nodes {
        let p_split = match &p_node.kind {
            BspKind::Split(s) if s.axis == SplitAxis::Vertical => s.clone(),
            _ => continue,
        };
        let p_div = match divider_map.get(&p_id) {
            Some(d) => d,
            None => continue,
        };

        let left_ms  = border_h_splits_left(tree,  p_split.first_child);
        let right_ms = border_h_splits_right(tree, p_split.second_child);

        'v_outer: for &left_m in &left_ms {
            let left_div = match divider_map.get(&left_m) {
                Some(d) => d,
                None => continue,
            };
            for &right_m in &right_ms {
                let right_div = match divider_map.get(&right_m) {
                    Some(d) => d,
                    None => continue,
                };
                if (left_div.y - right_div.y).abs() >= ALIGN_PX {
                    continue;
                }

                // Leaf constraint
                let (lfc, lsc) = match tree.get(left_m).map(|n| &n.kind) {
                    Some(BspKind::Split(s)) => (s.first_child, s.second_child),
                    _ => continue,
                };
                let (rfc, rsc) = match tree.get(right_m).map(|n| &n.kind) {
                    Some(BspKind::Split(s)) => (s.first_child, s.second_child),
                    _ => continue,
                };
                if !is_leaf_node(tree, lfc) || !is_leaf_node(tree, lsc) { continue; }
                if !is_leaf_node(tree, rfc) || !is_leaf_node(tree, rsc) { continue; }

                let y_cross = (left_div.y + right_div.y) / 2.0;

                // Rewire and pinwheel-spawn require left_m/right_m to be direct
                // children of p_id.  Non-trivial junctions (inner splits nested
                // deeper) would corrupt the tree if rewired, so only emit those
                // handles for the trivial case.
                if left_m == p_split.first_child && right_m == p_split.second_child {
                    handles.push(ResolvedCrossHandle {
                        parent_id: p_id, x: p_div.x,
                        y: (p_div.y + y_cross) / 2.0,
                        kind: "rewire".into(), first_child: true,
                        drag_axis: SplitAxis::Horizontal,
                    });
                    handles.push(ResolvedCrossHandle {
                        parent_id: p_id, x: p_div.x,
                        y: (y_cross + p_div.y + p_div.length) / 2.0,
                        kind: "rewire".into(), first_child: false,
                        drag_axis: SplitAxis::Horizontal,
                    });
                    // Pinwheel spawn handle at junction centre
                    handles.push(ResolvedCrossHandle {
                        parent_id: p_id,
                        x: p_div.x,
                        y: y_cross,
                        kind: "pinwheel_spawn".into(),
                        first_child: false,
                        drag_axis: SplitAxis::Vertical,
                    });
                }
                handles.push(ResolvedCrossHandle {
                    parent_id: left_m,
                    x: left_div.x + left_div.length / 2.0, y: left_div.y,
                    kind: "unlock".into(), first_child: false,
                    drag_axis: SplitAxis::Vertical,
                });
                handles.push(ResolvedCrossHandle {
                    parent_id: right_m,
                    x: right_div.x + right_div.length / 2.0, y: right_div.y,
                    kind: "unlock".into(), first_child: false,
                    drag_axis: SplitAxis::Vertical,
                });

                break 'v_outer;
            }
        }
    }

    // --- H-primary junctions ---
    for (&p_id, p_node) in &tree.nodes {
        let p_split = match &p_node.kind {
            BspKind::Split(s) if s.axis == SplitAxis::Horizontal => s.clone(),
            _ => continue,
        };
        let p_div = match divider_map.get(&p_id) {
            Some(d) => d,
            None => continue,
        };

        let top_vs = border_v_splits_top(tree, p_split.first_child);
        let bot_vs = border_v_splits_bot(tree, p_split.second_child);

        'h_outer: for &top_v in &top_vs {
            let top_div = match divider_map.get(&top_v) {
                Some(d) => d,
                None => continue,
            };
            for &bot_v in &bot_vs {
                let bot_div = match divider_map.get(&bot_v) {
                    Some(d) => d,
                    None => continue,
                };
                if (top_div.x - bot_div.x).abs() >= ALIGN_PX {
                    continue;
                }

                let (tfc, tsc) = match tree.get(top_v).map(|n| &n.kind) {
                    Some(BspKind::Split(s)) => (s.first_child, s.second_child),
                    _ => continue,
                };
                let (bfc, bsc) = match tree.get(bot_v).map(|n| &n.kind) {
                    Some(BspKind::Split(s)) => (s.first_child, s.second_child),
                    _ => continue,
                };
                if !is_leaf_node(tree, tfc) || !is_leaf_node(tree, tsc) { continue; }
                if !is_leaf_node(tree, bfc) || !is_leaf_node(tree, bsc) { continue; }

                let x_cross = (top_div.x + bot_div.x) / 2.0;

                // Rewire and pinwheel-spawn require top_v/bot_v to be direct
                // children of p_id.  Non-trivial junctions would corrupt the tree.
                if top_v == p_split.first_child && bot_v == p_split.second_child {
                    handles.push(ResolvedCrossHandle {
                        parent_id: p_id, y: p_div.y,
                        x: (p_div.x + x_cross) / 2.0,
                        kind: "rewire".into(), first_child: true,
                        drag_axis: SplitAxis::Vertical,
                    });
                    handles.push(ResolvedCrossHandle {
                        parent_id: p_id, y: p_div.y,
                        x: (x_cross + p_div.x + p_div.length) / 2.0,
                        kind: "rewire".into(), first_child: false,
                        drag_axis: SplitAxis::Vertical,
                    });
                    handles.push(ResolvedCrossHandle {
                        parent_id: p_id,
                        x: x_cross,
                        y: p_div.y,
                        kind: "pinwheel_spawn".into(),
                        first_child: false,
                        drag_axis: SplitAxis::Horizontal,
                    });
                }
                handles.push(ResolvedCrossHandle {
                    parent_id: top_v,
                    x: top_div.x, y: top_div.y + top_div.length / 2.0,
                    kind: "unlock".into(), first_child: false,
                    drag_axis: SplitAxis::Horizontal,
                });
                handles.push(ResolvedCrossHandle {
                    parent_id: bot_v,
                    x: bot_div.x, y: bot_div.y + bot_div.length / 2.0,
                    kind: "unlock".into(), first_child: false,
                    drag_axis: SplitAxis::Horizontal,
                });

                break 'h_outer;
            }
        }
    }

    handles
}

// ---------------------------------------------------------------------------
// Border-traversal helpers for tree-based junction detection
// ---------------------------------------------------------------------------

/// Collect H-splits on the right border of a subtree (adjacent to a V-primary's divider
/// when this subtree is the PRIMARY's LEFT child).
fn border_h_splits_left(tree: &BspTree, id: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    if let Some(node) = tree.get(id) {
        match &node.kind {
            BspKind::Leaf(_) | BspKind::Pinwheel(_) | BspKind::PinwheelSplitter(_) => {}
            BspKind::Split(s) if s.axis == SplitAxis::Horizontal => {
                result.push(id);
                result.extend(border_h_splits_left(tree, s.first_child));
                result.extend(border_h_splits_left(tree, s.second_child));
            }
            BspKind::Split(s) => {
                // V-split: take second_child (rightmost, toward P's divider)
                result.extend(border_h_splits_left(tree, s.second_child));
            }
        }
    }
    result
}

/// Collect H-splits on the left border of a subtree (adjacent to a V-primary's divider
/// when this subtree is the PRIMARY's RIGHT child).
fn border_h_splits_right(tree: &BspTree, id: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    if let Some(node) = tree.get(id) {
        match &node.kind {
            BspKind::Leaf(_) | BspKind::Pinwheel(_) | BspKind::PinwheelSplitter(_) => {}
            BspKind::Split(s) if s.axis == SplitAxis::Horizontal => {
                result.push(id);
                result.extend(border_h_splits_right(tree, s.first_child));
                result.extend(border_h_splits_right(tree, s.second_child));
            }
            BspKind::Split(s) => {
                // V-split: take first_child (leftmost, toward P's divider)
                result.extend(border_h_splits_right(tree, s.first_child));
            }
        }
    }
    result
}

/// Collect V-splits on the bottom border of a subtree (H-primary TOP child).
fn border_v_splits_top(tree: &BspTree, id: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    if let Some(node) = tree.get(id) {
        match &node.kind {
            BspKind::Leaf(_) | BspKind::Pinwheel(_) | BspKind::PinwheelSplitter(_) => {}
            BspKind::Split(s) if s.axis == SplitAxis::Vertical => {
                result.push(id);
                result.extend(border_v_splits_top(tree, s.first_child));
                result.extend(border_v_splits_top(tree, s.second_child));
            }
            BspKind::Split(s) => {
                // H-split: take second_child (bottom, toward P's divider)
                result.extend(border_v_splits_top(tree, s.second_child));
            }
        }
    }
    result
}

/// Collect V-splits on the top border of a subtree (H-primary BOTTOM child).
fn border_v_splits_bot(tree: &BspTree, id: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    if let Some(node) = tree.get(id) {
        match &node.kind {
            BspKind::Leaf(_) | BspKind::Pinwheel(_) | BspKind::PinwheelSplitter(_) => {}
            BspKind::Split(s) if s.axis == SplitAxis::Vertical => {
                result.push(id);
                result.extend(border_v_splits_bot(tree, s.first_child));
                result.extend(border_v_splits_bot(tree, s.second_child));
            }
            BspKind::Split(s) => {
                // H-split: take first_child (top, toward P's divider)
                result.extend(border_v_splits_bot(tree, s.first_child));
            }
        }
    }
    result
}

fn is_leaf_node(tree: &BspTree, id: NodeId) -> bool {
    matches!(tree.get(id).map(|n| &n.kind), Some(BspKind::Leaf(_)))
}

// ---------------------------------------------------------------------------
// Free helpers (used by PDF export)
// ---------------------------------------------------------------------------

/// Resolve image-frame leaves in mm coordinates (for PDF placement).
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
    let resolver = LayoutResolver::new(tree, &[], 1.0);
    resolver
        .resolve_leaves(root_rect)
        .into_iter()
        .map(|l| (l.id, l.rect))
        .collect()
}

/// Resolve node backgrounds in mm coordinates (for PDF drawing).
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
    let resolver = LayoutResolver::new(tree, &[], 1.0);
    resolver.resolve_backgrounds(root_rect)
}
