# Frames & Layout

The canvas is divided into **frames** — the rectangular cells that hold images or sit empty. You create frames by splitting the canvas with dividers, and you reshape them by dragging those dividers.

## Table of Contents

- [What is a frame?](#what-is-a-frame)
- [Splitting frames with the Cut tool](#splitting-frames-with-the-cut-tool)
- [Selecting frames](#selecting-frames)
- [Deleting frames](#deleting-frames)
- [Working with dividers](#working-with-dividers)
- [Dropping images to split](#dropping-images-to-split)

## What is a frame?

A fresh spread starts as a single frame that covers both pages. Every split you make turns one frame into two (or more). Frames are the areas you fill with images — see [Working with Images](images.md) for how to place them.

## Splitting frames with the Cut tool

Press **K** (or click the **Cut** button in the toolbar) to activate the Cut tool. The cursor changes to a crosshair.

1. Move over a frame — a preview line appears showing where the split will land.
2. Click to apply the split.
3. Press **K** again or **Escape** to exit the tool.

**Multi-split:** Scroll the mouse wheel while the Cut tool is active to increase the number of cuts (1–12). The frame is divided into equal-width or equal-height strips.

**Snapping:** The preview line snaps to midpoints and existing dividers automatically. Hold **Alt** to disable snapping and position freely.

**Split orientation:** The split direction (horizontal or vertical) is chosen automatically based on the frame's aspect ratio — wider frames split vertically, taller ones horizontally. Near the centre of a frame the tool offers a four-way quadrant split instead.

## Selecting frames

| Interaction | Result |
|-------------|--------|
| Click a frame | Select it (deselects others) |
| Ctrl/Cmd + Click | Toggle frame in/out of multi-selection |
| Shift + Drag on empty canvas | Marquee — select all frames inside the rectangle |

The right sidebar shows properties for the selected frame(s).

## Deleting frames

Select one or more frames and press **Delete** or **Backspace**. The frame and any image it contains are removed; adjacent frames expand to fill the gap.

## Working with dividers

A **divider** is the boundary line between two frames. You can drag it to resize both frames at once.

### Selecting a divider

Click on any divider line to select it. The right sidebar shows a **Gap** control — the visible spacing between the two frames in millimetres (0–50 mm).

Ctrl/Cmd + Click adds a divider to an existing selection.

### Dragging a divider

Click and drag a divider to reposition it. Both adjacent frames resize in real time. Hold **Alt** to disable snapping while dragging.

### X-junction handles

Where two dividers cross, a small handle appears at each arm. Drag a handle to move only that half of the divider, decoupling it from the other side.

### Pinwheel splits

At a four-way crossing you can drag the junction point itself to grow a new central frame from the corner, creating a five-frame "pinwheel" arrangement.

## Dropping images to split

You can also create new frames by dragging an image from the sidebar and dropping it on the *edge* of an existing frame:

- Drop on the **top or bottom edge** → the frame splits horizontally and the image fills the new half.
- Drop on the **left or right edge** → the frame splits vertically.
- Drop in the **centre** → replaces the existing image without splitting.

Drag **multiple images** at once and drop them onto a frame to automatically split it into a grid — one cell per image.

> See [Working with Images](images.md) and [Adjusting Images](image-adjustments.md) for more on placing and repositioning images.
