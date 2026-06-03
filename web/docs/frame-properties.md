# Frame Styling

Select one or more frames to show the styling controls in the right sidebar. These properties affect appearance — they do not change the layout grid.

## Table of Contents

- [Margins](#margins)
- [Borders](#borders)
- [Corner radius](#corner-radius)
- [Layer order (z-order)](#layer-order-z-order)
- [Transforms](#transforms)
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

When two or more frames are selected in a rectangular arrangement, transform buttons appear:

| Button | Action |
|--------|--------|
| Flip Horizontal | Mirror the arrangement left–right |
| Flip Vertical | Mirror the arrangement top–bottom |
| Rotate CW | Rotate the arrangement 90° clockwise |
| Rotate CCW | Rotate the arrangement 90° counter-clockwise |

These operations rearrange the images within the selected frames — they do not move the frames themselves.

## Randomizing values

Every numeric field in the sidebar has a **dice icon** (⚄). Click it to open a randomize dialog where you set a minimum and maximum range. The value is then randomised within that range.

Randomize works on:

- Rotation
- Margins (per side)
- Border widths (per side)
- Corner radius (per corner)

This is useful for creating organic, varied layouts quickly across a multi-frame selection.
