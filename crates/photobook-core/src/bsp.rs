use serde::{Deserialize, Serialize};
use crate::layout::BoxModel;

pub type NodeId = u32;
pub const NULL_ID: NodeId = u32::MAX;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BspTree {
    pub nodes: Vec<BspNode>,
    pub root: NodeId,
    next_id: NodeId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BspNode {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub kind: BspKind,
    pub box_model: BoxModel,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum BspKind {
    Leaf(LeafData),
    Split(SplitData),
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

/// Describes the content of a leaf frame.
/// Preparatory type for supporting non-image content (e.g. text) in future.
/// Use `LeafData::content()` to obtain it from existing data.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code)]
pub enum LeafContent {
    Empty,
    Image { id: String },
    // Text { style: TextStyle }, // reserved
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

impl LeafData {
    /// Return the content variant derived from this leaf's current data.
    /// Callers can match on this instead of directly inspecting `image_id`.
    #[allow(dead_code)]
    pub fn content(&self) -> LeafContent {
        match &self.image_id {
            Some(id) => LeafContent::Image { id: id.clone() },
            None => LeafContent::Empty,
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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub enum ObjectFit {
    #[default]
    Cover,
    Contain,
    Fill,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Copy)]
pub enum SplitAxis {
    Horizontal,
    Vertical,
}

impl BspTree {
    /// Create a tree with a single empty leaf as root, starting node IDs at `start_id`.
    /// Use a unique `start_id` per page to keep node IDs globally unique.
    pub fn new_with_start(start_id: NodeId) -> Self {
        let root_node = BspNode {
            id: start_id,
            parent: None,
            kind: BspKind::Leaf(LeafData::default()),
            box_model: BoxModel::default(),
        };
        BspTree {
            nodes: vec![root_node],
            root: start_id,
            next_id: start_id + 1,
        }
    }

    fn alloc_id(&mut self) -> NodeId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn get(&self, id: NodeId) -> Option<&BspNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut BspNode> {
        self.nodes.iter_mut().find(|n| n.id == id)
    }

    /// Replace a Leaf node with a Split node containing the old leaf and a new empty leaf.
    /// Returns (first_child_id, second_child_id) on success.
    pub fn split(&mut self, leaf_id: NodeId, axis: SplitAxis) -> Option<(NodeId, NodeId)> {
        // Verify the node is a leaf
        let parent_id = {
            let node = self.get(leaf_id)?;
            if !matches!(node.kind, BspKind::Leaf(_)) {
                return None;
            }
            node.parent
        };

        let first_id = self.alloc_id();
        let second_id = self.alloc_id();

        // Clone the existing leaf data into first child
        let old_leaf_data = {
            let node = self.get(leaf_id).unwrap();
            match &node.kind {
                BspKind::Leaf(d) => d.clone(),
                _ => unreachable!(),
            }
        };
        let old_box_model = self.get(leaf_id).unwrap().box_model.clone();

        // Build the two child nodes
        let first_child = BspNode {
            id: first_id,
            parent: Some(leaf_id),
            kind: BspKind::Leaf(old_leaf_data),
            box_model: old_box_model,
        };
        let second_child = BspNode {
            id: second_id,
            parent: Some(leaf_id),
            kind: BspKind::Leaf(LeafData::default()),
            box_model: BoxModel::default(),
        };

        // Convert the existing leaf into a split node
        let node = self.get_mut(leaf_id).unwrap();
        node.parent = parent_id;
        node.kind = BspKind::Split(SplitData {
            axis,
            ratio: 0.5,
            first_child: first_id,
            second_child: second_id,
        });
        node.box_model = BoxModel::default();

        self.nodes.push(first_child);
        self.nodes.push(second_child);

        Some((first_id, second_id))
    }

    /// Delete a leaf node and replace its parent split with the sibling.
    /// Returns the sibling id on success.
    pub fn delete_leaf(&mut self, leaf_id: NodeId) -> Option<NodeId> {
        let parent_id = self.get(leaf_id)?.parent?;

        // Find sibling
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
                _ => return None,
            }
        };

        // Collect sibling data
        let (sib_kind, sib_box_model) = {
            let sib = self.get(sibling_id)?;
            (sib.kind.clone(), sib.box_model.clone())
        };

        // Replace the parent node with sibling contents
        let parent = self.get_mut(parent_id).unwrap();
        parent.kind = sib_kind;
        parent.box_model = sib_box_model;
        parent.parent = parent_parent;

        // If the sibling was a Split, re-parent its children to parent_id
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

        // Remove old leaf and old sibling nodes
        self.nodes.retain(|n| n.id != leaf_id && n.id != sibling_id);

        Some(parent_id)
    }

    /// Collect all descendant node IDs (not including `id` itself), depth-first.
    pub fn descendants(&self, id: NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        if let Some(node) = self.get(id) {
            if let BspKind::Split(s) = &node.kind {
                let (fc, sc) = (s.first_child, s.second_child);
                result.push(fc);
                result.push(sc);
                result.extend(self.descendants(fc));
                result.extend(self.descendants(sc));
            }
        }
        result
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
            }
        }
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

    /// Return the sibling of `id` if it exists.
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
            // Arrow key semantics: left/right navigate between siblings
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
                // Try going into first child if this is a split
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
            _ => current,
        }
    }
}
