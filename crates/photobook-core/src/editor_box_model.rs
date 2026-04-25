use std::collections::HashSet;
use wasm_bindgen::prelude::*;
use crate::bsp::{BspKind, NodeId, PinwheelSplitterRole, SplitAxis};
use crate::layout::{Border, BorderPosition, BoxModel, EdgeInsets};
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Box model reads
    // -----------------------------------------------------------------------

    /// Returns the box model JSON for the current selection.
    ///
    /// - No selection → default box model (all zeros).
    /// - Single node → that node's box model (leaf gap is read from its parent split).
    /// - Multi-selection → merged: fields where all nodes agree show the common value;
    ///   fields that disagree use sentinels: `-1.0` for f32, `"__mixed__"` for strings,
    ///   `BorderPosition::Mixed` for border-position.
    pub fn get_box_model(&self) -> String {
        if self.selection.is_empty() {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        }

        let tree = &self.doc.current_spread().tree;

        let bms: Vec<BoxModel> = self.selection.iter()
            .filter_map(|&id| {
                let node = tree.get(id)?;
                let mut bm = node.box_model.clone();
                if matches!(node.kind, BspKind::Leaf(_)) {
                    if let Some(pid) = tree.parent(id) {
                        if let Some(p) = tree.get(pid) { bm.gap = p.box_model.gap; }
                    }
                }
                Some(bm)
            })
            .collect();

        Self::merge_box_models_json(&bms)
    }

    /// Returns the merged box model for only the **leaf** nodes in the selection.
    pub fn get_leaf_box_model(&self) -> String {
        let tree = &self.doc.current_spread().tree;
        let bms: Vec<BoxModel> = self.selection.iter()
            .filter_map(|&id| {
                let node = tree.get(id)?;
                if !matches!(node.kind, BspKind::Leaf(_)) { return None; }
                let mut bm = node.box_model.clone();
                if let Some(pid) = tree.parent(id) {
                    if let Some(p) = tree.get(pid) { bm.gap = p.box_model.gap; }
                }
                Some(bm)
            })
            .collect();
        Self::merge_box_models_json(&bms)
    }

    /// Returns the merged box model for only the **split** nodes in the selection.
    /// PinwheelSplitter nodes use their own box_model (gap is per-splitter).
    pub fn get_split_box_model(&self) -> String {
        let tree = &self.doc.current_spread().tree;
        let bms: Vec<BoxModel> = self.selection.iter()
            .filter_map(|&id| {
                let node = tree.get(id)?;
                match &node.kind {
                    BspKind::Split(_) | BspKind::PinwheelSplitter(_) => Some(node.box_model.clone()),
                    _ => None,
                }
            })
            .collect();
        Self::merge_box_models_json(&bms)
    }

    /// Returns the common ratio of all selected split/pinwheel-splitter nodes, or -1.0 if mixed/none.
    pub fn get_split_merged_ratio(&self) -> f32 {
        let tree = &self.doc.current_spread().tree;
        let ratios: Vec<f32> = self.selection.iter()
            .filter_map(|&id| match tree.get(id).map(|n| &n.kind) {
                Some(BspKind::Split(s)) => Some(s.ratio),
                Some(BspKind::PinwheelSplitter(ps)) => {
                    let parent = tree.get(ps.pinwheel_id)?;
                    if let BspKind::Pinwheel(p) = &parent.kind {
                        Some(match ps.role {
                            PinwheelSplitterRole::Top    => p.x_top,
                            PinwheelSplitterRole::Right  => p.y_right,
                            PinwheelSplitterRole::Bottom => p.x_bottom,
                            PinwheelSplitterRole::Left   => p.y_left,
                        })
                    } else { None }
                }
                _ => None,
            })
            .collect();
        if ratios.is_empty() { return -1.0; }
        if ratios.iter().all(|&r| (r - ratios[0]).abs() < 0.001) { ratios[0] } else { -1.0 }
    }

    /// Returns "v", "h", or "" (mixed / none) for all selected split/pinwheel-splitter nodes.
    pub fn get_split_merged_axis(&self) -> String {
        let tree = &self.doc.current_spread().tree;
        let axes: Vec<SplitAxis> = self.selection.iter()
            .filter_map(|&id| match tree.get(id).map(|n| &n.kind) {
                Some(BspKind::Split(s)) => Some(s.axis),
                Some(BspKind::PinwheelSplitter(ps)) => Some(match ps.role {
                    PinwheelSplitterRole::Top | PinwheelSplitterRole::Bottom => SplitAxis::Vertical,
                    PinwheelSplitterRole::Right | PinwheelSplitterRole::Left  => SplitAxis::Horizontal,
                }),
                _ => None,
            })
            .collect();
        if axes.is_empty() { return "".into(); }
        if axes.iter().all(|a| *a == axes[0]) {
            match axes[0] { SplitAxis::Vertical => "v".into(), SplitAxis::Horizontal => "h".into() }
        } else { "".into() }
    }

    /// Returns the box model of the transform target node (LCA for multi-selection).
    pub fn get_transform_node_box_model(&self) -> String {
        let Some(id) = self.transform_target_node() else {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        };
        let bm = self.doc.current_spread().tree.get(id)
            .map(|n| n.box_model.clone())
            .unwrap_or_default();
        serde_json::to_string(&bm).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Box model writes
    // -----------------------------------------------------------------------

    /// Apply the given box model JSON to all currently selected nodes.
    ///
    /// Gap propagation: beyond writing gap to each selected leaf's immediate parent,
    /// any splitter node whose entire leaf subtree is covered by the selection also
    /// receives the new gap value.  This means selecting all frames under a splitter
    /// and changing gap updates that splitter's gap, not just the leaf-level parents.
    pub fn set_box_model(&mut self, json: &str) {
        let bm: BoxModel = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(_) => return,
        };
        if self.selection.is_empty() { return; }
        let ids: Vec<NodeId> = self.selection.clone();
        for id in ids {
            self.apply_box_model_to_node(id, &bm);
        }

        // Propagate gap to any splitter whose entire leaf subtree is selected.
        if bm.gap >= 0.0 {
            let selection_set: HashSet<NodeId> = self.selection.iter().copied().collect();
            let splits_to_update: Vec<NodeId> = {
                let tree = &self.doc.current_spread().tree;
                tree.nodes.keys()
                    .copied()
                    .filter(|&id| matches!(tree.get(id).map(|n| &n.kind), Some(BspKind::Split(_))))
                    .filter(|&split_id| {
                        let leaf_descs: Vec<NodeId> = tree.descendants(split_id)
                            .into_iter()
                            .filter(|&d| matches!(tree.get(d).map(|n| &n.kind), Some(BspKind::Leaf(_))))
                            .collect();
                        !leaf_descs.is_empty() && leaf_descs.iter().all(|d| selection_set.contains(d))
                    })
                    .collect()
            };
            for split_id in splits_to_update {
                if let Some(node) = self.doc.current_spread_mut().tree.get_mut(split_id) {
                    node.box_model.gap = bm.gap;
                }
            }
        }
        self.mark_structure_dirty();
    }

    /// Set the margin of the selected node (values in mm, clamped to ≥ 0).
    pub fn set_node_margin(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let Some(id) = self.transform_target_node() else { return; };
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
            node.box_model.margin.top    = top.max(0.0);
            node.box_model.margin.right  = right.max(0.0);
            node.box_model.margin.bottom = bottom.max(0.0);
            node.box_model.margin.left   = left.max(0.0);
        }
        self.mark_structure_dirty();
    }

    /// Set the visual rotation of the transform-target node (degrees, CCW positive).
    pub fn set_transform_node_rotation_deg(&mut self, deg: f32) {
        let Some(id) = self.transform_target_node() else { return; };
        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
            node.box_model.node_rotation_deg = Some(deg);
        }
        self.mark_structure_dirty();
    }

    /// Copy the current node's `gap` value to every descendant in the subtree.
    pub fn apply_gap_to_subtree(&mut self, node_id: u32) {
        let gap = match self.doc.current_spread().tree.get(node_id) {
            Some(n) => n.box_model.gap,
            None => return,
        };
        let descendants = self.doc.current_spread().tree.descendants(node_id);
        for id in descendants {
            if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
                node.box_model.gap = gap;
            }
        }
        self.mark_structure_dirty();
    }

    /// Copy the current node's `bg` value to every descendant in the subtree.
    pub fn apply_bg_to_subtree(&mut self, node_id: u32) {
        let bg = match self.doc.current_spread().tree.get(node_id) {
            Some(n) => n.box_model.bg.clone(),
            None => return,
        };
        let descendants = self.doc.current_spread().tree.descendants(node_id);
        for id in descendants {
            if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
                node.box_model.bg = bg.clone();
            }
        }
        self.mark_structure_dirty();
    }

    /// Apply box model to only the **leaf** nodes in the current selection.
    pub fn set_leaf_box_model(&mut self, json: &str) {
        let bm: BoxModel = match serde_json::from_str(json) { Ok(v) => v, Err(_) => return };
        let ids: Vec<NodeId> = self.selection.iter().copied()
            .filter(|&id| matches!(
                self.doc.current_spread().tree.get(id).map(|n| &n.kind),
                Some(BspKind::Leaf(_))
            ))
            .collect();
        for id in ids {
            self.apply_box_model_to_node(id, &bm);
        }
        self.mark_structure_dirty();
    }

    /// Apply box model to only the **split** and **PinwheelSplitter** nodes in the selection.
    /// Each PinwheelSplitter owns its own box_model (gap is independent per splitter boundary).
    pub fn set_split_box_model(&mut self, json: &str) {
        const MIXED_STR: &str = "__mixed__";
        let bm: BoxModel = match serde_json::from_str(json) { Ok(v) => v, Err(_) => return };
        let ids: Vec<NodeId> = self.selection.iter().copied()
            .filter(|&id| matches!(
                self.doc.current_spread().tree.get(id).map(|n| &n.kind),
                Some(BspKind::Split(_)) | Some(BspKind::PinwheelSplitter(_))
            ))
            .collect();
        for id in ids {
            if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
                if bm.margin.top    >= 0.0 { node.box_model.margin.top    = bm.margin.top; }
                if bm.margin.right  >= 0.0 { node.box_model.margin.right  = bm.margin.right; }
                if bm.margin.bottom >= 0.0 { node.box_model.margin.bottom = bm.margin.bottom; }
                if bm.margin.left   >= 0.0 { node.box_model.margin.left   = bm.margin.left; }
                if bm.gap           >= 0.0 { node.box_model.gap           = bm.gap; }
                if bm.bg != MIXED_STR      { node.box_model.bg            = bm.bg.clone(); }
                if bm.border.width  >= 0.0 { node.box_model.border.width  = bm.border.width; }
                if bm.border.color != MIXED_STR { node.box_model.border.color = bm.border.color.clone(); }
                if bm.border.position != BorderPosition::Mixed {
                    node.box_model.border.position = bm.border.position.clone();
                }
                if let Some(deg) = bm.node_rotation_deg {
                    node.box_model.node_rotation_deg = Some(deg);
                }
            }
        }
        self.mark_structure_dirty();
    }
}

impl PhotobookEditor {
    /// Apply a box model to node `id`, routing gap writes to the parent split for leaf nodes.
    ///
    /// Sentinel values are skipped so that multi-selection "mixed" fields do not overwrite
    /// each node's individual value:
    ///   - f32 sentinel  : any value < 0  (valid values are always ≥ 0)
    ///   - string sentinel: `"__mixed__"`
    ///   - position sentinel: `BorderPosition::Mixed`
    pub(crate) fn apply_box_model_to_node(&mut self, id: NodeId, bm: &BoxModel) {
        const MIXED_STR: &str = "__mixed__";
        let tree = &self.doc.current_spread().tree;
        let is_leaf = matches!(tree.get(id).map(|n| &n.kind), Some(BspKind::Leaf(_)));
        let parent_id = if is_leaf { tree.parent(id) } else { None };

        if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
            if bm.margin.top    >= 0.0 { node.box_model.margin.top    = bm.margin.top; }
            if bm.margin.right  >= 0.0 { node.box_model.margin.right  = bm.margin.right; }
            if bm.margin.bottom >= 0.0 { node.box_model.margin.bottom = bm.margin.bottom; }
            if bm.margin.left   >= 0.0 { node.box_model.margin.left   = bm.margin.left; }
            if bm.bg != MIXED_STR { node.box_model.bg = bm.bg.clone(); }
            if bm.border.width >= 0.0 { node.box_model.border.width = bm.border.width; }
            if bm.border.color != MIXED_STR { node.box_model.border.color = bm.border.color.clone(); }
            if bm.border.position != BorderPosition::Mixed {
                node.box_model.border.position = bm.border.position.clone();
            }
            if !is_leaf && bm.gap >= 0.0 { node.box_model.gap = bm.gap; }
            if let Some(deg) = bm.node_rotation_deg {
                node.box_model.node_rotation_deg = Some(deg);
            }
        }

        if is_leaf {
            if let Some(pid) = parent_id {
                if bm.gap >= 0.0 {
                    if let Some(parent) = self.doc.current_spread_mut().tree.get_mut(pid) {
                        parent.box_model.gap = bm.gap;
                    }
                }
            }
        }
    }

    /// Merge a slice of box models into a single JSON string.
    /// Fields that disagree across nodes use the appropriate mixed sentinel.
    pub(crate) fn merge_box_models_json(bms: &[BoxModel]) -> String {
        if bms.is_empty() {
            return serde_json::to_string(&BoxModel::default()).unwrap_or_default();
        }
        if bms.len() == 1 {
            return serde_json::to_string(&bms[0]).unwrap_or_default();
        }
        let f = &bms[0];
        let rest = &bms[1..];
        let mf = |v: f32, agree: bool| -> f32 { if agree { v } else { -1.0 } };
        let ms = |v: &str, agree: bool| -> String {
            if agree { v.to_string() } else { "__mixed__".to_string() }
        };
        let merged = BoxModel {
            margin: EdgeInsets {
                top:    mf(f.margin.top,    rest.iter().all(|b| b.margin.top    == f.margin.top)),
                right:  mf(f.margin.right,  rest.iter().all(|b| b.margin.right  == f.margin.right)),
                bottom: mf(f.margin.bottom, rest.iter().all(|b| b.margin.bottom == f.margin.bottom)),
                left:   mf(f.margin.left,   rest.iter().all(|b| b.margin.left   == f.margin.left)),
            },
            gap: mf(f.gap, rest.iter().all(|b| b.gap == f.gap)),
            bg:  ms(&f.bg, rest.iter().all(|b| b.bg  == f.bg)),
            border: Border {
                width: mf(f.border.width, rest.iter().all(|b| b.border.width == f.border.width)),
                color: ms(&f.border.color, rest.iter().all(|b| b.border.color == f.border.color)),
                position: if rest.iter().all(|b| b.border.position == f.border.position) {
                    f.border.position.clone()
                } else {
                    BorderPosition::Mixed
                },
            },
            node_rotation_deg: if rest.iter().all(|b| b.node_rotation_deg == f.node_rotation_deg) {
                f.node_rotation_deg
            } else {
                None
            },
        };
        serde_json::to_string(&merged).unwrap_or_default()
    }
}
