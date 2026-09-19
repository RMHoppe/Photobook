# Frame Styling

Select one or more frames to show the styling controls in the right sidebar. These properties affect appearance — they do not change the layout grid.

## Table of Contents

- [Margins](#margins)
- [Borders](#borders)
- [Corner radius](#corner-radius)
- [Layer order (z-order)](#layer-order-z-order)
- [Transforms](#transforms)
- [Distributing frames](#distributing-frames)
- [Outer margins tool](#outer-margins-tool)
- [Inner gaps tool](#inner-gaps-tool)
- [Clearing all gaps](#clearing-all-gaps)
- [Randomizing values](#randomizing-values)

## Margins

Margins add inset spacing between the frame boundary and its content (the image). Values are in millimetres.

The four sides (top, right, bottom, left) can be controlled independently or linked:

| Link mode | Behaviour |
|-----------|-----------|
| **All** | One value applies to all four sides |
| **X / Y** | Horizontal pair and vertical pair controlled separately |
| **Paired** | Opposite sides linked (top↔bottom, left↔right) |
| *(unlinked)* | Each side set independently |

Negative margins are supported — useful for intentionally bleeding an image beyond the frame edge.

## Borders

Each side can have a border of its own width (mm) and colour. Toggle each side on or off with the switch next to its width control.

**Border position** controls where the border sits relative to the frame edge:

| Position | Effect |
|----------|--------|
| Inside | Border draws within the content area |
| Centred | Border straddles the edge |
| Outside | Border draws outside the frame |

## Corner radius

Round the corners of a frame with per-corner radius values (mm). The four corners can be linked or set individually, the same way as margins.

## Layer order (z-order)

When frames overlap, layer order determines which one appears on top. Use the controls in the sidebar to adjust:

| Button | Action |
|--------|--------|
| Bring to Front | Move frame above all others |
| Send to Back | Move frame below all others |
| Move Up | Move frame one step up |
| Move Down | Move frame one step down |

The current layer number is shown (e.g., "Layer 3").

## Transforms

The flip and rotate buttons in the canvas toolbar become active in two situations:

**Single frame with an image selected** — the operations act on the *image within the frame*:

| Button | Action |
|--------|--------|
| Flip Horizontal | Mirror the image left–right |
| Flip Vertical | Mirror the image top–bottom |
| Rotate CW | Rotate the image 90° clockwise inside the frame |
| Rotate CCW | Rotate the image 90° counter-clockwise inside the frame |

**Two or more frames selected in a rectangular arrangement** — the operations rearrange the *frames themselves*:

| Button | Action |
|--------|--------|
| Flip Horizontal | Mirror the arrangement left–right |
| Flip Vertical | Mirror the arrangement top–bottom |
| Rotate CW | Rotate the arrangement 90° clockwise |
| Rotate CCW | Rotate the arrangement 90° counter-clockwise |

## Distributing frames

Select two or more frames that form a rectangular arrangement. The **Distribute** buttons in the canvas toolbar become active:

| Button | Action |
|--------|--------|
| Distribute Vertically | Space the frames evenly along the vertical axis |
| Distribute Horizontally | Space the frames evenly along the horizontal axis |

The outermost frames in the selection stay in place; the frames between them are redistributed to equal spacing.

## Outer margins tool

Select one or more frames and click the **Outer Margins** button (border-outer icon) in the canvas toolbar. A floating dialog appears next to the canvas.

Enter a value in mm to apply a uniform inset margin to all selected frames at once. The three mode buttons control which sides are linked:

| Mode | Behaviour |
|------|-----------|
| All | One value for all four sides |
| X / Y | Horizontal and vertical pairs set separately |
| Each | All four sides set independently |

The dialog stays open while you continue working. Click the button again or deselect all frames to close it.

## Inner gaps tool

Select two or more frames and click the **Inner Gaps** button (border-inner icon). A floating dialog lets you set the gap between all shared edges within the selection, in mm:

| Mode | Behaviour |
|------|-----------|
| All | Same gap for horizontal and vertical dividers |
| H / V | Horizontal and vertical gaps set separately |

The dialog stays open while you work. Click the button again or reduce the selection to fewer than two frames to close it.

## Clearing all gaps

Select one or more frames and click the **Clear Gaps** button (border-none icon) to reset all outer margins and inner gaps on those frames to zero in one step.

## Randomizing values

Every numeric field in the sidebar has a **dice icon** (⚄). Click it to open a randomize dialog where you set a minimum and maximum range. The value is then randomised within that range.

Randomize works on:

- Rotation
- Margins (per side)
- Border widths (per side)
- Corner radius (per corner)

This is useful for creating organic, varied layouts quickly across a multi-frame selection.
