# Generalised X-Junction Rewire

## Background

The current implementation detects X-junctions with a flat O(n²) geometric scan
(`compute_cross_handles_from_dividers`) and rewires only the exact 3-node
grandparent→parent→leaf quadrant pattern (`rewire_cross_handle`).  This document
describes a replacement that works for any regular-grid depth.

---

## Key Concepts

**Primary divider (P)** — the V-split (or H-split) whose segment is being rewired.
Its full-height (or full-width) divider line is split into two independent segments
by the junction.

**Secondary dividers** — the aligned H-splits (or V-splits) whose divider lines
terminate at P from both sides, forming the cross.  In the simple 2×2 case these
are P's direct children; in deeper grids they may be grandchildren or further.

**Border column / border row** — the column of cells that directly touches P's
divider line.  For a V-primary P at x=X, the border column on the left is the
rightmost column of P's left subtree; on the right it is the leftmost column of
P's right subtree.  These border columns are what the traversal walks.

**Leaf constraint** — a junction is only surfaced as a rewire handle when the two
border-column secondaries each have both children as leaves.  This ensures the four
cells at the four quadrants of the junction are all leaves, making the rewire
unambiguous.

---

## Part 1 — Detection

Detection runs whenever a divider is created or its ratio changes (i.e. on every
`mark_structure_dirty`).  It replaces `compute_cross_handles_from_dividers`.

### 1.1  Find orthogonal ancestors

Given the changed split node `S` (axis = H in the examples below, symmetric for V):

Walk `S`'s ancestor chain using the existing `parent` pointers.  For each V-split
ancestor `P` encountered:

- If `S` is in `P`'s **right** subtree → `P` is a **left ancestor** (P's divider
  forms S's left boundary).
- If `S` is in `P`'s **left** subtree → `P` is a **right ancestor** (P's divider
  forms S's right boundary).

Walk all the way to the root; collect every V-ancestor in both categories.  Each
one is a candidate primary for a separate junction check.

### 1.2  Traverse the border column

For each candidate primary `P` and its side relative to `S`:

**Left ancestor** (S is in P's right subtree) → traverse P's **left** child:

```
fn border_h_splits(tree, node_id) -> Vec<NodeId>:
    match node:
        Leaf        → []
        H-split     → [node_id] + border_h_splits(first_child)
                                 + border_h_splits(second_child)
        V-split     → border_h_splits(right_child)   // go toward P's boundary
```

**Right ancestor** (S is in P's left subtree) → same traversal on P's **right**
child, but take `left_child` at every V-split encountered.

This collects every H-split that spans all the way to P's divider line, at any
depth in the border column.

### 1.3  Alignment check

For each H-split `M` in the collected set: check whether `M`'s resolved y-position
matches `S`'s resolved y-position within `ALIGN_PX` (currently 3 px).

### 1.4  Leaf constraint

Accept the junction only when **both** of the following hold:

- `S`'s two children are both leaves.
- `M`'s two children are both leaves.

### 1.5  Handle emission

For each accepted `(P, M, S)` triple emit four `ResolvedCrossHandle` entries — the
same four types as today:

| kind     | position                              | parent_id  |
|----------|---------------------------------------|------------|
| `rewire` | midpoint of P's segment above y=Y     | P.node_id  |
| `rewire` | midpoint of P's segment below y=Y     | P.node_id  |
| `unlock` | midpoint of M's divider line          | M.node_id  |
| `unlock` | midpoint of S's divider line          | S.node_id  |

`first_child` on the two rewire handles indicates which segment (above / below).
The `drag_axis` is perpendicular to P (horizontal for a V-primary).

No changes to `ResolvedCrossHandle` are required.

---

## Part 2 — Rewire

`rewire_cross_handle(parent_id, first_child, drag_ratio)` is called when the user
drops a rewire handle.  `parent_id` = P.  The function must now handle P whose
children are not necessarily the secondaries.

### 2.1  Collect all secondaries in P's subtree

DFS through every node in P's subtree.  Collect every H-split whose resolved
y-position equals y=Y (the junction y, reconstructed from P + resolved rects).
These are the **aligned secondaries** `[H_1, H_2, …, H_n]`.

### 2.2  Sever secondaries from their H-chains

For each secondary `H_j`:

1. Let `Q = H_j.parent`.
2. **If `Q` is a V-split** (H_j is the root of its column's H-chain — occurs when
   H_j is a direct child of P or of an intermediate V-split): no H-chain parent
   pointer needs updating.  H_j is simply marked freed; its slot in Q is
   unconditionally overwritten in step 2.5 when P's children are rewired.
3. **If `Q` is an H-split** (H_j is mid-chain): determine which slot H_j occupies
   — `Q.first_child == H_j` or `Q.second_child == H_j` — and set that slot to
   `H_j.first_child` (the portion above y=Y).  Update `H_j.first_child.parent = Q`.

> **Note on slot direction.**  In a grid built top-down (each split peels the top
> row off first), H_j is always `Q.second_child`.  The code must not assume this
> however; it should check the slot explicitly so that grids built in any order are
> handled correctly.

After all severances, each H-chain in P's subtree is trimmed at y=Y.  `H_j` is
now a **freed node** whose `first_child` and `second_child` still point to the
cells directly above and below y=Y in that column.

### 2.3  Build the BOTTOM V-skeleton

The BOTTOM subtree must mirror P's V-tree skeleton (same axes, same ratios) but
contain only the cells below y=Y.  The freed H-split nodes are repurposed as
V-splits.

**Correspondence rule:** for each V-split `N` in P's subtree, the freed node used
as the BOTTOM counterpart of `N` is found by following `N`'s `first_child`
direction at every V-split until an H-chain is reached, then taking the freed
secondary in that chain.  This is computed **inline** during the recursion to avoid
any dependency on traversal order.

```
// Follow first_child at every V-split until reaching an H-chain,
// then walk that chain to find the freed (severed) secondary.
fn freed_for_column(tree, chain_root: NodeId) -> NodeId:
    return find_freed_secondary_in_chain(tree, chain_root)

fn leftmost_chain_root(tree, v_node_id) -> NodeId:
    cur = v_node.first_child
    while cur is a V-split:
        cur = cur.first_child
    return cur   // top of the leftmost column's H-chain

fn build_bottom(tree, v_node_id) -> NodeId:
    // Identify and save the freed secondary for the leftmost column *before*
    // any field on it is overwritten — its second_child is the cell below y=Y.
    left_chain  = leftmost_chain_root(tree, v_node_id)
    bot_id      = freed_for_column(tree, left_chain)
    cell_left   = tree.get(bot_id).second_child   // leaf below y=Y in leftmost column

    // Repurpose bot_id as the BOTTOM V-split mirroring v_node.
    bot.kind    = Split { axis: v_node.axis, ratio: v_node.ratio }
    cell_left.parent = bot_id

    // First child: leftmost column's cell or recursive V-subtree.
    fc = v_node.first_child
    bot.first_child = if fc is a V-split:
        build_bottom(tree, fc)
    else:
        cell_left   // already resolved above

    // Second child: rightmost column's cell or recursive V-subtree.
    sc = v_node.second_child
    bot.second_child = if sc is a V-split:
        build_bottom(tree, sc)
    else:
        right_chain = leftmost_chain_root(tree, v_node_id)   // sc itself is the chain root
        // (sc is not a V-split, so it IS the chain root of the second column)
        sec = freed_for_column(tree, sc)
        sec.second_child.parent = bot_id
        sec.second_child

    return bot_id
```

Because each freed node is located by walking P's **existing** tree structure
(unmodified at the time `build_bottom` runs — the only mutations so far are the
parent-pointer updates in step 2.2), no shared list or traversal-order contract is
needed.  The freed node in the **rightmost** column of P's subtree is the only one
not consumed by `build_bottom`; it becomes the new outer H in step 2.5.

### 2.4  Modify the TOP (P repurposed)

P itself is repurposed as the TOP V-split.  Its axis and ratio are preserved.
Its children (ColA, V(2/3), …) remain, but the H-chains within them are already
trimmed (step 2.2).  No structural change to P is needed here.

### 2.5  Wire the new outer H

One freed node (the last one, from the rightmost column of P's subtree) is
repurposed as the new outer H-split:

```
outer.axis  = P.axis.flip()          // V-primary → H outer
outer.ratio = resolved_ratio(y=Y, P's rect)
outer.first_child  = P.node_id       // TOP
outer.second_child = bot_root_id     // BOTTOM
outer.parent = P's original parent
```

Update P's parent to point to `outer` instead of P.  Update P.parent = outer.

### 2.6  Assign drag ratio

Exactly as today:

- `first_child = true`  (upper segment dragged) → TOP_V (P) gets `drag_ratio`.
- `first_child = false` (lower segment dragged) → BOT root gets `drag_ratio`.
- The other side keeps P's original ratio.

The sub-V-splits inside the BOTTOM skeleton keep their ratios from the
corresponding V-splits in TOP (set in step 2.3).

---

## Part 3 — Symmetric Case

Everything above uses a **V-primary / H-secondaries** example.  The H-primary /
V-secondaries case is fully symmetric:

| V-primary term       | H-primary equivalent      |
|----------------------|---------------------------|
| left / right ancestor | top / bottom ancestor    |
| H-split secondaries  | V-split secondaries       |
| border column        | border row                |
| y=Y junction         | x=X junction              |
| go `right_child` in traversal | go `second_child` |
| trim H-chain at y=Y  | trim V-chain at x=X       |

The detection traversal for the H-primary case: when skipping H-splits (the
"spanning" axis) in the border row, take `second_child` (toward the boundary);
collect V-splits encountered.

---

## Part 4 — Changes to Existing Code

### `layout.rs` — `compute_cross_handles_from_dividers`

Replace entirely with a tree-traversal function
`compute_cross_handles_from_tree(tree, root_rect, mm_to_px) -> Vec<ResolvedCrossHandle>`.

It needs resolved positions for the alignment check and for handle placement.  The
simplest approach: resolve all divider rects once (existing `resolve_dividers`),
then run the ancestor-walk + border-column traversal against the tree structure,
using the resolved positions only for the numeric comparisons.

The call site in `resolve_all` stays identical; only the implementation changes.

### `editor_selection.rs` — `rewire_cross_handle`

Replace with the generalised algorithm from Part 2.  Signature unchanged:

```rust
pub fn rewire_cross_handle(&mut self, parent_id: u32, first_child: bool, drag_ratio: f32) -> bool
```

New internal helpers (may live in `bsp.rs` or as free functions):

```rust
fn collect_secondaries(tree: &BspTree, p_id: NodeId, junction_y: f32, root_rect: Rect, mm_to_px: f32) -> Vec<NodeId>
fn sever_secondary(tree: &mut BspTree, secondary_id: NodeId)
fn build_bottom_skeleton(tree: &mut BspTree, v_id: NodeId, freed: &mut Vec<NodeId>) -> NodeId
```

### `editor_selection.rs` — `update_rewired_drag`

Currently resolves the dragged child by `parent + first_child slot`.  After the
rewire, the dragged segment is either P (TOP_V) or the BOTTOM root, both of which
are direct children of the new outer H.  The existing slot-based lookup still works
without change.

### `ResolvedCrossHandle` — no changes needed

`parent_id`, `first_child`, `drag_axis`, `kind`, `x`, `y` are sufficient.

---

## Part 5 — Edge Cases

**P is the tree root** — the new outer H has no parent to update; it simply
becomes the new `tree.root`.

**P has only two columns (existing quadrant)** — degenerates to the current
3-node rotation.  One freed H becomes the outer H, P becomes TOP_V, and the
second freed H becomes the one-node BOTTOM skeleton.  Result is identical to the
existing `rewire_cross_handle`.

**Multiple junctions on the same P** — each junction at a different y=Y is an
independent rewire.  After the first rewire, P is replaced by the new outer H; the
second junction's `parent_id` now points to the outer H (or one of its children),
which is found correctly because we walk the ancestor chain fresh on each detection
pass.

**Secondary is a direct child of P (2×2 case)** — `H_j.parent == P`, which is a
V-split, so step 2.2 takes the "Q is a V-split" branch and makes no H-chain
parent update.  Step 2.5 then unconditionally overwrites P's child pointers when
wiring in the new outer H, so the freed node's former slot in P is cleaned up
there.  No special guard is required; the uniform path handles it correctly.

**Unlock handles** — behaviour unchanged.  `begin_divider_drag_unlocked` on a
secondary creates a drag with empty `locked_ids`, letting that one secondary move
independently.  No code changes needed.
