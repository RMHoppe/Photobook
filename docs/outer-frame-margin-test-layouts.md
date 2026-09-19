# Outer frame margin test layouts

Automated runner: `python3 scripts/test_outer_margins.py` writes an image gallery,
text layouts and JSON results for five complex showcase cases to `target/outer-margin-report/`.
Use `--all` for the exhaustive suite described below. See
[`scripts/README-outer-margins.md`](../scripts/README-outer-margins.md) for coverage and limitations.

Manual test proposal. These are expected behaviors to evaluate, not recorded test results.
Each layout occupies one page, without crossing a spine. Labels identify panels to
multi-select; unselected panels stay present. Restore the baseline before each case.

## 1. Equal 4 × 2 grid: all seven Tetris pieces

Use a 200 × 200 mm page with four equal columns and two equal rows.

```text
+----+----+----+----+
| A  | B  | C  | D  |
+----+----+----+----+
| E  | F  | G  | H  |
+----+----+----+----+
```

`X` means selected; `.` means unselected. The slash separates rows.

| Piece | Selection | Mask | Main check |
| --- | --- | --- | --- |
| I | A B C D | `XXXX / ....` | Rectangular control; three internal seams |
| O | A B E F | `XX.. / XX..` | Rectangular control; central four-way junction |
| T | A B C F | `XXX. / .X..` | Two concave corners adjoining the stem |
| L | A E F G | `X... / XXX.` | One concave corner; long lower arm |
| J | C E F G | `..X. / XXX.` | Mirror of L |
| S | B C E F | `.XX. / XX..` | Two concave corners on opposite sides |
| Z | A B F G | `XX.. / .XX.` | Mirror of S |

Also reflect each mask vertically (swap rows). Translate three-column masks one
column right and move O to the middle and right column pairs. This checks whether
page boundaries and unselected neighbors produce consistent selected-side insets.

For the T case, inspect the bottom of A and C and the left and right of F.
These are exposed sides even though they lie inside the selection's bounding box.
At both notches, the inset outline should turn cleanly: no protruding sliver from B,
overlap, or unexpectedly enlarged internal gap.

## 2. Equal 2 × 4 grid: rotated cases

Rotate the first layout and its selections by 90 degrees:

```text
+----+----+
| E  | A  |
+----+----+
| F  | B  |
+----+----+
| G  | C  |
+----+----+
| H  | D  |
+----+----+
```

Reuse the same selection labels from layout 1. Together with the reflected masks,
this covers every distinct piece orientation. With uniform margins, results should
match a rotated version of layout 1. For directional margins, rotate the values too:
old top → new right, right → bottom, bottom → left, left → top.

## 3. Unequal panels and a partially shared side

On a 200 × 200 mm page, split horizontally at 100 mm. Split the top row at
120 mm and the bottom row at 60 and 120 mm.

```text
+-----------+-------+
|     A     |   B   |
+-----+-----+-------+
|  C  |  D  |   E   |
+-----+-----+-------+
```

| Selection | Main check |
| --- | --- |
| A C D | Rectangular control: A shares its bottom side with two selected panels |
| A C | Concave selection: A's bottom side is partly internal (C) and partly exposed (D) |
| A D | Mirror stress case with a different notch position |
| A B D E | Concave outline around unselected C; unequal panel sizes |

The A C case is particularly useful for deciding the intended behavior. A single
rectangular panel cannot inset only half of its bottom side. Proposed expectation:
allow selected panels and their shared seam to adjust together so the notch has the
requested inset while A–C retains its original gap. Unselected D must stay fixed.
Record the resulting panel sizes as well as the outline; an acceptable outline can
still hide an undesirable redistribution of space.

## 4. Optional 3 × 3 grid: enclosed and disconnected boundaries

```text
+----+----+----+
| A  | B  | C  |
+----+----+----+
| D  | E  | F  |
+----+----+----+
| G  | H  | I  |
+----+----+----+
```

Select A B C D F G H I (a ring) to check an enclosed unselected panel. Proposed
expectation: E remains fixed and all four selected sides facing E receive margins.
Select A B D E for an O control, then A E I for panels touching only at corners:
point contact must not be treated as a shared internal side.

## Procedure and proposed acceptance criteria

Start with zero outer margins, zero borders and corner radii, and zero internal
gaps. Use distinct panel colors or images so overlaps and exposed slivers are visible.
Repeat with 4 mm internal gaps to check that the tool preserves existing spacing.

For each selection:

1. Apply 5 mm on every side, then 10 mm. Inspect every concave corner closely.
2. Restore baseline; apply top 3, right 7, bottom 11, left 5 mm. Direction follows
   the exposed panel side, including sides inside notches.
3. Restore baseline; change only top to 8 mm, leaving other sides unchanged.
4. Compare applying 10 mm directly with a live sequence 5 → 10 → 5 → 10 mm.
   Final geometry should agree. Applying the same value twice should do nothing extra.
5. Undo and redo; close and reopen the tool. Geometry and displayed margin values
   should agree with the state being restored.

Expected behavior to review:

- Margins follow the complete selected outline, including concave notches.
- Existing gaps between selected panels retain their width, including at notches.
  Shared dividers may move to achieve this; selected panel sizes need not stay fixed.
- Unselected panel geometry and styling remain unchanged.
- No overlaps, protruding slivers, inverted panels, or unexpected blank wedges appear.
- Mirroring and rotation produce equivalent geometry when margin directions also transform.
- A 5 mm margin is the selected side's inset from its layout boundary, not necessarily
  the entire visible gap to an unselected neighbor: that neighbor has its own inset.

Record each result as: layout / selection / baseline gap / requested margins /
expected / actual / screenshot / pass or fail. Prioritize T, S, Z, then the A C
partial-side case. I and O establish whether a failure is specific to concavity.

## 5. Ring margins, then pinwheel insertion

Start with layout 4 and select the eight panels around E. Apply 10 mm outer margins
first. Then use the pinwheel tool at E’s original top-right X-junction to create a
clockwise, nominally 30 × 30 mm panel J. Do not reapply margins. The report shows the
original ring, the margin result, and the insertion result separately. Check for
overlap at J and its neighboring panels; insertion may resize E and other panels.
