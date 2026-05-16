//! Sorted-edge grid layout model.
//!
//! The spread is partitioned into rectangular **faces** by **edges**. Each
//! face owns exactly four edges (top, bottom, left, right). Interior dividers
//! are represented as **twin pairs** — two edges at the same offset with
//! opposite `Facing`. An edge's extent along its perpendicular axis is
//! derived on-demand from the face it belongs to, so the model stores only
//! the scalar `offset` and orientation.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::layout::{BoxModel, ObjectFit, SplitAxis};

// ---------------------------------------------------------------------------
// ID types and sentinels
// ---------------------------------------------------------------------------

pub type FaceId = u32;
pub type EdgeId = u32;

pub const OUTER_FACE: FaceId = u32::MAX;
pub(crate) const EPS: f32 = 1e-5;
pub const MIN_FRAC: f32 = 0.02;

// ---------------------------------------------------------------------------
// Face content
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageContent {
    pub image_id: Option<String>,
    pub object_fit: ObjectFit,
    pub pan_x: f32,
    pub pan_y: f32,
    /// User zoom multiplier on top of the minimum cover scale. ≥ 1.0.
    pub scale: f32,
    /// Rotation in degrees counter-clockwise.
    pub rotation_deg: f32,
}

impl Default for ImageContent {
    fn default() -> Self {
        ImageContent {
            image_id: None,
            object_fit: ObjectFit::Cover,
            pan_x: 0.5,
            pan_y: 0.5,
            scale: 1.0,
            rotation_deg: 0.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Facing
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Facing {
    /// The edge is the Start (top/left) boundary of its face.
    Start,
    /// The edge is the End (bottom/right) boundary of its face.
    End,
}

impl Facing {
    pub fn opposite(&self) -> Facing {
        match self { Facing::Start => Facing::End, Facing::End => Facing::Start }
    }
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Orientation {
    /// A horizontal edge (constant y); its extent is the x-span of its face.
    Horizontal,
    /// A vertical edge (constant x); its extent is the y-span of its face.
    Vertical,
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Edge {
    pub id: EdgeId,
    pub orientation: Orientation,
    /// Normalized position along the perpendicular axis (y for H, x for V).
    pub offset: f32,
    pub facing: Facing,
    pub half_gap: f32,
    pub face_id: FaceId,
    pub is_boundary: bool,
}

// ---------------------------------------------------------------------------
// Face
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GridFace {
    pub id: FaceId,
    pub left_edge_id: EdgeId,
    pub top_edge_id: EdgeId,
    pub right_edge_id: EdgeId,
    pub bottom_edge_id: EdgeId,
    pub image: ImageContent,
    pub box_model: BoxModel,
    pub z_index: i32,
}

// ---------------------------------------------------------------------------
// GridLayout
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GridLayout {
    pub faces: HashMap<FaceId, GridFace>,
    pub edges: HashMap<EdgeId, Edge>,
    next_face_id: FaceId,
    next_edge_id: EdgeId,
}

impl GridLayout {
    /// Create a new layout with a single face covering the unit square [0,1]×[0,1].
    pub fn new() -> Self {
        let mut layout = GridLayout {
            faces: HashMap::new(),
            edges: HashMap::new(),
            next_face_id: 0,
            next_edge_id: 0,
        };

        let face_id = layout.alloc_face();
        let top_id   = layout.alloc_edge();
        let bot_id   = layout.alloc_edge();
        let left_id  = layout.alloc_edge();
        let right_id = layout.alloc_edge();

        layout.edges.insert(top_id, Edge {
            id: top_id, orientation: Orientation::Horizontal, offset: 0.0,
            facing: Facing::Start, half_gap: 0.0, face_id, is_boundary: true,
        });
        layout.edges.insert(bot_id, Edge {
            id: bot_id, orientation: Orientation::Horizontal, offset: 1.0,
            facing: Facing::End, half_gap: 0.0, face_id, is_boundary: true,
        });
        layout.edges.insert(left_id, Edge {
            id: left_id, orientation: Orientation::Vertical, offset: 0.0,
            facing: Facing::Start, half_gap: 0.0, face_id, is_boundary: true,
        });
        layout.edges.insert(right_id, Edge {
            id: right_id, orientation: Orientation::Vertical, offset: 1.0,
            facing: Facing::End, half_gap: 0.0, face_id, is_boundary: true,
        });

        layout.faces.insert(face_id, GridFace {
            id: face_id,
            left_edge_id: left_id,
            top_edge_id: top_id,
            right_edge_id: right_id,
            bottom_edge_id: bot_id,
            image: ImageContent::default(),
            box_model: BoxModel::default(),
            z_index: 0,
        });

        layout
    }

    fn alloc_face(&mut self) -> FaceId {
        let id = self.next_face_id;
        self.next_face_id += 1;
        id
    }

    fn alloc_edge(&mut self) -> EdgeId {
        let id = self.next_edge_id;
        self.next_edge_id += 1;
        id
    }

    // -----------------------------------------------------------------------
    // Extent helper
    // -----------------------------------------------------------------------

    /// Returns `(lo, hi)` — the normalized span of `id` along its perpendicular
    /// axis — by reading the offset of the face's opposing pair of edges.
    ///
    /// For a Horizontal edge this is `(left_offset, right_offset)`.
    /// For a Vertical edge this is `(top_offset, bottom_offset)`.
    pub fn edge_extent(&self, id: EdgeId) -> Option<(f32, f32)> {
        let e    = self.edges.get(&id)?;
        let face = self.faces.get(&e.face_id)?;
        match e.orientation {
            Orientation::Horizontal => {
                let lo = self.edges.get(&face.left_edge_id)?.offset;
                let hi = self.edges.get(&face.right_edge_id)?.offset;
                Some((lo, hi))
            }
            Orientation::Vertical => {
                let lo = self.edges.get(&face.top_edge_id)?.offset;
                let hi = self.edges.get(&face.bottom_edge_id)?.offset;
                Some((lo, hi))
            }
        }
    }

    // -----------------------------------------------------------------------
    // Geometry queries
    // -----------------------------------------------------------------------

    /// Returns (x, y, w, h) in normalized [0,1] coordinates, or None if unknown face.
    pub fn face_rect(&self, id: FaceId) -> Option<(f32, f32, f32, f32)> {
        let face  = self.faces.get(&id)?;
        let top   = self.edges.get(&face.top_edge_id)?.offset;
        let bot   = self.edges.get(&face.bottom_edge_id)?.offset;
        let left  = self.edges.get(&face.left_edge_id)?.offset;
        let right = self.edges.get(&face.right_edge_id)?.offset;
        Some((left, top, right - left, bot - top))
    }

    /// Find the face whose rectangle contains (px, py) in normalized coords.
    pub fn face_at(&self, px: f32, py: f32) -> Option<FaceId> {
        for face in self.faces.values() {
            let Some((fx, fy, fw, fh)) = self.face_rect(face.id) else { continue };
            if px >= fx - EPS && px <= fx + fw + EPS && py >= fy - EPS && py <= fy + fh + EPS {
                return Some(face.id);
            }
        }
        None
    }

    // -----------------------------------------------------------------------
    // Splitting
    // -----------------------------------------------------------------------

    /// Split `face_id` at normalized `pos` along `axis`. Returns the new trailing face ID.
    pub fn split_face(&mut self, face_id: FaceId, pos: f32, axis: SplitAxis) -> Option<FaceId> {
        let face = self.faces.get(&face_id)?.clone();

        // lo/hi: the along-axis boundaries of this face (the cut must fall between them).
        // pa/pb: the perpendicular edges carried into the new face.
        let (lo_eid, hi_eid, pa_eid, pb_eid) = match axis {
            SplitAxis::Horizontal => (face.top_edge_id,  face.bottom_edge_id, face.left_edge_id,  face.right_edge_id),
            SplitAxis::Vertical   => (face.left_edge_id, face.right_edge_id,  face.top_edge_id,   face.bottom_edge_id),
        };
        let lo     = self.edges.get(&lo_eid)?.offset;
        let hi     = self.edges.get(&hi_eid)?.offset;
        let pa     = self.edges.get(&pa_eid)?.offset;
        let pb     = self.edges.get(&pb_eid)?.offset;
        let pa_bnd = self.edges.get(&pa_eid)?.is_boundary;
        let pb_bnd = self.edges.get(&pb_eid)?.is_boundary;
        if pos <= lo + EPS || pos >= hi - EPS { return None; }

        let (div_ori, perp_ori) = match axis {
            SplitAxis::Horizontal => (Orientation::Horizontal, Orientation::Vertical),
            SplitAxis::Vertical   => (Orientation::Vertical,   Orientation::Horizontal),
        };

        let new_face_id  = self.alloc_face();
        let div_end_id   = self.alloc_edge();
        let div_start_id = self.alloc_edge();
        let new_pa_id    = self.alloc_edge();
        let new_pb_id    = self.alloc_edge();

        self.edges.insert(div_end_id, Edge {
            id: div_end_id, orientation: div_ori.clone(), offset: pos,
            facing: Facing::End, half_gap: 0.0, face_id, is_boundary: false,
        });
        self.edges.insert(div_start_id, Edge {
            id: div_start_id, orientation: div_ori, offset: pos,
            facing: Facing::Start, half_gap: 0.0, face_id: new_face_id, is_boundary: false,
        });
        if let Some(e) = self.edges.get_mut(&hi_eid) { e.face_id = new_face_id; }
        self.edges.insert(new_pa_id, Edge {
            id: new_pa_id, orientation: perp_ori.clone(), offset: pa,
            facing: Facing::Start, half_gap: 0.0, face_id: new_face_id, is_boundary: pa_bnd,
        });
        self.edges.insert(new_pb_id, Edge {
            id: new_pb_id, orientation: perp_ori, offset: pb,
            facing: Facing::End, half_gap: 0.0, face_id: new_face_id, is_boundary: pb_bnd,
        });

        if let Some(f) = self.faces.get_mut(&face_id) {
            match axis {
                SplitAxis::Horizontal => f.bottom_edge_id = div_end_id,
                SplitAxis::Vertical   => f.right_edge_id  = div_end_id,
            }
        }

        let new_face = match axis {
            SplitAxis::Horizontal => GridFace {
                id: new_face_id,
                left_edge_id:   new_pa_id,
                top_edge_id:    div_start_id,
                right_edge_id:  new_pb_id,
                bottom_edge_id: hi_eid,
                image: ImageContent::default(),
                box_model: face.box_model.clone(),
                z_index: 0,
            },
            SplitAxis::Vertical => GridFace {
                id: new_face_id,
                left_edge_id:   div_start_id,
                top_edge_id:    new_pa_id,
                right_edge_id:  hi_eid,
                bottom_edge_id: new_pb_id,
                image: ImageContent::default(),
                box_model: face.box_model.clone(),
                z_index: 0,
            },
        };
        self.faces.insert(new_face_id, new_face);
        Some(new_face_id)
    }

    /// Split every face that spans `pos` along `axis`. Returns all new edge IDs.
    ///
    /// When `new_is_first` is true the new face is the leading one (top/left),
    /// so the existing image content must move to the trailing (new) face.
    pub fn split_all(&mut self, pos: f32, axis: SplitAxis, new_is_first: bool) -> Vec<EdgeId> {
        let face_ids: Vec<FaceId> = self.faces.keys().copied()
            .filter(|&id| {
                if let Some((fx, fy, fw, fh)) = self.face_rect(id) {
                    match axis {
                        SplitAxis::Horizontal => fy + EPS < pos && pos < fy + fh - EPS,
                        SplitAxis::Vertical   => fx + EPS < pos && pos < fx + fw - EPS,
                    }
                } else { false }
            })
            .collect();

        let mut new_edges = Vec::new();
        for face_id in face_ids {
            if let Some(new_face_id) = self.split_face(face_id, pos, axis) {
                // split_face always leaves the image in `face_id` (the leading half).
                // When the new panel is at the leading edge the image should move to
                // the trailing half (`new_face_id`) so the new slot is empty.
                if new_is_first {
                    let img = self.faces.get_mut(&face_id).unwrap().image.clone();
                    self.faces.get_mut(&face_id).unwrap().image = ImageContent::default();
                    self.faces.get_mut(&new_face_id).unwrap().image = img;
                }
                match axis {
                    SplitAxis::Horizontal => {
                        new_edges.push(self.faces[&face_id].bottom_edge_id);
                        new_edges.push(self.faces[&new_face_id].top_edge_id);
                    }
                    SplitAxis::Vertical => {
                        new_edges.push(self.faces[&face_id].right_edge_id);
                        new_edges.push(self.faces[&new_face_id].left_edge_id);
                    }
                }
            }
        }
        new_edges
    }

    // -----------------------------------------------------------------------
    // Twin pair helper
    // -----------------------------------------------------------------------

    /// Find the twin of `edge_id` (same orientation/offset/extent, opposite facing).
    pub fn twin(&self, edge_id: EdgeId) -> Option<EdgeId> {
        let e = self.edges.get(&edge_id)?;
        let target = e.facing.opposite();
        let (elo, ehi) = self.edge_extent(edge_id)?;
        self.edges.values().find(|o| {
            o.id != edge_id
                && o.orientation == e.orientation
                && o.facing == target
                && (o.offset - e.offset).abs() < EPS
                && self.edge_extent(o.id)
                    .map(|(lo, hi)| (lo - elo).abs() < EPS && (hi - ehi).abs() < EPS)
                    .unwrap_or(false)
        }).map(|o| o.id)
    }

    // -----------------------------------------------------------------------
    // Deletion
    // -----------------------------------------------------------------------

    /// Delete the twin pair containing `edge_id`, merging the two adjacent faces.
    /// Returns the merged face ID, or None if the edge can't be deleted.
    pub fn delete_twin_pair(&mut self, edge_id: EdgeId) -> Option<FaceId> {
        if self.is_boundary_edge(edge_id) { return None; }
        if !self.edges.contains_key(&edge_id) { return None; }
        self.delete_twin_pair_internal(edge_id)
    }

    fn delete_twin_pair_internal(&mut self, edge_id: EdgeId) -> Option<FaceId> {
        let e = self.edges.get(&edge_id)?.clone();

        let (end_id, start_id) = match e.facing {
            Facing::End   => (edge_id, self.twin(edge_id)?),
            Facing::Start => (self.twin(edge_id)?, edge_id),
        };

        // f_end's boundary in this orientation is end_id (e.g. "above" for H, "left" for V).
        // f_start's boundary in this orientation is start_id ("below" for H, "right" for V).
        let f_end   = self.edges[&end_id].face_id;
        let f_start = self.edges[&start_id].face_id;

        let face_end   = self.faces.get(&f_end)?.clone();
        let face_start = self.faces.get(&f_start)?.clone();

        // For H: lateral edges are left/right (V), outer edges are top/bottom (H).
        // For V: lateral edges are top/bottom (H), outer edges are left/right (V).
        let (end_lat_a, end_lat_b, start_lat_a, start_lat_b, end_outer, start_outer) =
            match e.orientation {
                Orientation::Horizontal => (
                    face_end.left_edge_id,   face_end.right_edge_id,
                    face_start.left_edge_id, face_start.right_edge_id,
                    face_end.top_edge_id,    face_start.bottom_edge_id,
                ),
                Orientation::Vertical => (
                    face_end.top_edge_id,    face_end.bottom_edge_id,
                    face_start.top_edge_id,  face_start.bottom_edge_id,
                    face_end.left_edge_id,   face_start.right_edge_id,
                ),
            };

        // Merged face inherits the face that has content (or f_end by default).
        let f_end_has = self.faces[&f_end].image.image_id.is_some()
            || !self.faces[&f_end].box_model.bg.is_empty();
        let f_start_has = self.faces[&f_start].image.image_id.is_some()
            || !self.faces[&f_start].box_model.bg.is_empty();
        let merged_id = if f_end_has || !f_start_has { f_end } else { f_start };

        // Merge the is_boundary flags for the surviving lateral edge pair.
        let lat_a_bnd = self.edges.get(&end_lat_a).map(|e| e.is_boundary).unwrap_or(false)
            || self.edges.get(&start_lat_a).map(|e| e.is_boundary).unwrap_or(false);
        let lat_b_bnd = self.edges.get(&end_lat_b).map(|e| e.is_boundary).unwrap_or(false)
            || self.edges.get(&start_lat_b).map(|e| e.is_boundary).unwrap_or(false);

        // Remove the twin pair.
        self.edges.remove(&end_id);
        self.edges.remove(&start_id);

        // Pick which face's lateral edges survive and which are removed.
        let (surv_lat_a, surv_lat_b, rem_lat_a, rem_lat_b) = if merged_id == f_end {
            (end_lat_a, end_lat_b, start_lat_a, start_lat_b)
        } else {
            (start_lat_a, start_lat_b, end_lat_a, end_lat_b)
        };

        self.edges.remove(&rem_lat_a);
        self.edges.remove(&rem_lat_b);
        if let Some(e) = self.edges.get_mut(&surv_lat_a) {
            e.is_boundary = lat_a_bnd;
            e.face_id = merged_id;
        }
        if let Some(e) = self.edges.get_mut(&surv_lat_b) {
            e.is_boundary = lat_b_bnd;
            e.face_id = merged_id;
        }

        // Update the outer edge face_ids.
        if let Some(e) = self.edges.get_mut(&end_outer)   { e.face_id = merged_id; }
        if let Some(e) = self.edges.get_mut(&start_outer) { e.face_id = merged_id; }

        // Build the merged face record.
        let merged_image = self.faces[&merged_id].image.clone();
        let merged_box   = self.faces[&merged_id].box_model.clone();
        let merged_z     = self.faces[&merged_id].z_index;

        let (top, bot, left, right) = match e.orientation {
            Orientation::Horizontal => (
                face_end.top_edge_id, face_start.bottom_edge_id,
                surv_lat_a, surv_lat_b,
            ),
            Orientation::Vertical => (
                surv_lat_a, surv_lat_b,
                face_end.left_edge_id, face_start.right_edge_id,
            ),
        };

        self.faces.remove(&f_end);
        self.faces.remove(&f_start);
        self.faces.insert(merged_id, GridFace {
            id: merged_id,
            top_edge_id:    top,
            bottom_edge_id: bot,
            left_edge_id:   left,
            right_edge_id:  right,
            image: merged_image,
            box_model: merged_box,
            z_index: merged_z,
        });

        Some(merged_id)
    }

    /// Delete `face_id` by merging it with a neighbor through its first interior edge.
    pub fn delete_face(&mut self, face_id: FaceId) -> bool {
        let face = match self.faces.get(&face_id) { Some(f) => f.clone(), None => return false };
        for &eid in &[face.top_edge_id, face.bottom_edge_id, face.left_edge_id, face.right_edge_id] {
            if !self.is_boundary_edge(eid) {
                return self.delete_twin_pair(eid).is_some();
            }
        }
        false
    }

    // -----------------------------------------------------------------------
    // Chain operations
    // -----------------------------------------------------------------------

    /// Find all edges in the connected component at the same offset as `edge_id`.
    pub fn chain_for_edge(&self, edge_id: EdgeId) -> Vec<EdgeId> {
        let Some(e) = self.edges.get(&edge_id) else { return vec![] };
        let orientation = e.orientation.clone();
        let offset = e.offset;

        let mut same: Vec<&Edge> = self.edges.values()
            .filter(|e| e.orientation == orientation && (e.offset - offset).abs() < EPS)
            .collect();
        same.sort_by(|a, b| {
            let (alo, _) = self.edge_extent(a.id).unwrap_or((0.0, 0.0));
            let (blo, _) = self.edge_extent(b.id).unwrap_or((0.0, 0.0));
            alo.partial_cmp(&blo).unwrap_or(std::cmp::Ordering::Equal)
        });
        self.connected_component(&same, edge_id)
    }

    fn connected_component(&self, sorted: &[&Edge], target: EdgeId) -> Vec<EdgeId> {
        let mut cur: Vec<EdgeId> = Vec::new();
        let mut cur_end = f32::NEG_INFINITY;
        for e in sorted {
            let (lo, hi) = self.edge_extent(e.id).unwrap_or((0.0, 0.0));
            if !cur.is_empty() && lo > cur_end + EPS {
                if cur.contains(&target) { return cur; }
                cur.clear();
                cur_end = f32::NEG_INFINITY;
            }
            cur.push(e.id);
            cur_end = cur_end.max(hi);
        }
        if cur.contains(&target) { return cur; }
        vec![]
    }

    /// Rescale all non-boundary interior edges of `axis` so existing faces fit
    /// in the space remaining after a new edge-panel face is added at `boundary`.
    /// - `new_is_first = false`: new face at [boundary, 1]; existing → [0, boundary].
    /// - `new_is_first = true`:  new face at [0, boundary]; existing → [boundary, 1].
    pub fn rescale_interior_edges(&mut self, axis: SplitAxis, boundary: f32, new_is_first: bool) {
        let orientation = match axis {
            SplitAxis::Vertical   => Orientation::Vertical,
            SplitAxis::Horizontal => Orientation::Horizontal,
        };
        for e in self.edges.values_mut() {
            if e.orientation != orientation || e.is_boundary { continue; }
            e.offset = if new_is_first {
                boundary + e.offset * (1.0 - boundary)
            } else {
                e.offset * boundary
            };
        }
    }

    /// Move a chain of edges to `new_offset`.
    ///
    /// Because extents are derived from the linked face rather than stored on
    /// the edge, only the `offset` field needs updating — the adjacent faces'
    /// perpendicular edges automatically reflect the new geometry.
    pub fn move_chain(&mut self, chain: &[EdgeId], new_offset: f32) {
        for &eid in chain {
            if let Some(e) = self.edges.get_mut(&eid) {
                e.offset = new_offset;
            }
        }
    }

    /// Return the (lo, hi) movement bounds for a chain.
    pub fn chain_drag_bounds(&self, chain: &[EdgeId]) -> Option<(f32, f32)> {
        if chain.is_empty() { return None; }
        let mut lo = 0.0_f32;
        let mut hi = 1.0_f32;

        for &eid in chain {
            let e    = self.edges.get(&eid)?;
            let face = self.faces.get(&e.face_id)?;
            match (&e.orientation, &e.facing) {
                (Orientation::Horizontal, Facing::Start) => {
                    hi = hi.min(self.edges.get(&face.bottom_edge_id)?.offset - MIN_FRAC);
                }
                (Orientation::Horizontal, Facing::End) => {
                    lo = lo.max(self.edges.get(&face.top_edge_id)?.offset + MIN_FRAC);
                }
                (Orientation::Vertical, Facing::Start) => {
                    hi = hi.min(self.edges.get(&face.right_edge_id)?.offset - MIN_FRAC);
                }
                (Orientation::Vertical, Facing::End) => {
                    lo = lo.max(self.edges.get(&face.left_edge_id)?.offset + MIN_FRAC);
                }
            }
        }
        if lo > hi { return None; }
        Some((lo, hi))
    }

    // -----------------------------------------------------------------------
    // Snapping
    // -----------------------------------------------------------------------

    /// Snap `value` to the nearest interior edge on `axis`, excluding `chain`.
    pub fn snap(&self, axis: SplitAxis, value: f32, exclude: &[EdgeId], radius: f32) -> f32 {
        let orientation = match axis {
            SplitAxis::Horizontal => Orientation::Horizontal,
            SplitAxis::Vertical   => Orientation::Vertical,
        };
        let mut best = value;
        let mut best_dist = radius;
        for e in self.edges.values() {
            if e.orientation != orientation || e.is_boundary || exclude.contains(&e.id) { continue; }
            let d = (e.offset - value).abs();
            if d < best_dist { best_dist = d; best = e.offset; }
        }
        best
    }

    // -----------------------------------------------------------------------
    // Edge queries
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Pinwheel helpers
    // -----------------------------------------------------------------------

    /// Add a new face with four fresh, twin-less, non-boundary edges at the given
    /// normalised bounds. Returns the new face's ID.
    pub fn add_isolated_face(&mut self, left: f32, right: f32, top: f32, bottom: f32) -> FaceId {
        let face_id  = self.alloc_face();
        let top_id   = self.alloc_edge();
        let bot_id   = self.alloc_edge();
        let left_id  = self.alloc_edge();
        let right_id = self.alloc_edge();

        self.edges.insert(top_id, Edge {
            id: top_id, orientation: Orientation::Horizontal, offset: top,
            facing: Facing::Start, half_gap: 0.0, face_id, is_boundary: false,
        });
        self.edges.insert(bot_id, Edge {
            id: bot_id, orientation: Orientation::Horizontal, offset: bottom,
            facing: Facing::End, half_gap: 0.0, face_id, is_boundary: false,
        });
        self.edges.insert(left_id, Edge {
            id: left_id, orientation: Orientation::Vertical, offset: left,
            facing: Facing::Start, half_gap: 0.0, face_id, is_boundary: false,
        });
        self.edges.insert(right_id, Edge {
            id: right_id, orientation: Orientation::Vertical, offset: right,
            facing: Facing::End, half_gap: 0.0, face_id, is_boundary: false,
        });

        self.faces.insert(face_id, GridFace {
            id: face_id,
            left_edge_id:   left_id,
            top_edge_id:    top_id,
            right_edge_id:  right_id,
            bottom_edge_id: bot_id,
            image:    ImageContent::default(),
            box_model: crate::layout::BoxModel::default(),
            z_index:  0,
        });

        face_id
    }

    /// Find all X-junctions in the layout — points where a vertical chain and a
    /// horizontal chain strictly cross — and return `(vx, hy, tl, tr, bl, br)`.
    pub fn find_xjunctions(&self) -> Vec<(f32, f32, FaceId, FaceId, FaceId, FaceId)> {
        let mut visited: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        let mut v_chains: Vec<(f32, f32, f32)> = Vec::new(); // (x, y_lo, y_hi)
        let mut h_chains: Vec<(f32, f32, f32)> = Vec::new(); // (y, x_lo, x_hi)

        let mut eids: Vec<EdgeId> = self.edges.keys().copied().collect();
        eids.sort_unstable();
        for eid in eids {
            if visited.contains(&eid) { continue; }
            let chain = self.chain_for_edge(eid);
            for &e in &chain { visited.insert(e); }

            let mut clo = f32::INFINITY;
            let mut chi = f32::NEG_INFINITY;
            for &e in &chain {
                if let Some((lo, hi)) = self.edge_extent(e) {
                    clo = clo.min(lo);
                    chi = chi.max(hi);
                }
            }
            let Some(edge) = self.edges.get(&eid) else { continue };
            if edge.is_boundary { continue; }
            match edge.orientation {
                Orientation::Vertical   => v_chains.push((edge.offset, clo, chi)),
                Orientation::Horizontal => h_chains.push((edge.offset, clo, chi)),
            }
        }

        let probe = EPS * 50.0;
        let mut result = Vec::new();
        for &(vx, vy_lo, vy_hi) in &v_chains {
            for &(hy, hx_lo, hx_hi) in &h_chains {
                if vy_lo + EPS < hy && hy < vy_hi - EPS
                   && hx_lo + EPS < vx && vx < hx_hi - EPS
                {
                    let tl = self.face_at(vx - probe, hy - probe);
                    let tr = self.face_at(vx + probe, hy - probe);
                    let bl = self.face_at(vx - probe, hy + probe);
                    let br = self.face_at(vx + probe, hy + probe);
                    if let (Some(tl), Some(tr), Some(bl), Some(br)) = (tl, tr, bl, br) {
                        if tl != tr && tl != bl && tl != br && tr != bl && tr != br && bl != br {
                            result.push((vx, hy, tl, tr, bl, br));
                        }
                    }
                }
            }
        }
        result
    }

    /// Dissolve a pinwheel center face, restoring the layout to a simple
    /// X-junction halfway between the four former center-panel edges.
    /// Returns `true` on success.
    pub fn dissolve_pinwheel_center(&mut self, center_id: FaceId) -> bool {
        let Some((cx1, cy1, cw, ch)) = self.face_rect(center_id) else { return false };
        let cx2 = cx1 + cw;
        let cy2 = cy1 + ch;
        let xv  = (cx1 + cx2) / 2.0;
        let yh  = (cy1 + cy2) / 2.0;

        // Collect all non-center edges whose offset snaps to one of the four arm
        // offsets (cx1/cx2 for V, cy1/cy2 for H). These are the half-chain edges
        // that were repositioned during spawn — move them back to the midpoints.
        const SNAP: f32 = EPS * 100.0;
        let edge_moves: Vec<(EdgeId, f32)> = self.edges.values()
            .filter(|e| e.face_id != center_id)
            .filter_map(|e| {
                let new_off = match e.orientation {
                    Orientation::Vertical => {
                        if (e.offset - cx1).abs() < SNAP || (e.offset - cx2).abs() < SNAP {
                            Some(xv)
                        } else { None }
                    }
                    Orientation::Horizontal => {
                        if (e.offset - cy1).abs() < SNAP || (e.offset - cy2).abs() < SNAP {
                            Some(yh)
                        } else { None }
                    }
                };
                new_off.map(|off| (e.id, off))
            })
            .collect();

        for (eid, off) in edge_moves {
            if let Some(e) = self.edges.get_mut(&eid) { e.offset = off; }
        }

        let center = self.faces.remove(&center_id);
        if let Some(c) = center {
            self.edges.remove(&c.left_edge_id);
            self.edges.remove(&c.right_edge_id);
            self.edges.remove(&c.top_edge_id);
            self.edges.remove(&c.bottom_edge_id);
        }
        true
    }

    pub fn is_boundary_edge(&self, id: EdgeId) -> bool {
        self.edges.get(&id).map(|e| e.is_boundary).unwrap_or(true)
    }

    pub fn contains_edge(&self, id: EdgeId) -> bool {
        self.edges.contains_key(&id)
    }

    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(&id)
    }

    pub fn edge_axis(&self, id: EdgeId) -> Option<SplitAxis> {
        self.edges.get(&id).map(|e| match e.orientation {
            Orientation::Horizontal => SplitAxis::Horizontal,
            Orientation::Vertical   => SplitAxis::Vertical,
        })
    }

    pub fn get_half_gap(&self, id: EdgeId) -> Option<f32> {
        self.edges.get(&id).map(|e| e.half_gap)
    }

    pub fn set_half_gap(&mut self, id: EdgeId, v: f32) {
        if let Some(e) = self.edges.get_mut(&id) { e.half_gap = v; }
    }
}

impl Default for GridLayout {
    fn default() -> Self { GridLayout::new() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_bounds_lo_lt_hi_after_h_split() {
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, SplitAxis::Horizontal).unwrap();

        let interior = layout.edges.values()
            .find(|e| e.orientation == Orientation::Horizontal && !e.is_boundary)
            .map(|e| e.id)
            .unwrap();
        let chain = layout.chain_for_edge(interior);
        let (lo, hi) = layout.chain_drag_bounds(&chain).expect("bounds should exist");
        assert!(lo < hi, "lo={lo} must be < hi={hi}");
        assert!(lo >= MIN_FRAC, "lo must respect top boundary");
        assert!(hi <= 1.0 - MIN_FRAC, "hi must respect bottom boundary");
    }

    #[test]
    fn drag_bounds_lo_lt_hi_after_v_split() {
        let mut layout = GridLayout::new();
        let f0 = *layout.faces.keys().next().unwrap();
        layout.split_face(f0, 0.5, SplitAxis::Vertical).unwrap();

        let interior = layout.edges.values()
            .find(|e| e.orientation == Orientation::Vertical && !e.is_boundary)
            .map(|e| e.id)
            .unwrap();
        let chain = layout.chain_for_edge(interior);
        let (lo, hi) = layout.chain_drag_bounds(&chain).expect("bounds should exist");
        assert!(lo < hi, "lo={lo} must be < hi={hi}");
    }
}
