use wasm_bindgen::prelude::*;
use crate::bsp::{
    BspKind, BspNode, LeafData, NodeId,
    PinwheelData, PinwheelOrientation, PinwheelSplitterData, PinwheelSplitterRole,
    SplitData, SplitAxis,
};
use crate::layout::{LayoutResolver, pinwheel_content_rects};
use crate::PhotobookEditor;

// ---------------------------------------------------------------------------
// Drag state for pinwheel spawn
// ---------------------------------------------------------------------------

pub(crate) struct DragPinwheelSpawn {
    pub pinwheel_id: NodeId,
    /// Spread-relative px coords of the X-junction centre (where drag started).
    pub junction_x: f32,
    pub junction_y: f32,
}

// ---------------------------------------------------------------------------
// Spawn: convert X-junction (P V-split + M/S H-splits + 4 leaves) → Pinwheel
// ---------------------------------------------------------------------------

impl PhotobookEditor {
    /// Convert a qualifying 2×2 X-junction rooted at `p_id` into a Pinwheel node.
    /// `p_id` may be either a V-split (children are H-splits) or an H-split
    /// (children are V-splits). In both cases the four leaf quadrants are
    /// mapped to the Pinwheel's top/right/bottom/left panels.
    ///
    /// For V-primary junctions the existing children (m, s) are repurposed as
    /// left/right splitters and two new nodes become top/bottom splitters.
    /// For H-primary junctions the children (m, s) are repurposed as
    /// top/bottom splitters and two new nodes become left/right splitters.
    /// Either way, dissolution always produces a valid V-primary BSP because
    /// `dissolve_pinwheel_to_xjunction` only references left/right splitters.
    pub(crate) fn spawn_pinwheel(
        &mut self,
        p_id: NodeId,
        orientation: PinwheelOrientation,
        x_top: f32, y_right: f32, x_bottom: f32, y_left: f32,
    ) -> bool {
        let tree = &self.doc.current_spread().tree;

        let (outer_axis, m_id, s_id) = match tree.get(p_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => (s.axis, s.first_child, s.second_child),
            _ => return false,
        };

        // Extract the four leaf quadrants (TL, TR, BL, BR) based on outer axis.
        //   V-primary: m=left-H-split → (TL, BL);  s=right-H-split → (TR, BR)
        //   H-primary: m=top-V-split  → (TL, TR);  s=bot-V-split   → (BL, BR)
        let (m_fc, m_sc) = match tree.get(m_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => (s.first_child, s.second_child),
            _ => return false,
        };
        let (s_fc, s_sc) = match tree.get(s_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => (s.first_child, s.second_child),
            _ => return false,
        };
        let (tl_id, tr_id, bl_id, br_id) = match outer_axis {
            SplitAxis::Vertical   => (m_fc, s_fc, m_sc, s_sc),
            SplitAxis::Horizontal => (m_fc, m_sc, s_fc, s_sc),
        };

        // Allocate 3 new nodes.
        let new_a_id  = self.doc.current_spread_mut().tree.alloc_node_id();
        let new_b_id  = self.doc.current_spread_mut().tree.alloc_node_id();
        let center_id = self.doc.current_spread_mut().tree.alloc_node_id();

        // Panel assignment from orientation.
        let (top_id, right_id, bottom_id, left_id) = if orientation == PinwheelOrientation::Clockwise {
            (tr_id, br_id, bl_id, tl_id)
        } else {
            (tl_id, tr_id, br_id, bl_id)
        };

        // For V-primary: m→left, s→right; new_a→top, new_b→bottom.
        // For H-primary: m→top,  s→bottom; new_a→left, new_b→right.
        let (top_spl_id, right_spl_id, bottom_spl_id, left_spl_id) = match outer_axis {
            SplitAxis::Vertical   => (new_a_id, s_id,     new_b_id, m_id    ),
            SplitAxis::Horizontal => (m_id,     new_a_id, s_id,     new_b_id),
        };

        let tree = &mut self.doc.current_spread_mut().tree;

        tree.insert_node(BspNode {
            id: new_a_id,
            parent: Some(p_id),
            kind: BspKind::PinwheelSplitter(PinwheelSplitterData {
                pinwheel_id: p_id,
                role: match outer_axis {
                    SplitAxis::Vertical   => PinwheelSplitterRole::Top,
                    SplitAxis::Horizontal => PinwheelSplitterRole::Right,
                },
            }),
            box_model: Default::default(),
            z_index: 0,
        });
        tree.insert_node(BspNode {
            id: new_b_id,
            parent: Some(p_id),
            kind: BspKind::PinwheelSplitter(PinwheelSplitterData {
                pinwheel_id: p_id,
                role: match outer_axis {
                    SplitAxis::Vertical   => PinwheelSplitterRole::Bottom,
                    SplitAxis::Horizontal => PinwheelSplitterRole::Left,
                },
            }),
            box_model: Default::default(),
            z_index: 0,
        });
        tree.insert_node(BspNode {
            id: center_id,
            parent: Some(p_id),
            kind: BspKind::Leaf(LeafData::default()),
            box_model: Default::default(),
            z_index: 0,
        });

        // Repurpose the two existing inner-split nodes into their splitter roles.
        let (m_role, s_role) = match outer_axis {
            SplitAxis::Vertical   => (PinwheelSplitterRole::Left,   PinwheelSplitterRole::Right),
            SplitAxis::Horizontal => (PinwheelSplitterRole::Top,    PinwheelSplitterRole::Bottom),
        };
        if let Some(n) = tree.get_mut(m_id) {
            n.kind = BspKind::PinwheelSplitter(PinwheelSplitterData { pinwheel_id: p_id, role: m_role });
            n.parent = Some(p_id);
        }
        if let Some(n) = tree.get_mut(s_id) {
            n.kind = BspKind::PinwheelSplitter(PinwheelSplitterData { pinwheel_id: p_id, role: s_role });
            n.parent = Some(p_id);
        }

        // Update parent pointers for the 4 outer content panels.
        for &id in &[top_id, right_id, bottom_id, left_id] {
            if let Some(n) = tree.get_mut(id) {
                n.parent = Some(p_id);
            }
        }

        // Repurpose P → Pinwheel.
        if let Some(n) = tree.get_mut(p_id) {
            n.kind = BspKind::Pinwheel(PinwheelData {
                orientation,
                x_top, y_right, x_bottom, y_left,
                center: center_id,
                top:    top_id,
                right:  right_id,
                bottom: bottom_id,
                left:   left_id,
                top_splitter:    top_spl_id,
                right_splitter:  right_spl_id,
                bottom_splitter: bottom_spl_id,
                left_splitter:   left_spl_id,
            });
        }
        true
    }

    // -----------------------------------------------------------------------
    // Dissolution: center deleted → X-junction
    // -----------------------------------------------------------------------

    /// Dissolve a Pinwheel back to the original 4-cell X-junction BSP.
    /// Called when the center panel is deleted.
    pub(crate) fn dissolve_pinwheel_to_xjunction(&mut self, pinwheel_id: NodeId) -> bool {
        let tree = &self.doc.current_spread().tree;

        let p = match tree.get(pinwheel_id).map(|n| &n.kind) {
            Some(BspKind::Pinwheel(p)) => p.clone(),
            _ => return false,
        };

        // Recover TL/TR/BL/BR from orientation + panel assignment (§4.3 table).
        let (tl_id, tr_id, bl_id, br_id) = if p.orientation == PinwheelOrientation::Clockwise {
            (p.left, p.top, p.bottom, p.right)
        } else {
            (p.top, p.right, p.left, p.bottom)
        };

        // Mid-point of the center cell in fractional coordinates.
        let cx1 = p.x_top.min(p.x_bottom);
        let cx2 = p.x_top.max(p.x_bottom);
        let cy1 = p.y_right.min(p.y_left);
        let cy2 = p.y_right.max(p.y_left);

        let v_ratio = ((cx1 + cx2) / 2.0).clamp(0.05, 0.95);
        let h_ratio = ((cy1 + cy2) / 2.0).clamp(0.05, 0.95);

        let m_id       = p.left_splitter;
        let s_id       = p.right_splitter;
        let top_spl_id = p.top_splitter;
        let bot_spl_id = p.bottom_splitter;
        let center_id  = p.center;

        let tree = &mut self.doc.current_spread_mut().tree;

        // Repurpose left_splitter (M) → left H-split.
        if let Some(n) = tree.get_mut(m_id) {
            n.kind = BspKind::Split(SplitData {
                axis: SplitAxis::Horizontal,
                ratio: h_ratio,
                first_child: tl_id,
                second_child: bl_id,
            });
            n.parent = Some(pinwheel_id);
        }
        if let Some(n) = tree.get_mut(tl_id) { n.parent = Some(m_id); }
        if let Some(n) = tree.get_mut(bl_id) { n.parent = Some(m_id); }

        // Repurpose right_splitter (S) → right H-split.
        if let Some(n) = tree.get_mut(s_id) {
            n.kind = BspKind::Split(SplitData {
                axis: SplitAxis::Horizontal,
                ratio: h_ratio,
                first_child: tr_id,
                second_child: br_id,
            });
            n.parent = Some(pinwheel_id);
        }
        if let Some(n) = tree.get_mut(tr_id) { n.parent = Some(s_id); }
        if let Some(n) = tree.get_mut(br_id) { n.parent = Some(s_id); }

        // Repurpose Pinwheel node → V-split.
        if let Some(n) = tree.get_mut(pinwheel_id) {
            n.kind = BspKind::Split(SplitData {
                axis: SplitAxis::Vertical,
                ratio: v_ratio,
                first_child: m_id,
                second_child: s_id,
            });
        }

        // Free the two extra splitter nodes and the center leaf.
        tree.nodes.remove(&top_spl_id);
        tree.nodes.remove(&bot_spl_id);
        tree.nodes.remove(&center_id);

        true
    }

    // -----------------------------------------------------------------------
    // Parameter update helpers
    // -----------------------------------------------------------------------

    pub(crate) fn update_pinwheel_spawn_params(
        &mut self,
        pinwheel_id: NodeId,
        orientation: PinwheelOrientation,
        x_top: f32, y_right: f32, x_bottom: f32, y_left: f32,
    ) {
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(pinwheel_id) {
            if let BspKind::Pinwheel(ref mut p) = node.kind {
                p.orientation = orientation;
                p.x_top    = x_top;
                p.y_right  = y_right;
                p.x_bottom = x_bottom;
                p.y_left   = y_left;
            }
        }
    }

    /// Update the pinwheel parameter controlled by a splitter after a divider drag.
    /// `ratio` is in [0, 1] relative to the pinwheel's inner rect on the drag axis.
    /// Called from `update_divider_drag` when `node_id` is a PinwheelSplitter.
    pub(crate) fn update_pinwheel_splitter_param(&mut self, splitter_id: NodeId, ratio: f32) {
        let tree = &self.doc.current_spread().tree;
        let (pinwheel_id, role) = match tree.get(splitter_id).map(|n| &n.kind) {
            Some(BspKind::PinwheelSplitter(spl)) => (spl.pinwheel_id, spl.role),
            _ => return,
        };
        let pd_old = match tree.get(pinwheel_id).map(|n| &n.kind) {
            Some(BspKind::Pinwheel(p)) => p.clone(),
            _ => return,
        };

        const MIN_FRAC: f32 = 0.05;
        let clamped = ratio.clamp(MIN_FRAC, 1.0 - MIN_FRAC);

        let mut pd = pd_old.clone();
        match role {
            PinwheelSplitterRole::Top    => pd.x_top    = clamped,
            PinwheelSplitterRole::Right  => pd.y_right  = clamped,
            PinwheelSplitterRole::Bottom => pd.x_bottom = clamped,
            PinwheelSplitterRole::Left   => pd.y_left   = clamped,
        }

        // Detect orientation flip from the parameter that just changed.
        let was_cw = pd_old.orientation == PinwheelOrientation::Clockwise;
        let should_be_cw = match role {
            PinwheelSplitterRole::Top | PinwheelSplitterRole::Bottom =>
                pd.x_top < pd.x_bottom,
            PinwheelSplitterRole::Right | PinwheelSplitterRole::Left =>
                pd.y_right < pd.y_left,
        };

        if should_be_cw != was_cw {
            // Swap both parameter pairs so both invariants hold.
            std::mem::swap(&mut pd.x_top, &mut pd.x_bottom);
            std::mem::swap(&mut pd.y_right, &mut pd.y_left);

            // Cyclically rotate panel IDs so the same leaf stays in the same
            // geometric quadrant (TL→TL, TR→TR, etc.) across the flip.
            let (t, r, b, l) = (pd.top, pd.right, pd.bottom, pd.left);
            if was_cw {
                // CW → CCW: new=(old_left, old_top, old_right, old_bottom)
                pd.top = l; pd.right = t; pd.bottom = r; pd.left = b;
                pd.orientation = PinwheelOrientation::AntiClockwise;
            } else {
                // CCW → CW: new=(old_right, old_bottom, old_left, old_top)
                pd.top = r; pd.right = b; pd.bottom = l; pd.left = t;
                pd.orientation = PinwheelOrientation::Clockwise;
            }
        }

        let tree = &mut self.doc.current_spread_mut().tree;
        if let Some(node) = tree.get_mut(pinwheel_id) {
            if let BspKind::Pinwheel(ref mut p) = node.kind {
                *p = pd;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Delete panel
    // -----------------------------------------------------------------------

    pub(crate) fn delete_pinwheel_panel_inner(&mut self, panel_id: NodeId) -> bool {
        let tree = &self.doc.current_spread().tree;
        let pinwheel_id = match tree.get(panel_id).and_then(|n| n.parent) {
            Some(id) => id,
            None => return false,
        };

        let p = match tree.get(pinwheel_id).map(|n| &n.kind) {
            Some(BspKind::Pinwheel(p)) => p.clone(),
            _ => return false,
        };

        if panel_id == p.center {
            return self.dissolve_pinwheel_to_xjunction(pinwheel_id);
        }

        // Outer panel: only allowed when the panel is a leaf.
        if !matches!(
            self.doc.current_spread().tree.get(panel_id).map(|n| &n.kind),
            Some(BspKind::Leaf(_))
        ) {
            return false;
        }

        self.dissolve_outer_panel(pinwheel_id, panel_id, &p)
    }

    fn dissolve_outer_panel(
        &mut self,
        pinwheel_id: NodeId,
        deleted: NodeId,
        p: &PinwheelData,
    ) -> bool {
        // Determine which role the deleted panel has and which parameter to collapse.
        let is_cw = p.orientation == PinwheelOrientation::Clockwise;

        let (tl_id, tr_id, bl_id, br_id) = if is_cw {
            (p.left, p.top, p.bottom, p.right)
        } else {
            (p.top, p.right, p.left, p.bottom)
        };

        let cx1_f = p.x_top.min(p.x_bottom);
        let cx2_f = p.x_top.max(p.x_bottom);
        let cy1_f = p.y_right.min(p.y_left);
        let cy2_f = p.y_right.max(p.y_left);

        let m_id       = p.left_splitter;
        let s_id       = p.right_splitter;
        let top_spl_id = p.top_splitter;
        let bot_spl_id = p.bottom_splitter;
        let center_id  = p.center;

        // Read per-splitter gaps before any node is repurposed.
        let gap = |id: NodeId| self.doc.current_spread().tree.get(id).map_or(0.0, |n| n.box_model.gap);
        let gap_top    = gap(top_spl_id);
        let gap_right  = gap(s_id);       // s_id == p.right_splitter
        let gap_bottom = gap(bot_spl_id);
        let gap_left   = gap(m_id);       // m_id == p.left_splitter

        // Build a 3-split BSP from 4 remaining cells based on which panel is deleted.
        // Each case uses pinwheel_id + 2 freed splitter nodes and frees the other 2.
        if deleted == p.top {
            // Remaining: center, right, bottom, left.
            // CW top = TR quad; CCW top = TL quad.
            // After collapse, layout depends on orientation.
            if is_cw {
                // Remove TR. Remaining cells in [L,R]×[T,B]:
                // center=[cx1,cx2]×[T,cy2], right=[cx2,R]×[T,B], bottom=[L,cx2]×[cy2,B], left=[L,cx1]×[T,cy2]
                // BSP: V(cx2) → { H(cy2) → { V(cx1_rel) → {left, center}, bottom }, right }
                let v_outer  = cx2_f.clamp(0.05, 0.95);
                let h_inner  = cy2_f.clamp(0.05, 0.95);
                let v_inner  = if cx2_f > 0.0 { (cx1_f / cx2_f).clamp(0.05, 0.95) } else { 0.5 };
                let tree = &mut self.doc.current_spread_mut().tree;
                // pinwheel_id → V-split at cx2 (bottom_splitter boundary)
                if let Some(n) = tree.get_mut(pinwheel_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Vertical, ratio: v_outer,
                        first_child: m_id, second_child: p.right });
                    n.box_model.gap = gap_bottom;
                }
                if let Some(n) = tree.get_mut(p.right) { n.parent = Some(pinwheel_id); }
                // m_id → H-split at cy2 (left_splitter boundary — m_id already owns this gap)
                if let Some(n) = tree.get_mut(m_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Horizontal, ratio: h_inner,
                        first_child: s_id, second_child: p.bottom });
                    n.parent = Some(pinwheel_id);
                    n.box_model.gap = gap_left;
                }
                if let Some(n) = tree.get_mut(p.bottom) { n.parent = Some(m_id); }
                // s_id → V-split at cx1 (top_splitter boundary)
                if let Some(n) = tree.get_mut(s_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Vertical, ratio: v_inner,
                        first_child: p.left, second_child: center_id });
                    n.parent = Some(m_id);
                    n.box_model.gap = gap_top;
                }
                if let Some(n) = tree.get_mut(p.left)   { n.parent = Some(s_id); }
                if let Some(n) = tree.get_mut(center_id) { n.parent = Some(s_id); }
                tree.nodes.remove(&top_spl_id);
                tree.nodes.remove(&bot_spl_id);
                tree.nodes.remove(&deleted);
            } else {
                // CCW top = TL quad. Remove TL. Remaining:
                // center=[cx1,cx2]×[cy1,B], right=[cx2,R]×[T,cy2], bottom=[cx1,R]×[cy2,B], left=[L,cx1]×[cy1,B]
                // BSP: H(cy2) → { top=[full×T..cy2 parts]: V(cx1)→{H(cy1_rel)->{empty?,…},right}, bot-parts }
                // Simpler: H(cy1) → { top-strip [L,R]×[T,cy1]: V(cx2_inner)→{right_part=[cx2,R]×[T,cy2]... }
                // Let me use: V(cx1) → { H(cy1) → {nothing, left}, H(cy1) →... }
                // Actually: V(cx2) → { V(cx1_rel) → { left, H(cy1_rel)→{top_empty?,center} }, right }
                // Remaining after removing TL (top=TL):
                // center=[cx1,cx2]×[cy1,B], right=[cx2,R]×[T,cy2], bottom=[cx1,R]×[cy2,B], left=[L,cx1]×[cy1,B]
                // BSP: H(cy2) → { V(cx2) → { V(cx1_rel_of_cx2) → {left_H, center_H}, right_top }, bottom_combined }
                // Hmm this is hard. Let me do V(cx1) first:
                // V(cx1): first=[L,cx1]×[T,B], second=[cx1,R]×[T,B]
                //   first: H(cy1_of_first): top=nothing... not right since TL is deleted
                //   first = just left = [L,cx1]×[cy1,B] but first rect is [L,cx1]×[T,B]
                // The deleted TL was [L,cx2]×[T,cy1] so there's a gap at top-left.
                // This shape is NOT sliceable as a simple 3-split BSP.
                // Fall back: just do the center-deletion (approximate).
                // TODO: implement CCW outer deletion properly
                return false;
            }
        } else if deleted == p.right {
            if is_cw {
                // Remove BR. Remaining: center=[cx1,cx2]×[cy1,cy2], top=[cx1,R]×[T,cy1],
                // bottom=[L,cx2]×[cy2,B], left=[L,cx1]×[T,cy2].
                // Wait, CW right = BR. After removing BR: top=[cx1,R]×[T,cy1],
                // center merges with right side... cx2→R so:
                // center=[cx1,R]×[cy1,cy2], top=[cx1,R]×[T,cy1], bottom=[L,R]×[cy2,B], left=[L,cx1]×[T,cy2]
                // BSP: H(cy2) → { V(cx1) → { left, H(cy1_rel) → { top, center } }, bottom }
                let h_outer  = cy2_f.clamp(0.05, 0.95);
                let v_inner  = cx1_f.clamp(0.05, 0.95);
                let h_inner2 = if cy2_f > 0.0 { (cy1_f / cy2_f).clamp(0.05, 0.95) } else { 0.5 };
                let tree = &mut self.doc.current_spread_mut().tree;
                // pinwheel_id → H-split at cy2 (left_splitter boundary)
                if let Some(n) = tree.get_mut(pinwheel_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Horizontal, ratio: h_outer,
                        first_child: s_id, second_child: p.bottom });
                    n.box_model.gap = gap_left;
                }
                if let Some(n) = tree.get_mut(p.bottom) { n.parent = Some(pinwheel_id); }
                // s_id → V-split at cx1 (top_splitter boundary)
                if let Some(n) = tree.get_mut(s_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Vertical, ratio: v_inner,
                        first_child: p.left, second_child: m_id });
                    n.parent = Some(pinwheel_id);
                    n.box_model.gap = gap_top;
                }
                if let Some(n) = tree.get_mut(p.left) { n.parent = Some(s_id); }
                // m_id → H-split at cy1 (right_splitter boundary)
                if let Some(n) = tree.get_mut(m_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Horizontal, ratio: h_inner2,
                        first_child: p.top, second_child: center_id });
                    n.parent = Some(s_id);
                    n.box_model.gap = gap_right;
                }
                if let Some(n) = tree.get_mut(p.top)    { n.parent = Some(m_id); }
                if let Some(n) = tree.get_mut(center_id) { n.parent = Some(m_id); }
                tree.nodes.remove(&top_spl_id);
                tree.nodes.remove(&bot_spl_id);
                tree.nodes.remove(&deleted);
            } else {
                return false; // TODO: CCW right deletion
            }
        } else if deleted == p.bottom {
            if is_cw {
                // CW bottom = BL. Remaining: top=[cx1,R]×[T,cy1], right=[cx2,R]×[cy1,B],
                // center=[cx1,cx2]×[cy1,B], left=[L,cx1]×[T,cy2]→[T,B] since cy2→B.
                // BSP: V(cx1) → { left=[L,cx1]×[T,B], H(cy1) → { top=[cx1,R]×[T,cy1], V(cx2_rel)→{center,right} } }
                let v_outer  = cx1_f.clamp(0.05, 0.95);
                let h_inner  = cy1_f.clamp(0.05, 0.95);
                let v_inner2 = if (1.0 - cx1_f) > 0.0 {
                    ((cx2_f - cx1_f) / (1.0 - cx1_f)).clamp(0.05, 0.95) } else { 0.5 };
                let tree = &mut self.doc.current_spread_mut().tree;
                // pinwheel_id → V-split at cx1 (top_splitter boundary)
                if let Some(n) = tree.get_mut(pinwheel_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Vertical, ratio: v_outer,
                        first_child: p.left, second_child: m_id });
                    n.box_model.gap = gap_top;
                }
                if let Some(n) = tree.get_mut(p.left) { n.parent = Some(pinwheel_id); }
                // m_id → H-split at cy1 (right_splitter boundary)
                if let Some(n) = tree.get_mut(m_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Horizontal, ratio: h_inner,
                        first_child: p.top, second_child: s_id });
                    n.parent = Some(pinwheel_id);
                    n.box_model.gap = gap_right;
                }
                if let Some(n) = tree.get_mut(p.top) { n.parent = Some(m_id); }
                // s_id → V-split at cx2 (bottom_splitter boundary)
                if let Some(n) = tree.get_mut(s_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Vertical, ratio: v_inner2,
                        first_child: center_id, second_child: p.right });
                    n.parent = Some(m_id);
                    n.box_model.gap = gap_bottom;
                }
                if let Some(n) = tree.get_mut(center_id) { n.parent = Some(s_id); }
                if let Some(n) = tree.get_mut(p.right)   { n.parent = Some(s_id); }
                tree.nodes.remove(&top_spl_id);
                tree.nodes.remove(&bot_spl_id);
                tree.nodes.remove(&deleted);
            } else {
                return false; // TODO: CCW bottom deletion
            }
        } else if deleted == p.left {
            if is_cw {
                // CW left = TL. Remaining: top=[cx1,R]×[T,cy1], right=[cx2,R]×[cy1,B],
                // bottom=[L,cx2]×[cy2,B], center=[cx1,cx2]×[cy1,cy2].
                // cx1→0 so: top=[L,R]×[T,cy1] (full width), bottom=[L,cx2]×[cy2,B],
                // center=[L,cx2]×[cy1,cy2], right=[cx2,R]×[cy1,B].
                // BSP: H(cy1) → { top=[L,R]×[T,cy1], V(cx2) → { H(cy2_rel)→{center,bottom}, right } }
                let h_outer  = cy1_f.clamp(0.05, 0.95);
                let v_inner  = cx2_f.clamp(0.05, 0.95);
                let h_inner2 = if (1.0 - cy1_f) > 0.0 {
                    ((cy2_f - cy1_f) / (1.0 - cy1_f)).clamp(0.05, 0.95) } else { 0.5 };
                let tree = &mut self.doc.current_spread_mut().tree;
                // pinwheel_id → H-split at cy1 (right_splitter boundary)
                if let Some(n) = tree.get_mut(pinwheel_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Horizontal, ratio: h_outer,
                        first_child: p.top, second_child: s_id });
                    n.box_model.gap = gap_right;
                }
                if let Some(n) = tree.get_mut(p.top) { n.parent = Some(pinwheel_id); }
                // s_id → V-split at cx2 (bottom_splitter boundary)
                if let Some(n) = tree.get_mut(s_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Vertical, ratio: v_inner,
                        first_child: m_id, second_child: p.right });
                    n.parent = Some(pinwheel_id);
                    n.box_model.gap = gap_bottom;
                }
                if let Some(n) = tree.get_mut(p.right) { n.parent = Some(s_id); }
                // m_id → H-split at cy2 (left_splitter boundary — m_id already owns this gap)
                if let Some(n) = tree.get_mut(m_id) {
                    n.kind = BspKind::Split(SplitData { axis: SplitAxis::Horizontal, ratio: h_inner2,
                        first_child: center_id, second_child: p.bottom });
                    n.parent = Some(s_id);
                    n.box_model.gap = gap_left;
                }
                if let Some(n) = tree.get_mut(center_id) { n.parent = Some(m_id); }
                if let Some(n) = tree.get_mut(p.bottom)  { n.parent = Some(m_id); }
                tree.nodes.remove(&top_spl_id);
                tree.nodes.remove(&bot_spl_id);
                tree.nodes.remove(&deleted);
            } else {
                return false; // TODO: CCW left deletion
            }
        } else {
            return false;
        }

        true
    }
}

// ---------------------------------------------------------------------------
// WASM exports
// ---------------------------------------------------------------------------

#[wasm_bindgen]
impl PhotobookEditor {
    /// Returns true if the node is a PinwheelSplitter.
    pub fn is_pinwheel_splitter(&self, id: u32) -> bool {
        matches!(
            self.doc.current_spread().tree.get(id).map(|n| &n.kind),
            Some(BspKind::PinwheelSplitter(_))
        )
    }

    /// Delete a panel that is a direct child of a Pinwheel node.
    pub fn delete_pinwheel_panel(&mut self, id: u32) -> bool {
        self.selection.retain(|&sid| sid != id);
        let ok = self.delete_pinwheel_panel_inner(id);
        if ok { self.mark_structure_dirty(); }
        ok
    }

    /// Begin a pinwheel spawn drag from a pinwheel_spawn cross handle.
    /// Immediately converts the X-junction to a zero-size Pinwheel.
    /// `junction_x/y`: spread-relative px position of the junction centre.
    pub fn begin_pinwheel_spawn_drag(
        &mut self,
        parent_id: u32,
        junction_x: f32, junction_y: f32,
        canvas_w: f32, canvas_h: f32,
    ) -> bool {
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let resolver  = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px);

        let p_rect = match resolver.resolve_node_rect(parent_id, root_rect) {
            Some(r) => r,
            None => return false,
        };
        if p_rect.w <= 0.0 || p_rect.h <= 0.0 { return false; }

        let jx_f = ((junction_x - p_rect.x) / p_rect.w).clamp(0.05, 0.95);
        let jy_f = ((junction_y - p_rect.y) / p_rect.h).clamp(0.05, 0.95);

        if !self.spawn_pinwheel(
            parent_id,
            PinwheelOrientation::Clockwise,
            jx_f, jy_f, jx_f, jy_f,
        ) {
            return false;
        }

        self.pinwheel_drag = Some(DragPinwheelSpawn {
            pinwheel_id: parent_id,
            junction_x,
            junction_y,
        });
        self.mark_structure_dirty();
        true
    }

    pub fn update_pinwheel_spawn_drag(
        &mut self,
        mouse_x: f32, mouse_y: f32,
        canvas_w: f32, canvas_h: f32,
    ) {
        let (pinwheel_id, jx, jy) = match self.pinwheel_drag {
            Some(ref d) => (d.pinwheel_id, d.junction_x, d.junction_y),
            None => return,
        };

        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let resolver  = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px);
        let pr = match resolver.resolve_node_rect(pinwheel_id, root_rect) {
            Some(r) => r,
            None => return,
        };
        if pr.w <= 0.0 || pr.h <= 0.0 { return; }

        let cw = (mouse_x > jx) == (mouse_y < jy);
        let orientation = if cw {
            PinwheelOrientation::Clockwise
        } else {
            PinwheelOrientation::AntiClockwise
        };

        let cx1 = jx.min(mouse_x);
        let cx2 = jx.max(mouse_x);
        let cy1 = jy.min(mouse_y);
        let cy2 = jy.max(mouse_y);

        const MIN_FRAC: f32 = 0.05;
        let to_x = |px: f32| ((px - pr.x) / pr.w).clamp(MIN_FRAC, 1.0 - MIN_FRAC);
        let to_y = |py: f32| ((py - pr.y) / pr.h).clamp(MIN_FRAC, 1.0 - MIN_FRAC);

        let (x_top, y_right, x_bottom, y_left) = if cw {
            (to_x(cx1), to_y(cy1), to_x(cx2), to_y(cy2))
        } else {
            (to_x(cx2), to_y(cy2), to_x(cx1), to_y(cy1))
        };

        self.update_pinwheel_spawn_params(
            pinwheel_id, orientation, x_top, y_right, x_bottom, y_left,
        );
        self.mark_structure_dirty();
    }

    pub fn end_pinwheel_spawn_drag(&mut self) {
        self.pinwheel_drag = None;
    }

    pub fn cancel_pinwheel_spawn_drag(&mut self) {
        if let Some(drag) = self.pinwheel_drag.take() {
            self.dissolve_pinwheel_to_xjunction(drag.pinwheel_id);
            self.mark_structure_dirty();
        }
    }
}
