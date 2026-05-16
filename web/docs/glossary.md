# Glossary

Definitions for the terms used throughout the editor and its codebase.

---

## Spread

A **spread** is one double-page unit of the photobook — the canvas you see and edit at any one time. A book is made up of multiple spreads laid out in sequence. Each spread has its own independent layout of faces.

---

## Face

A **face** is a rectangular region of the spread defined by the surrounding dividers. Faces are the output of the layout engine: when you add or move dividers, you are reshaping faces. Each face stores its own visual properties — z-index, margin, gap, background, border, and image placement — and resolves to one frame when rendered.

---

## Frame

A **frame** is a face fully resolved into canvas pixel coordinates, ready for drawing. Resolving a face into a frame applies the face's gap inset and margin to produce two rects: `face_rect` (the gap-inset face boundary, used for selection highlights) and `rect` (the inner content area after margin, used for image and border rendering). A frame also carries the face's image placement data and rotation. The render list returned by `get_render_list()` is a sequence of frames sorted by z-order.

---

## Image

An **image** is a photo or graphic placed into a frame. An image can be panned, scaled, and rotated independently of the frame that contains it. The image is always clipped to the frame boundary.

---

## Divider

A **divider** is the boundary line that separates two or more adjacent faces. Dragging a divider reshapes the faces on either side. A divider carries a **gap** property that controls the visible spacing between the frames it separates.

---

## Segment

A **segment** is one continuous piece of a divider between two consecutive intersection points (vertices). A simple divider with no cross-intersections has a single segment.

---

## Vertex

A **vertex** is a point in the layout grid where two or more segments meet. Vertices are the corners of faces. Every endpoint of a segment is a vertex.

---

## X-junction

An **X-junction** (or cross-junction) is a vertex shared by four segments — two horizontal and two vertical — forming a four-way crossing. Once locked, the two dividers move together when either is dragged. Each of the four divider halves radiating from the junction is called an **arm**; unlock handles sit at the midpoint of each arm, allowing that half to be dragged independently.

---

## Pinwheel

A **pinwheel** is a five-face layout created from an X-junction. Dragging the pinwheel handle at an X-junction grows a central face from the shared corner, surrounding it with four trimmed faces. The name comes from the rotational symmetry of the resulting arrangement.

---

## PSLG (Planar Straight-Line Graph)

The **PSLG** is the internal data structure that represents the layout. It stores all vertices, half-edges, and faces that together describe which faces exist and how they connect. All layout operations — splitting, merging, snapping, and dragging — are mutations of the PSLG.

---

## Half-edge

A **half-edge** is a directed edge in the PSLG. Each segment in the layout is represented by two opposing half-edges, one for each direction. Half-edges allow the layout engine to efficiently traverse face boundaries and determine which faces are adjacent to one another.
