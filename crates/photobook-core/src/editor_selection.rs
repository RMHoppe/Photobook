use wasm_bindgen::prelude::*;
use crate::bsp::{BspKind, NodeId, NULL_ID, SplitAxis, SplitData};
use crate::interaction::DragState;
use crate::layout::LayoutResolver;
use crate::PhotobookEditor;

fn parent_is_pinwheel(editor: &PhotobookEditor, id: NodeId) -> bool {
    editor.doc.current_spread().tree.get(id)
        .and_then(|n| n.parent)
        .and_then(|pid| editor.doc.current_spread().tree.get(pid))
        .map(|pn| matches!(pn.kind, BspKind::Pinwheel(_)))
        .unwrap_or(false)
}

#[wasm_bindgen]
impl PhotobookEditor {
    // -----------------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------------

    /// Replace the selection with a single node, or clear it if id == NULL_ID.
    pub fn select_node(&mut self, id: u32) {
        if id == NULL_ID {
            self.selection.clear();
        } else if self.doc.current_spread().tree.get(id).is_some() {
            self.selection = vec![id];
        }
    }

    /// Add `id` to the selection if it is not already selected; remove it if it is.
    pub fn toggle_selection(&mut self, id: u32) {
        if id == NULL_ID { return; }
        if self.doc.current_spread().tree.get(id).is_none() { return; }
        if let Some(pos) = self.selection.iter().position(|&x| x == id) {
            self.selection.remove(pos);
        } else {
            self.selection.push(id);
        }
    }

    /// Returns true if `id` is currently selected.
    pub fn is_selected(&self, id: u32) -> bool {
        self.selection.contains(&id)
    }

    /// Returns the number of currently selected nodes.
    pub fn get_selection_count(&self) -> u32 {
        self.selection.len() as u32
    }

    /// Returns a JSON array of all currently selected node IDs.
    pub fn get_all_selected(&self) -> String {
        serde_json::to_string(&self.selection).unwrap_or_else(|_| "[]".into())
    }

    pub fn select_all(&mut self) {
        let tree = &self.doc.current_spread().tree;
        let mut all = tree.leaves();
        all.extend(
            tree.nodes.keys().copied()
                .filter(|&id| matches!(tree.get(id).map(|n| &n.kind), Some(BspKind::Split(_))))
        );
        self.selection = all;
    }

    /// Select all leaves **and** split nodes whose divider intersects the given rect.
    pub fn select_nodes_in_rect(&mut self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) {
        self.selection.clear();
        for id in self.collect_nodes_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.selection.push(id);
        }
    }

    /// Toggle membership of leaves and split nodes whose divider intersects the given rect.
    pub fn toggle_nodes_in_rect(&mut self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) {
        for id in self.collect_nodes_in_rect(rx, ry, rw, rh, canvas_w, canvas_h) {
            self.toggle_selection(id);
        }
    }

    /// Returns the number of leaf nodes in the current selection.
    pub fn get_selection_leaf_count(&self) -> u32 {
        let tree = &self.doc.current_spread().tree;
        self.selection.iter()
            .filter(|&&id| matches!(tree.get(id).map(|n| &n.kind), Some(BspKind::Leaf(_))))
            .count() as u32
    }

    /// Returns the number of split nodes in the current selection.
    /// PinwheelSplitter nodes are counted as splits for sidebar purposes.
    pub fn get_selection_split_count(&self) -> u32 {
        let tree = &self.doc.current_spread().tree;
        self.selection.iter()
            .filter(|&&id| matches!(
                tree.get(id).map(|n| &n.kind),
                Some(BspKind::Split(_)) | Some(BspKind::PinwheelSplitter(_))
            ))
            .count() as u32
    }

    /// Move selection to the neighbour in `direction`. Only operates on a single selection.
    pub fn navigate(&mut self, direction: &str) {
        let Some(id) = self.selected_one() else { return; };
        let next = self.doc.current_spread().tree.navigate(id, direction);
        if next != NULL_ID {
            self.selection = vec![next];
        }
    }

    /// Returns the single selected node ID, or NULL_ID if the selection is empty or > 1.
    pub fn get_selected(&self) -> u32 {
        self.selected_one().unwrap_or(NULL_ID)
    }

    // -----------------------------------------------------------------------
    // Tree mutation
    // -----------------------------------------------------------------------

    pub fn split_selected(&mut self, axis: &str) -> bool {
        let Some(id) = self.selected_one() else { return false; };
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        if let Some((first, _)) = self.doc.current_spread_mut().tree.split(id, split_axis) {
            self.selection = vec![first];
            self.mark_structure_dirty();
            return true;
        }
        false
    }

    /// Split the selected leaf at a specific ratio instead of the default 0.5.
    pub fn split_selected_at(&mut self, axis: &str, ratio: f32) -> bool {
        let Some(id) = self.selected_one() else { return false; };
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        if let Some((first, _)) = self.doc.current_spread_mut().tree.split(id, split_axis) {
            self.set_node_ratio(id, ratio.clamp(0.05, 0.95));
            self.selection = vec![first];
            self.mark_structure_dirty();
            return true;
        }
        false
    }

    /// Wrap the entire current spread's BSP tree in a new root split.
    /// `new_is_first`: true when the new empty leaf is the first child (drag from top/left).
    /// Selects the new split node and returns its ID.
    pub fn insert_split_at_root(&mut self, axis: &str, ratio: f32, new_is_first: bool) -> u32 {
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        let (split_id, _) = self.doc.current_spread_mut().tree.wrap_root_with_split(split_axis, ratio, new_is_first);
        self.selection = vec![split_id];
        self.mark_structure_dirty();
        split_id
    }

    pub fn split_node_at(&mut self, id: u32, axis: &str, ratio: f32) -> bool {
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        if let Some((first, _)) = self.doc.current_spread_mut().tree.split(id, split_axis) {
            self.set_node_ratio(id, ratio.clamp(0.05, 0.95));
            self.selection = vec![first];
            self.mark_structure_dirty();
            return true;
        }
        false
    }

    /// Split a leaf into `n` equal frames along `axis` ("v" or "h"). Returns false if already split.
    pub fn split_node_into_n(&mut self, id: u32, axis: &str, n: u32) -> bool {
        if n == 0 { return false; }
        if n == 1 { return true; }
        let split_axis = if axis == "h" { SplitAxis::Horizontal } else { SplitAxis::Vertical };
        let leaves = self.split_into_n_collect(id, split_axis, n);
        if let Some(&first) = leaves.first() {
            self.selection = vec![first];
        }
        self.mark_structure_dirty();
        true
    }

    /// Split a leaf into an n×n grid: n equal vertical strips, each horizontally split into n.
    pub fn split_node_into_quadrant_n(&mut self, id: u32, n: u32) -> bool {
        if n == 0 { return false; }
        let v_leaves = self.split_into_n_collect(id, SplitAxis::Vertical, n);
        let first = v_leaves.first().copied();
        for leaf in v_leaves {
            self.split_into_n_collect(leaf, SplitAxis::Horizontal, n);
        }
        if let Some(first_id) = first {
            self.selection = vec![first_id];
        }
        self.mark_structure_dirty();
        true
    }

    fn split_into_n_collect(&mut self, id: u32, axis: SplitAxis, n: u32) -> Vec<u32> {
        if n <= 1 { return vec![id]; }
        let mut current_id = id;
        let mut leaves = Vec::with_capacity(n as usize);
        for i in 0..(n - 1) {
            let ratio = 1.0 / (n - i) as f32;
            let Some((first, second)) = self.doc.current_spread_mut().tree.split(current_id, axis) else { break; };
            self.set_node_ratio(current_id, ratio);
            leaves.push(first);
            current_id = second;
        }
        leaves.push(current_id);
        leaves
    }

    /// Delete all currently selected leaf nodes.
    pub fn delete_selected(&mut self) -> bool {
        if self.selection.is_empty() { return false; }
        let ids: Vec<NodeId> = self.selection.drain(..).collect();
        let mut any_deleted = false;
        for id in ids {
            if self.doc.current_spread().tree.get(id).is_none() { continue; }
            if parent_is_pinwheel(self, id) {
                if self.delete_pinwheel_panel_inner(id) {
                    any_deleted = true;
                }
            } else if self.doc.current_spread_mut().tree.delete_leaf(id).is_some() {
                any_deleted = true;
            }
        }
        if any_deleted { self.mark_structure_dirty(); }
        any_deleted
    }

    // -----------------------------------------------------------------------
    // Z-order
    // -----------------------------------------------------------------------

    /// Return the z_index of the node with the given id, or 0 if not found.
    pub fn get_node_z_index(&self, id: u32) -> i32 {
        self.doc.current_spread().tree.get(id)
            .map(|n| n.z_index)
            .unwrap_or(0)
    }

    /// Move the node with `id` one step up or down in rendering order among all leaves.
    pub fn move_node_z_order(&mut self, id: u32, direction: &str) {
        let spread = &self.doc.spreads[self.doc.current_spread];
        let leaf_ids = spread.tree.leaves();

        let mut entries: Vec<(i32, usize, u32)> = leaf_ids.iter()
            .enumerate()
            .filter_map(|(pos, &lid)| spread.tree.get(lid).map(|n| (n.z_index, pos, lid)))
            .collect();
        entries.sort_by_key(|(z, pos, _)| (*z, *pos as i32));

        let Some(cur_pos) = entries.iter().position(|(_, _, lid)| *lid == id) else { return; };

        match direction {
            "up"   if cur_pos + 1 < entries.len() => entries.swap(cur_pos, cur_pos + 1),
            "down" if cur_pos > 0                 => entries.swap(cur_pos, cur_pos - 1),
            _ => return,
        }

        let spread_mut = &mut self.doc.spreads[self.doc.current_spread];
        for (new_z, (_, _, lid)) in entries.iter().enumerate() {
            if let Some(node) = spread_mut.tree.get_mut(*lid) {
                node.z_index = new_z as i32;
            }
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // Divider drag
    // -----------------------------------------------------------------------

    pub fn begin_divider_drag(&mut self, node_id: u32, canvas_w: f32, canvas_h: f32) {
        let (_leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        if let Some(div) = divs.iter().find(|d| d.node_id == node_id) {
            const ALIGN_PX: f32 = 2.0;
            let my_pos = if div.axis == SplitAxis::Vertical { div.x } else { div.y };
            let locked_ids: Vec<NodeId> = divs.iter()
                .filter(|d| d.node_id != node_id && d.axis == div.axis)
                .filter(|d| {
                    let p = if d.axis == SplitAxis::Vertical { d.x } else { d.y };
                    (p - my_pos).abs() < ALIGN_PX
                })
                .map(|d| d.node_id)
                .collect();
            self.drag = Some(DragState { node_id, axis: div.axis, locked_ids });
        }
    }

    pub fn update_divider_drag(&mut self, mouse_x: f32, mouse_y: f32, canvas_w: f32, canvas_h: f32) {
        self.mouse_x = mouse_x;
        self.mouse_y = mouse_y;
        let (node_id, axis, locked_ids) = match &self.drag {
            Some(d) => (d.node_id, d.axis, d.locked_ids.clone()),
            None => return,
        };

        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px = self.mm_to_px(canvas_w);
        let resolver = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px);

        let Some(node_rect) = resolver.resolve_node_rect(node_id, root_rect) else { return; };
        let dim = if axis == SplitAxis::Vertical { node_rect.w } else { node_rect.h };
        if dim <= 0.0 { return; }

        let raw_pos = if axis == SplitAxis::Vertical { mouse_x } else { mouse_y };
        let origin  = if axis == SplitAxis::Vertical { node_rect.x } else { node_rect.y };
        let raw_ratio = (raw_pos - origin) / dim;

        const SNAP_PX: f32 = 8.0;
        let dividers = resolver.resolve_dividers(root_rect);
        let mut new_ratio = raw_ratio;
        let candidate = origin + raw_ratio * dim;

        // Snap to 50%.
        if (raw_ratio - 0.5).abs() * dim < SNAP_PX {
            new_ratio = 0.5;
        } else {
            // Snap to non-locked sibling dividers on the same axis.
            for div in dividers.iter().filter(|d| d.node_id != node_id && !locked_ids.contains(&d.node_id) && d.axis == axis) {
                let snap_pos = if axis == SplitAxis::Vertical { div.x } else { div.y };
                if (candidate - snap_pos).abs() < SNAP_PX {
                    new_ratio = (snap_pos - origin) / dim;
                    break;
                }
            }
        }

        let snapped_px = origin + new_ratio * dim;

        // PinwheelSplitter: update the parent pinwheel parameter instead of a split ratio.
        if matches!(
            self.doc.current_spread().tree.get(node_id).map(|n| &n.kind),
            Some(BspKind::PinwheelSplitter(_))
        ) {
            self.update_pinwheel_splitter_param(node_id, new_ratio);
            self.mark_structure_dirty();
            return;
        }

        self.set_node_ratio(node_id, new_ratio.clamp(0.05, 0.95));

        // Move all locked dividers to the same absolute pixel position.
        for locked_id in locked_ids {
            let resolver2 = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px);
            if let Some(lr) = resolver2.resolve_node_rect(locked_id, root_rect) {
                let ldim   = if axis == SplitAxis::Vertical { lr.w } else { lr.h };
                let lorigin = if axis == SplitAxis::Vertical { lr.x } else { lr.y };
                if ldim > 0.0 {
                    self.set_node_ratio(locked_id, ((snapped_px - lorigin) / ldim).clamp(0.05, 0.95));
                }
            }
        }
        self.mark_structure_dirty();
    }

    // -----------------------------------------------------------------------
    // Cross handle rewiring
    // -----------------------------------------------------------------------

    /// Return a JSON array of `ResolvedCrossHandle` for the current spread.
    pub fn get_cross_handles(&self, canvas_w: f32, canvas_h: f32) -> String {
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let resolver  = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px);
        serde_json::to_string(&resolver.resolve_cross_handles(root_rect))
            .unwrap_or_else(|_| "[]".into())
    }

    /// Rewire a quadrant layout: flip axes of S0 and its two split children, swap inner
    /// grandchildren so rows become columns (or vice versa).
    ///
    /// - S0 gets the locked alignment ratio (S1's old child ratio).
    /// - The dragged child (selected by `first_child`) gets `drag_ratio`.
    /// - The other child keeps S0's original ratio.
    pub fn rewire_cross_handle(&mut self, parent_id: u32, first_child: bool, drag_ratio: f32) -> bool {
        let tree = &self.doc.current_spread().tree;
        // Read all needed data before mutable borrows.
        let (left_id, right_id, p_ratio, parent_axis) = match tree.get(parent_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => (s.first_child, s.second_child, s.ratio, s.axis),
            _ => return false,
        };
        // c_ratio = locked alignment (S1's stored ratio, same as S2's since they're locked).
        let (ll_id, lr_id, child_axis, c_ratio) = match tree.get(left_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => (s.first_child, s.second_child, s.axis, s.ratio),
            _ => return false,
        };
        let (rl_id, rr_id) = match tree.get(right_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => (s.first_child, s.second_child),
            _ => return false,
        };
        if parent_axis == child_axis { return false; }

        // Dragged child gets drag_ratio; the other keeps the parent's old ratio.
        let (left_new_ratio, right_new_ratio) = if first_child {
            (drag_ratio.clamp(0.05, 0.95), p_ratio.clamp(0.05, 0.95))
        } else {
            (p_ratio.clamp(0.05, 0.95), drag_ratio.clamp(0.05, 0.95))
        };

        let tree = &mut self.doc.current_spread_mut().tree;
        // Swap inner grandchildren's parents: C → S1, B → S2.
        if let Some(n) = tree.get_mut(rl_id) { n.parent = Some(left_id); }
        if let Some(n) = tree.get_mut(lr_id) { n.parent = Some(right_id); }
        // S1: flip axis, keep A as first, adopt C as second.
        if let Some(n) = tree.get_mut(left_id) {
            n.kind = BspKind::Split(SplitData { axis: parent_axis, ratio: left_new_ratio,
                first_child: ll_id, second_child: rl_id });
        }
        // S2: flip axis, adopt B as first, keep D as second.
        if let Some(n) = tree.get_mut(right_id) {
            n.kind = BspKind::Split(SplitData { axis: parent_axis, ratio: right_new_ratio,
                first_child: lr_id, second_child: rr_id });
        }
        // S0: flip axis, set locked alignment ratio.
        if let Some(n) = tree.get_mut(parent_id) {
            n.kind = BspKind::Split(SplitData { axis: child_axis,
                ratio: c_ratio.clamp(0.05, 0.95),
                first_child: left_id, second_child: right_id });
        }
        self.selection = vec![parent_id];
        self.mark_structure_dirty();
        true
    }

    /// During a live rewire drag: move only the dragged child's divider, with snapping.
    /// Mirrors `update_divider_drag` but targets the rewired child by parent + slot.
    pub fn update_rewired_drag(
        &mut self,
        parent_id: u32, first_child: bool,
        mouse_x: f32, mouse_y: f32,
        canvas_w: f32, canvas_h: f32,
    ) {
        let child_id = match self.doc.current_spread().tree.get(parent_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => if first_child { s.first_child } else { s.second_child },
            _ => return,
        };
        let child_axis = match self.doc.current_spread().tree.get(child_id).map(|n| &n.kind) {
            Some(BspKind::Split(s)) => s.axis,
            _ => return,
        };

        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let resolver  = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px);

        let Some(child_rect) = resolver.resolve_node_rect(child_id, root_rect) else { return };
        let dim    = if child_axis == SplitAxis::Vertical { child_rect.w } else { child_rect.h };
        if dim <= 0.0 { return; }

        let raw_pos  = if child_axis == SplitAxis::Vertical { mouse_x } else { mouse_y };
        let origin   = if child_axis == SplitAxis::Vertical { child_rect.x } else { child_rect.y };
        let raw_ratio = (raw_pos - origin) / dim;
        let candidate = origin + raw_ratio * dim;

        const SNAP_PX: f32 = 8.0;
        let dividers = resolver.resolve_dividers(root_rect);
        let mut new_ratio = raw_ratio;

        if (raw_ratio - 0.5).abs() * dim < SNAP_PX {
            new_ratio = 0.5;
        } else {
            for div in dividers.iter().filter(|d| d.node_id != child_id && d.axis == child_axis) {
                let snap_pos = if child_axis == SplitAxis::Vertical { div.x } else { div.y };
                if (candidate - snap_pos).abs() < SNAP_PX {
                    new_ratio = (snap_pos - origin) / dim;
                    break;
                }
            }
        }

        self.set_node_ratio(child_id, new_ratio.clamp(0.05, 0.95));
        self.mark_structure_dirty();
    }

    /// Like `begin_divider_drag` but without inheriting any locked peers — used by unlock handles.
    pub fn begin_divider_drag_unlocked(&mut self, node_id: u32, canvas_w: f32, canvas_h: f32) {
        let (_leaves, divs) = self.current_resolved(canvas_w, canvas_h);
        if let Some(div) = divs.iter().find(|d| d.node_id == node_id) {
            self.drag = Some(DragState { node_id, axis: div.axis, locked_ids: vec![] });
        }
    }

    pub fn end_divider_drag(&mut self) {
        self.drag = None;
    }

    // -----------------------------------------------------------------------
    // Split node ratio mutation (multi-selection aware)
    // -----------------------------------------------------------------------

    /// Set the ratio on **all** selected split nodes; clamped to [0.05, 0.95].
    pub fn set_split_ratios(&mut self, ratio: f32) {
        let ids: Vec<NodeId> = self.selection.iter().copied().collect();
        for id in ids {
            match self.doc.current_spread().tree.get(id).map(|n| &n.kind) {
                Some(BspKind::Split(_)) => {
                    if let Some(node) = self.doc.current_spread_mut().tree.get_mut(id) {
                        if let BspKind::Split(ref mut s) = node.kind {
                            s.ratio = ratio.clamp(0.05, 0.95);
                        }
                    }
                }
                Some(BspKind::PinwheelSplitter(_)) => {
                    self.update_pinwheel_splitter_param(id, ratio.clamp(0.05, 0.95));
                }
                _ => {}
            }
        }
    }
}

impl PhotobookEditor {
    /// Collect leaf and split-node IDs whose geometry intersects the given spread-relative rect.
    /// Uses a single resolve_all pass for efficiency.
    fn collect_nodes_in_rect(&self, rx: f32, ry: f32, rw: f32, rh: f32, canvas_w: f32, canvas_h: f32) -> Vec<NodeId> {
        let root_rect = self.root_rect_with_bleed(canvas_w, canvas_h);
        let mm_to_px  = self.mm_to_px(canvas_w);
        let bleed_px  = self.doc.bleed_mm * mm_to_px;
        let resolved  = LayoutResolver::new(&self.doc.current_spread().tree, &[], mm_to_px)
                            .resolve_all(root_rect);
        let mut ids: Vec<NodeId> = Vec::new();
        for leaf in &resolved.leaves {
            let lx = leaf.rect.x + bleed_px;
            let ly = leaf.rect.y + bleed_px;
            if lx < rx + rw && lx + leaf.rect.w > rx && ly < ry + rh && ly + leaf.rect.h > ry {
                ids.push(leaf.id);
            }
        }
        for div in &resolved.dividers {
            if Self::divider_hits_rect(div, rx, ry, rw, rh) {
                ids.push(div.node_id);
            }
        }
        ids
    }

    /// Returns true if the divider line intersects the marquee rect (spread-relative coords).
    fn divider_hits_rect(
        div: &crate::layout::ResolvedDivider,
        rx: f32, ry: f32, rw: f32, rh: f32,
    ) -> bool {
        match div.axis {
            SplitAxis::Vertical =>
                div.x >= rx && div.x <= rx + rw
                && div.y < ry + rh && div.y + div.length > ry,
            SplitAxis::Horizontal =>
                div.y >= ry && div.y <= ry + rh
                && div.x < rx + rw && div.x + div.length > rx,
        }
    }
}
