# Pinwheel Node — Implementation Plan

## Overview

A pinwheel is a 5-cell layout consisting of a **center** panel and four **outer**
panels (top, right, bottom, left), each outer panel directly bordering the center
on one side.  Four internal **splitter** nodes hold the divider handles.

The primary entry point is a new drag handle that appears at every qualifying
X-junction.  Dragging it converts the 4 existing quadrant cells into the 4 outer
panels of a pinwheel and spawns a new empty center panel.

---

## Open Question

**Drag direction → orientation mapping (derived, please confirm)**

From the geometry, the natural rule is:
- Dragging into the **NE or SW diagonal** from the junction center → **CW**
- Dragging into the **NW or SE diagonal** → **CCW**

The cursor tracks the "far corner" of the growing center cell:
NE drag → cursor = top-right corner of center, junction center pinned as
bottom-left corner; NW drag → cursor = top-left corner, etc.

The derivation: dragging NE means `mx > X_v` and `my < Y_h`, so
`(mx > X_v) == (my < Y_h)` is `true` → CW.  All four diagonal sectors follow
from this single comparison.

---

## 1. Naming Convention

**Content nodes** are named by which side of the center panel they border:
`center`, `top`, `right`, `bottom`, `left`.

**Splitter nodes** are named by which outer boundary their divider hits:
`top-splitter` (divider hits top boundary), `right-splitter` (hits right
boundary), `bottom-splitter` (hits bottom boundary), `left-splitter` (hits left
boundary).

---

## 2. Data Model  (`bsp.rs`)

### 2.1  New `BspKind` variants

```rust
pub enum BspKind {
    Leaf(LeafData),
    Split(SplitData),
    Pinwheel(PinwheelData),                  // new
    PinwheelSplitter(PinwheelSplitterData),  // new
}
```

### 2.2  `PinwheelData`

```rust
pub struct PinwheelData {
    pub orientation: PinwheelOrientation,
    // Where each splitter's divider hits its named outer boundary,
    // as a fraction [0, 1] of the node's width (x_*) or height (y_*).
    pub x_top:    f32,   // top-splitter    → top    boundary at x = x_top    * W
    pub y_right:  f32,   // right-splitter  → right  boundary at y = y_right  * H
    pub x_bottom: f32,   // bottom-splitter → bottom boundary at x = x_bottom * W
    pub y_left:   f32,   // left-splitter   → left   boundary at y = y_left   * H
    // Content panels
    pub center: NodeId,
    pub top:    NodeId,
    pub right:  NodeId,
    pub bottom: NodeId,
    pub left:   NodeId,
    // Internal splitter nodes
    pub top_splitter:    NodeId,
    pub right_splitter:  NodeId,
    pub bottom_splitter: NodeId,
    pub left_splitter:   NodeId,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum PinwheelOrientation { Clockwise, AntiClockwise }
```

**Invariant:** `x_top < x_bottom  ↔  y_right < y_left  ↔  Clockwise`.

Minimum bounds: each of the 5 content panels must be at least 5 % of the
node's width/height (matching the existing `ratio` clamp on `SplitData`).

### 2.3  `PinwheelSplitterData`

Splitter nodes exist so drag handles can reference them by `NodeId`.
Their two content children are derived from the owning pinwheel's orientation
and role; they are **not** stored redundantly here.

```rust
pub struct PinwheelSplitterData {
    pub pinwheel_id: NodeId,
    pub role: PinwheelSplitterRole,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum PinwheelSplitterRole { Top, Right, Bottom, Left }
```

Children of each splitter by orientation:

| Splitter | CW children    | CCW children   |
|----------|----------------|----------------|
| top      | left, top      | top, right     |
| right    | top, right     | right, bottom  |
| bottom   | right, bottom  | left, bottom   |
| left     | bottom, left   | top, left      |

Each splitter always keeps its **namesake** panel as one child across both
orientations; only the other child swaps on a flip.

### 2.4  Parent pointers

All 9 child nodes of a pinwheel (5 content + 4 splitters) have
`parent = pinwheel_node_id`.  The pinwheel node's own parent is whatever node
contained the original X-junction root (or `None` if root).

`BoxModel.gap` is ignored on `PinwheelSplitter` nodes — geometry is owned
entirely by the parent `Pinwheel`.

---

## 3. Geometry  (`layout.rs`)

Given the pinwheel's resolved rect `[L, R] × [T, B]`, `W = R−L`, `H = B−T`:

```
cx1 = L + min(x_top, x_bottom) * W
cx2 = L + max(x_top, x_bottom) * W
cy1 = T + min(y_right, y_left) * H
cy2 = T + max(y_right, y_left) * H
```

### Cell rects

**CW** (`x_top < x_bottom`, `y_right < y_left`):

```
center = [cx1, cx2] × [cy1, cy2]
top    = [cx1,  R ] × [ T,  cy1]
right  = [cx2,  R ] × [cy1,  B ]
bottom = [ L,  cx2] × [cy2,  B ]
left   = [ L,  cx1] × [ T,  cy2]
```

**CCW** (`x_top > x_bottom`, `y_right > y_left`):

```
center = [cx1, cx2] × [cy1, cy2]   (same rect)
top    = [ L,  cx2] × [ T,  cy1]
right  = [cx2,  R ] × [ T,  cy2]
bottom = [cx1,  R ] × [cy2,  B ]
left   = [ L,  cx1] × [cy1,  B ]
```

### Divider segments  (`ResolvedDivider` output)

Each splitter's divider is a partial-span segment from the center panel edge to
the outer boundary:

| Splitter | CW segment                                | CCW segment                               |
|----------|-------------------------------------------|-------------------------------------------|
| top      | vertical,   x = cx1, from T  to cy1      | vertical,   x = cx2, from T  to cy2      |
| right    | horizontal, y = cy1, from cx2 to R       | horizontal, y = cy2, from cx2 to R       |
| bottom   | vertical,   x = cx2, from cy2 to B       | vertical,   x = cx1, from cy1 to B       |
| left     | horizontal, y = cy2, from L  to cx1      | horizontal, y = cy1, from L  to cx1      |

These are emitted into `ResolvedSpread.dividers` with the splitter's `NodeId`,
so the existing `HitTester.hit_divider` path picks them up without modification.

---

## 4. X-Junction → Pinwheel Conversion  (`editor_pinwheel.rs`)

### 4.1  Qualifying junctions

The spawn handle appears on X-junctions that satisfy the existing **leaf
constraint** (§1.4 of `general-xjunction-rewire.md`): both aligned secondaries
have both children as leaves.  This restricts the handle to simple 2×2
four-quadrant configurations.

The spawn handle is a new `kind` value (`"pinwheel_spawn"`) in
`ResolvedCrossHandle`, emitted at the geometric center `(X_v, Y_h)` of the
junction alongside the existing `"rewire"` and `"unlock"` handles.
`parent_id` is the V-primary P; `first_child` is unused; `drag_axis` is
`SplitAxis::Vertical` (the spawn drag is 2-D, but this field satisfies the
existing struct).

### 4.2  Orientation from drag direction

```rust
// junction_x, junction_y: absolute px position of the X-junction centre
// mx, my: current cursor position
let cw = (mx > junction_x) == (my < junction_y);
//   NE quadrant (mx > jx, my < jy): cw = true  → Clockwise
//   SW quadrant (mx < jx, my > jy): cw = true  → Clockwise
//   NW quadrant (mx < jx, my < jy): cw = false → AntiClockwise
//   SE quadrant (mx > jx, my > jy): cw = false → AntiClockwise
```

Center cell rectangle (always the bounding box of junction point + cursor):

```rust
let cx1 = junction_x.min(mx);   let cx2 = junction_x.max(mx);
let cy1 = junction_y.min(my);   let cy2 = junction_y.max(my);
```

Convert to fractional parameters given the pinwheel node's resolved rect
`[L, R] × [T, B]`:

```rust
// CW:
x_top    = (cx1 - L) / W;   x_bottom = (cx2 - L) / W;
y_right  = (cy1 - T) / H;   y_left   = (cy2 - T) / H;
// CCW (swap assignments so the invariant x_top > x_bottom holds):
x_top    = (cx2 - L) / W;   x_bottom = (cx1 - L) / W;
y_right  = (cy2 - T) / H;   y_left   = (cy1 - T) / H;
```

### 4.3  Node repurposing

Starting structure: P (V-split), M = P.first\_child (left H-split),
S = P.second\_child (right H-split), four leaf quadrants:

```
TL = M.first_child    TR = S.first_child
BL = M.second_child   BR = S.second_child
```

Repurposing (independent of orientation):

| Old node   | New role        | Rationale                                           |
|------------|-----------------|-----------------------------------------------------|
| P          | Pinwheel node   | Preserves P's NodeId and its slot in the wider tree |
| M          | left-splitter   | M's children are always the left-splitter's pair    |
| S          | right-splitter  | S's children are always the right-splitter's pair   |
| *(allocate)* | top-splitter  | 3 new nodes required                                |
| *(allocate)* | bottom-splitter |                                                   |
| *(allocate)* | center leaf   |                                                   |

Panel assignment by orientation:

| Quadrant | CW panel | CCW panel |
|----------|----------|-----------|
| TL       | left     | top       |
| TR       | top      | right     |
| BR       | right    | bottom    |
| BL       | bottom   | left      |

### 4.4  Conversion algorithm

```
fn spawn_pinwheel(tree, p_id, orientation, x_top, y_right, x_bottom, y_left):
    // 1. Read existing nodes
    (m_id, s_id) = P's split children
    (tl_id, bl_id) = M's split children   // first = TL, second = BL
    (tr_id, br_id) = S's split children   // first = TR, second = BR

    // 2. Allocate new nodes (parent = p_id for all)
    top_spl_id = alloc PinwheelSplitter { pinwheel_id: p_id, role: Top }
    bot_spl_id = alloc PinwheelSplitter { pinwheel_id: p_id, role: Bottom }
    center_id  = alloc Leaf(default), parent = p_id

    // 3. Repurpose M and S
    M.kind = PinwheelSplitter { pinwheel_id: p_id, role: Left }
    S.kind = PinwheelSplitter { pinwheel_id: p_id, role: Right }

    // 4. Panel assignment
    (top, right, bottom, left) = if CW:
        (tr_id, br_id, bl_id, tl_id)
    else:
        (tl_id, tr_id, br_id, bl_id)

    // 5. Update parent pointers for all 9 children
    for id in [center_id, top, right, bottom, left,
               top_spl_id, m_id, bot_spl_id, s_id]:
        tree[id].parent = p_id

    // 6. Repurpose P → Pinwheel
    P.kind = Pinwheel {
        orientation,
        x_top, y_right, x_bottom, y_left,
        center: center_id,
        top, right, bottom, left,
        top_splitter:    top_spl_id,
        right_splitter:  s_id,
        bottom_splitter: bot_spl_id,
        left_splitter:   m_id,
    }
```

---

## 5. Drag Interaction  (`interaction.rs` + `editor_pinwheel.rs`)

### 5.1  Spawn drag

On grabbing a `"pinwheel_spawn"` handle:

1. Convert immediately (step 4.4) with the junction point as both corners of the
   center cell (zero-size center, all 4 params equal to the junction fraction).
   The tree is now a live Pinwheel node.
2. Enter drag state:

```rust
pub struct DragPinwheelSpawn {
    pub pinwheel_id: NodeId,
    pub junction_x:  f32,   // abs px
    pub junction_y:  f32,
}
```

3. On each mouse-move: recompute `(orientation, x_top, y_right, x_bottom, y_left)`
   from cursor position (§4.2), clamp each param so every panel is ≥ 5 % of its
   axis, write back into `PinwheelData`.  If orientation changed, also swap the
   non-namesake child in all 4 splitters.
4. On mouse-up: finalise.  The entire spawn drag is **one undo step**.
5. On Escape or if the cursor never moves beyond a small threshold (~4 px):
   revert via `dissolve_pinwheel_to_xjunction` (§6.1).

### 5.2  Pinwheel splitter drag

`HitTester.hit_divider` already picks up the splitter's `ResolvedDivider` by
node ID.  The existing `DragState` struct (`node_id`, `axis`, `locked_ids`) can
be reused with `locked_ids = []`.

On each mouse-move, determine which parameter the splitter controls and update
the parent pinwheel:

| Splitter role | Drag axis  | Parameter updated |
|---------------|------------|-------------------|
| top           | horizontal | `x_top`           |
| right         | vertical   | `y_right`         |
| bottom        | horizontal | `x_bottom`        |
| left          | vertical   | `y_left`          |

**Orientation flip** — when the dragged parameter crosses its opposing parameter
(`y_right` crosses `y_left`, or `x_top` crosses `x_bottom`):

1. Flip `PinwheelData.orientation`.
2. For every splitter, swap its non-namesake child (see §2.3 table).
3. Continue the drag; the same splitter node now controls the parameter on the
   other side of the flip.

Both crossing conditions (`y_right`/`y_left` and `x_top`/`x_bottom`) flip the
same single orientation bit atomically; they cannot disagree because the flip
always swaps both pairs simultaneously.

---

## 6. Dissolution Operations  (`editor_pinwheel.rs`)

### 6.1  Center deleted → X-junction

Triggered when the user deletes the center panel.

1. Read panel NodeIds from `PinwheelData`:
   - `(tl, bl, tr, br)` = inverse of the §4.3 assignment table.
2. Compute the X-junction split position:
   - V-ratio: `(cx1 + cx2) / (2 * W)` (midpoint of center, normalised).
   - H-ratio: `(cy1 + cy2) / (2 * H)`.
3. Repurpose P → V-split at the V-ratio.
4. Repurpose M (left-splitter) → H-split at the H-ratio, children `(tl, bl)`.
5. Repurpose S (right-splitter) → H-split at the H-ratio, children `(tr, br)`.
6. Restore `tl/bl/tr/br` parent pointers to M/S.
7. Free top-splitter, bottom-splitter, center leaf.

Result is a standard 4-cell BSP X-junction identical in structure to the
original.

### 6.2  Outer panel deleted → collapse to 4-cell BSP

"Deleting" an outer panel collapses its center-cell edge to the outer boundary
and converts the 4-cell result back to a regular BSP sub-tree (3 splits + 4
leaves).  The resulting trees are always valid sliceable BSP representations.

| Deleted panel | CW: edge collapsed | CCW: edge collapsed |
|---------------|--------------------|---------------------|
| top           | `y_right → 0`      | `y_left → 0`        |
| right         | `x_bottom → 1`     | `x_top → 1`         |
| bottom        | `y_left → 1`       | `y_right → 1`       |
| left          | `x_top → 0`        | `x_bottom → 0`      |

After collapsing, two of the four splitter dividers degenerate (zero length).
Build the equivalent BSP sub-tree using the 3 remaining non-degenerate split
positions, free the degenerate splitter nodes and the deleted panel, and replace
P in the wider tree with the new BSP sub-root.

**Non-leaf outer panel:** deletion is disallowed.  The user must first collapse
the sub-tree inside the panel before deleting it from the pinwheel.

---

## 7. Updates to Existing Systems

### `bsp.rs` — traversals

All `BspKind` matches need new arms:

| Method | Pinwheel arm | PinwheelSplitter arm |
|--------|-------------|----------------------|
| `collect_leaves` | Recurse into all 5 content nodes only; skip splitters | No-op — leaves are visited via the Pinwheel arm |
| `descendants` | Yield all 9 children + their descendants | Yield no children (structure owned by pinwheel) |
| `ancestors` | Unchanged — parent pointers are single and canonical | same |
| `sibling` | For a content node: the CW-adjacent outer panel (derive from orientation) | None — splitters have no sibling |
| `delete_leaf` | If `node.parent` is a Pinwheel, dispatch to §6.1/6.2 | — |
| `navigate` | Add `"cw_next"` / `"ccw_prev"` directions for pinwheel panels | — |

### `layout.rs` — resolver

- **`resolve_all` / `LayoutResolver`**: add a `Pinwheel` arm that computes
  the 5 content rects (§3) and emits 4 `ResolvedDivider` entries (§3) plus
  recurses into the 5 content subtrees.  `PinwheelSplitter` arm: no-op.
- **X-junction detection** (`compute_cross_handles_from_tree`): after emitting
  `"rewire"` and `"unlock"` handles for a qualifying junction, additionally
  emit a `"pinwheel_spawn"` handle at `(X_v, Y_h)` with `parent_id = p_id`.

### `interaction.rs`

- Extend `DragState` with a `PinwheelSpawn` variant (§5.1), or add a parallel
  `DragPinwheelSpawn` state alongside the existing `DragState`.
- `HitTester.hit_divider` requires no changes — pinwheel splitter segments are
  regular `ResolvedDivider` entries with the splitter's `NodeId`.

### Frontend  (`web/canvas.{js,ts}`, `web/interaction.{js,ts}`)

- **Rendering:** resolved leaves from pinwheel content nodes flow through the
  existing draw pipeline unchanged.  Splitter divider segments are drawn as
  partial-span lines (not full-width/height) using the same divider style.
- **Hit testing:** the pinwheel node's bounding rect is fully covered by its 5
  content cell rects; click dispatch reaches a content cell naturally.
- **Spawn handle:** render as a distinct icon at the junction centre (distinct
  from the existing rewire/unlock handles).  During the drag, render the growing
  center cell as a live overlay.
- **Splitter drag handles:** short line-segment affordances overlaid on each of
  the 4 internal divider segments; draggable along their perpendicular axis.

---

## 8. Implementation Order

| Step | File(s) | Work |
|------|---------|------|
| 1 | `bsp.rs` | Add `PinwheelData`, `PinwheelSplitterData`, `PinwheelOrientation`; new `BspKind` variants with stub `match` arms everywhere |
| 2 | `layout.rs` | `layout_pinwheel` geometry (§3); emit `ResolvedDivider` for splitters; update `resolve_all` |
| 3 | `bsp.rs` | Complete `leaves`, `descendants`, `sibling`, `delete_leaf`, `navigate` arms |
| 4 | `editor_pinwheel.rs` | `spawn_pinwheel` (§4.4) and `dissolve_pinwheel_to_xjunction` (§6.1) |
| 5 | `layout.rs` | Emit `"pinwheel_spawn"` handle from X-junction detection |
| 6 | `interaction.rs` | `DragPinwheelSpawn` state; connect mouse-move to `update_pinwheel_spawn` |
| 7 | Frontend | Render pinwheel cells and spawn handle; wire spawn drag |
| 8 | `editor_pinwheel.rs` | `drag_pinwheel_splitter` with orientation-flip logic (§5.2) |
| 9 | Frontend | Render splitter handles; wire splitter drag |
| 10 | `editor_pinwheel.rs` | `delete_pinwheel_panel` (§6.2) |
| 11 | All | Verify all operations are single undo snapshots; serialization round-trip test |
