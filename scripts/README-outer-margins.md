# Outer frame margin regression runner

From the repository root:

```bash
python3 scripts/test_outer_margins.py
open target/outer-margin-report/index.html
```

Requires Python 3 and the project's Rust toolchain/dependencies. The script builds
`outer_margin_probe` from the current source using Cargo offline mode. If dependencies
are not cached yet, run `cargo build -p photobook-core --example outer_margin_probe`
with network access first. No extra Python packages or browser automation are needed.

The default run contains five deliberately chosen complex cases:

| Case | Margins, top/right/bottom/left (mm) | Look for |
| --- | --- | --- |
| T | 3/7/11/5 | Overlap at the two shoulders |
| S | 3/7/11/5 | Errors at opposite concave corners |
| Unequal panels, A B D E selected | 3/7/11/5 | Incorrect outline around the lower-left notch |
| Ring | 10/10/10/10 | Errors around the enclosed center panel |
| Ring, then pinwheel | 10/10/10/10 before insertion | Overlaps caused by inserting a new panel after margins |

All five start with zero gaps. The first four show image pairs. The pinwheel case
shows three stages: original ring, margins applied, then pinwheel inserted. The
clockwise pinwheel is spawned at original center E’s top-right junction, with a
nominal 30 × 30 mm layout cell. It is labeled J and colored green. J does not exist
when the ring margins are applied, and margins are **not reapplied** after insertion.
The center E remains outside the margin selection, but insertion may resize it.
There are no rotations or repeated settings in the default gallery. Red marks panel overlaps, magenta marks missing selected area,
and orange marks selected area outside the expected outline.

Use `--all` for the exhaustive matrix, or `--output /path/to/report` to choose the
output directory. `--quick` is an alias for the default five-case run. Generated files with matching
names are overwritten; unrelated files are retained. Exit status is 0 when all checks
pass, 1 for regression failures. Build or execution errors also return nonzero.

## Output

- `index.html`: before/after gallery and failure descriptions.
- One `.svg` per case: vector images of actual resolved panel geometry at 200 × 200 mm.
- One `.txt` per case: labeled selection map, requested values, before/after coordinates
  in millimeters, and failures.
- `results.json`: complete requests, geometry, checks and statuses for further analysis.

Blue panels are selected, gray panels are unselected, and cream shows uncovered page.
Images are rendered from the core's resolved rectangles; these are not screenshots of
the browser UI. All fixtures are standalone single pages without a spine. Labels in
rotated layouts are assigned in reading order and can differ from the proposal document.

## Coverage and expectations

The runner exercises the same `set_selection_outer_margins_and_adjust` method and
activation snapshots as the toolbar. With `--all`, it covers all seven tetrominoes in every rotation
and translation fitting 4 × 2 or 2 × 4 grids, four unequal-panel selections, and a ring,
O and diagonal selection on a 3 × 3 grid. These run with 0 and 4 mm baseline gaps and:

- uniform 5 and 10 mm margins;
- top/right/bottom/left = 3/7/11/5 mm;
- top-only 8 mm, both from baseline and after an asymmetric setting, leaving other fields unset;
- repeated 10 mm and live 5 → 10 → 5 → 10 mm updates.

The single ring-then-pinwheel case is also included in `--all`, without multiplying
it across the margin variants. Its margin stage runs the normal checks; its insertion
stage checks panel count, nominal size, positive dimensions, overlaps, page bounds,
preservation of the four original junction gaps,
and undo/redo/save/load geometry. The margin outline oracle is not applied after
insertion because the operation deliberately changes the layout.

Automated checks cover positive panel dimensions, overlaps, unchanged unselected
geometry, shared internal gap widths, margin readback, undo/redo and save/load geometry,
and equivalence of direct/repeated/live updates.

For zero-gap cases with all four margin fields set, an independent geometric oracle
compares the actual selected union with the proposed inset of its original outline.
It partitions the geometry into rectangular cells and tests coverage of each point's
margin neighborhood against the original selected union. This catches notches and
holes without reusing the engine's edge classification. Outline discrepancies above
0.1 square mm fail; coordinate comparisons tolerate 0.002 mm for floating-point noise.
Coverage comparisons scale this tolerance by the margin neighborhood perimeter to
avoid treating serialized floating-point seams as missing area.

The oracle deliberately omits nonzero-gap and top-only cases. Those still run the
other checks. A PASS does not verify browser wiring, colors, image crop behavior,
selection restoration, or the aesthetic proportions of resized panels. Review the
images for those judgments. These tests encode the proposed expectations in
`docs/outer-frame-margin-test-layouts.md`. All five showcase cases now pass, including ring margins followed by pinwheel
insertion, as do all 687 cases with `--all`. Native pinwheel regressions also cover
all four center corners, clockwise/counterclockwise insertion, uniform/asymmetric
margins, 0/4 mm initial gaps, repeated previews and cancellation.
