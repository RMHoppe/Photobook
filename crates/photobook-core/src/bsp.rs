use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::layout::BoxModel;

pub type NodeId = u32;
pub const NULL_ID: NodeId = u32::MAX;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BspTree {
    pub nodes: HashMap<NodeId, BspNode>,
    pub root: NodeId,
    next_id: NodeId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BspNode {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub kind: BspKind,
    pub box_model: BoxModel,
    /// Rendering order relative to siblings. Higher value draws on top.
    /// Defaults to 0; managed by move_node_z_order().
    #[serde(default)]
    pub z_index: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum BspKind {
    Leaf(LeafData),
    Split(SplitData),
    Pinwheel(PinwheelData),
    PinwheelSplitter(PinwheelSplitterData),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LeafData {
    pub image_id: Option<String>,
    pub object_fit: ObjectFit,
    pub pan_x: f32,
    pub pan_y: f32,
    /// User zoom multiplier on top of the minimum cover scale. ≥ 1.0.
    pub scale: f32,
    /// Rotation in degrees counter-clockwise.
    pub rotation_deg: f32,
}

impl Default for LeafData {
    fn default() -> Self {
        LeafData {
            image_id: None,
            object_fit: ObjectFit::Cover,
            pan_x: 0.5,
            pan_y: 0.5,
            scale: 1.0,
            rotation_deg: 0.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SplitData {
    pub axis: SplitAxis,
    /// fraction [0.05, 0.95] given to first child
    pub ratio: f32,
    pub first_child: NodeId,
    pub second_child: NodeId,
}

// ---------------------------------------------------------------------------
// Pinwheel types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum PinwheelOrientation {
    Clockwise,
    AntiClockwise,
}

/// A 5-cell layout: center + top + right + bottom + left panels with 4 internal splitter handles.
///
/// Invariant: `x_top < x_bottom  ↔  y_right < y_left  ↔  Clockwise`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PinwheelData {
    pub orientation: PinwheelOrientation,
    /// Where top-splitter's divider hits the top boundary: x = x_top * W
    pub x_top: f32,
    /// Where right-splitter's divider hits the right boundary: y = y_right * H
    pub y_right: f32,
    /// Where bottom-splitter's divider hits the bottom boundary: x = x_bottom * W
    pub x_bottom: f32,
    /// Where left-splitter's divider hits the left boundary: y = y_left * H
    pub y_left: f32,
    // Content panels
    pub center: NodeId,
    pub top: NodeId,
    pub right: NodeId,
    pub bottom: NodeId,
    pub left: NodeId,
    // Internal splitter nodes
    pub top_splitter: NodeId,
    pub right_splitter: NodeId,
    pub bottom_splitter: NodeId,
    pub left_splitter: NodeId,
}

/// Splitter node referencing its owning pinwheel. Geometry is derived from the pinwheel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PinwheelSplitterData {
    pub pinwheel_id: NodeId,
    pub role: PinwheelSplitterRole,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Copy)]
pub enum PinwheelSplitterRole {
    Top,
    Right,
    Bottom,
    Left,
}

// ---------------------------------------------------------------------------
// Shared enum types
// ---------------------------------------------------------------------------

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
// BspTree implementation
// ---------------------------------------------------------------------------

impl BspTree {
    /// Create a tree with a single empty leaf as root, starting node IDs at `start_id`.
    /// Use a unique `start_id` per page to keep node IDs globally unique.
    pub fn new_with_start(start_id: NodeId) -> Self {
        let root_node = BspNode {
            id: start_id,
            parent: None,
            kind: BspKind::Leaf(LeafData::default()),
            box_model: BoxModel::default(),
            z_index: 0,
        };
        let mut nodes = HashMap::new();
        nodes.insert(start_id, root_node);
        BspTree {
            nodes,
            root: start_id,
            next_id: start_id + 1,
        }
    }

    pub(crate) fn alloc_node_id(&mut self) -> NodeId {
        self.alloc_id()
    }

    pub(crate) fn insert_node(&mut self, node: BspNode) {
        self.nodes.insert(node.id, node);
    }

    fn alloc_id(&mut self) -> NodeId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn get(&self, id: NodeId) -> Option<&BspNode> {
        self.nodes.get(&id)
    }

    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut BspNode> {
        self.nodes.get_mut(&id)
    }

    /// Return a clone of the `LeafData` for a leaf node, or `None` if `id` is not a leaf.
    pub fn get_leaf_data(&self, id: NodeId) -> Option<LeafData> {
        match &self.get(id)?.kind {
            BspKind::Leaf(l) => Some(l.clone()),
            _ => None,
        }
    }

    /// Replace a Leaf node with a Split node containing the old leaf and a new empty leaf.
    /// Returns (first_child_id, second_child_id) on success.
    pub fn split(&mut self, leaf_id: NodeId, axis: SplitAxis) -> Option<(NodeId, NodeId)> {
        let parent_id = {
            let node = self.get(leaf_id)?;
            if !matches!(node.kind, BspKind::Leaf(_)) {
                return None;
            }
            node.parent
        };

        let first_id = self.alloc_id();
        let second_id = self.alloc_id();

        let (old_leaf_data, old_box_model) = {
            let node = self.get(leaf_id).unwrap();
            let leaf = match &node.kind {
                BspKind::Leaf(d) => d.clone(),
                _ => unreachable!(),
            };
            (leaf, node.box_model.clone())
        };

        let first_child = BspNode {
            id: first_id,
            parent: Some(leaf_id),
            kind: BspKind::Leaf(old_leaf_data.clone()),
            box_model: old_box_model.clone(),
            z_index: 0,
        };
        let second_child = BspNode {
            id: second_id,
            parent: Some(leaf_id),
            kind: BspKind::Leaf(old_leaf_data),
            box_model: old_box_model,
            z_index: 0,
        };

        let node = self.get_mut(leaf_id).unwrap();
        node.parent = parent_id;
        node.kind = BspKind::Split(SplitData {
            axis,
            ratio: 0.5,
            first_child: first_id,
            second_child: second_id,
        });
        node.box_model = BoxModel::default();

        self.nodes.insert(first_id, first_child);
        self.nodes.insert(second_id, second_child);

        Some((first_id, second_id))
    }

    /// Delete a leaf node and replace its parent split with the sibling.
    /// Returns the sibling id on success.
    /// Returns None if the parent is not a Split (e.g. Pinwheel — caller handles that case).
    pub fn delete_leaf(&mut self, leaf_id: NodeId) -> Option<NodeId> {
        let parent_id = self.get(leaf_id)?.parent?;

        let (sibling_id, parent_parent) = {
            let parent = self.get(parent_id)?;
            match &parent.kind {
                BspKind::Split(s) => {
                    let sib = if s.first_child == leaf_id {
                        s.second_child
                    } else {
                        s.first_child
                    };
                    (sib, parent.parent)
                }
                // Pinwheel and other non-Split parents are handled by the caller
                _ => return None,
            }
        };

        let (sib_kind, sib_box_model) = {
            let sib = self.get(sibling_id)?;
            (sib.kind.clone(), sib.box_model.clone())
        };

        let parent = self.get_mut(parent_id).unwrap();
        parent.kind = sib_kind;
        parent.box_model = sib_box_model;
        parent.parent = parent_parent;

        if let BspKind::Split(ref s) = parent.kind.clone() {
            let fc = s.first_child;
            let sc = s.second_child;
            if let Some(n) = self.get_mut(fc) {
                n.parent = Some(parent_id);
            }
            if let Some(n) = self.get_mut(sc) {
                n.parent = Some(parent_id);
            }
        }

        self.nodes.remove(&leaf_id);
        self.nodes.remove(&sibling_id);

        Some(parent_id)
    }

    /// Collect all descendant node IDs (not including `id` itself), depth-first.
    pub fn descendants(&self, id: NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        if let Some(node) = self.get(id) {
            match &node.kind {
                BspKind::Split(s) => {
                    let (fc, sc) = (s.first_child, s.second_child);
                    result.push(fc);
                    result.push(sc);
                    result.extend(self.descendants(fc));
                    result.extend(self.descendants(sc));
                }
                BspKind::Pinwheel(p) => {
                    let children = [
                        p.center, p.top, p.right, p.bottom, p.left,
                        p.top_splitter, p.right_splitter, p.bottom_splitter, p.left_splitter,
                    ];
                    for &child in &children {
                        result.push(child);
                        result.extend(self.descendants(child));
                    }
                }
                // PinwheelSplitter has no structural children (owned by Pinwheel)
                BspKind::PinwheelSplitter(_) | BspKind::Leaf(_) => {}
            }
        }
        result
    }

    /// Return the parent node ID of `id`, or `None` if `id` is the root.
    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.get(id)?.parent
    }

    /// Collect all leaf node IDs in depth-first order.
    pub fn leaves(&self) -> Vec<NodeId> {
        let mut result = Vec::new();
        self.collect_leaves(self.root, &mut result);
        result
    }

    fn collect_leaves(&self, id: NodeId, out: &mut Vec<NodeId>) {
        if let Some(node) = self.get(id) {
            match &node.kind {
                BspKind::Leaf(_) => out.push(id),
                BspKind::Split(s) => {
                    self.collect_leaves(s.first_child, out);
                    self.collect_leaves(s.second_child, out);
                }
                BspKind::Pinwheel(p) => {
                    self.collect_leaves(p.center, out);
                    self.collect_leaves(p.top, out);
                    self.collect_leaves(p.right, out);
                    self.collect_leaves(p.bottom, out);
                    self.collect_leaves(p.left, out);
                }
                BspKind::PinwheelSplitter(_) => {} // leaves visited via Pinwheel arm
            }
        }
    }

    /// Return the lowest common ancestor of a set of node IDs, or `NULL_ID` if the set is empty.
    /// If the set contains a single node, returns that node's parent (the nearest Split ancestor).
    pub fn lowest_common_ancestor(&self, ids: &[NodeId]) -> NodeId {
        if ids.is_empty() { return NULL_ID; }
        if ids.len() == 1 {
            return self.get(ids[0])
                .and_then(|n| n.parent)
                .unwrap_or(NULL_ID);
        }
        // Build ancestor chain for the first id (root last), then walk up until a node
        // that is an ancestor of every other id is found.
        let chain: Vec<NodeId> = {
            let mut v = vec![ids[0]];
            v.extend(self.ancestors(ids[0]));
            v
        };
        'outer: for candidate in &chain {
            for &other in &ids[1..] {
                let other_ancestors: Vec<NodeId> = {
                    let mut v = vec![other];
                    v.extend(self.ancestors(other));
                    v
                };
                if !other_ancestors.contains(candidate) {
                    continue 'outer;
                }
            }
            return *candidate;
        }
        NULL_ID
    }

    /// Return all ancestors of `id` (parent, grandparent, …), nearest first.
    pub fn ancestors(&self, id: NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut current = id;
        while let Some(node) = self.get(current) {
            if let Some(pid) = node.parent {
                result.push(pid);
                current = pid;
            } else {
                break;
            }
        }
        result
    }

    /// Wrap the current root in a new split node, placing `new_leaf` as its sibling.
    /// If `new_is_first`, the new leaf is first child; otherwise it is second child.
    /// Returns `(new_split_id, new_leaf_id)`.
    pub fn wrap_root_with_split(&mut self, axis: SplitAxis, ratio: f32, new_is_first: bool) -> (NodeId, NodeId) {
        let split_id = self.alloc_id();
        let leaf_id  = self.alloc_id();
        let old_root = self.root;

        if let Some(node) = self.get_mut(old_root) {
            node.parent = Some(split_id);
        }

        let (first_child, second_child) = if new_is_first {
            (leaf_id, old_root)
        } else {
            (old_root, leaf_id)
        };

        let split_node = BspNode {
            id: split_id,
            parent: None,
            kind: BspKind::Split(SplitData {
                axis,
                ratio: ratio.clamp(0.05, 0.95),
                first_child,
                second_child,
            }),
            box_model: BoxModel::default(),
            z_index: 0,
        };
        let leaf_node = BspNode {
            id: leaf_id,
            parent: Some(split_id),
            kind: BspKind::Leaf(LeafData::default()),
            box_model: BoxModel::default(),
            z_index: 0,
        };

        self.nodes.insert(split_id, split_node);
        self.nodes.insert(leaf_id, leaf_node);
        self.root = split_id;

        (split_id, leaf_id)
    }

    /// Return the sibling of `id` if it exists.
    /// For pinwheel content panels: returns the clockwise-next outer panel.
    /// For pinwheel splitters or center: returns None.
    pub fn sibling(&self, id: NodeId) -> Option<NodeId> {
        let parent_id = self.get(id)?.parent?;
        match &self.get(parent_id)?.kind {
            BspKind::Split(s) => {
                if s.first_child == id {
                    Some(s.second_child)
                } else {
                    Some(s.first_child)
                }
            }
            BspKind::Pinwheel(p) => {
                // CW-adjacent outer panel (spatial order: top→right→bottom→left)
                let order = [p.top, p.right, p.bottom, p.left];
                order.iter().position(|&n| n == id)
                    .map(|i| order[(i + 1) % 4])
            }
            _ => None,
        }
    }

    /// Navigate from current selection given a direction string.
    /// Returns the new selected NodeId.
    pub fn navigate(&self, current: NodeId, direction: &str) -> NodeId {
        let node = match self.get(current) {
            Some(n) => n,
            None => return current,
        };

        match direction {
            "parent" => node.parent.unwrap_or(current),
            "first_child" => match &node.kind {
                BspKind::Split(s) => s.first_child,
                _ => current,
            },
            "second_child" => match &node.kind {
                BspKind::Split(s) => s.second_child,
                _ => current,
            },
            "sibling" => self.sibling(current).unwrap_or(current),
            "left" => {
                if let Some(parent_id) = node.parent {
                    if let Some(BspKind::Split(s)) = self.get(parent_id).map(|p| &p.kind) {
                        if s.second_child == current {
                            return s.first_child;
                        }
                    }
                }
                node.parent.unwrap_or(current)
            }
            "right" => {
                if let Some(parent_id) = node.parent {
                    if let Some(BspKind::Split(s)) = self.get(parent_id).map(|p| &p.kind) {
                        if s.first_child == current {
                            return s.second_child;
                        }
                    }
                }
                match &node.kind {
                    BspKind::Split(s) => s.first_child,
                    _ => current,
                }
            }
            "up" => node.parent.unwrap_or(current),
            "down" => match &node.kind {
                BspKind::Split(s) => s.first_child,
                _ => current,
            },
            // Pinwheel navigation: clockwise / counter-clockwise among outer panels
            "cw_next" => {
                if let Some(parent_id) = node.parent {
                    if let Some(BspKind::Pinwheel(p)) = self.get(parent_id).map(|n| &n.kind) {
                        let order = [p.top, p.right, p.bottom, p.left];
                        if let Some(i) = order.iter().position(|&n| n == current) {
                            return order[(i + 1) % 4];
                        }
                    }
                }
                current
            }
            "ccw_prev" => {
                if let Some(parent_id) = node.parent {
                    if let Some(BspKind::Pinwheel(p)) = self.get(parent_id).map(|n| &n.kind) {
                        let order = [p.top, p.right, p.bottom, p.left];
                        if let Some(i) = order.iter().position(|&n| n == current) {
                            return order[(i + 3) % 4];
                        }
                    }
                }
                current
            }
            _ => current,
        }
    }
}
