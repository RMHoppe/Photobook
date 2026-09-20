# Working with Images

## Table of Contents

- [Opening a folder](#opening-a-folder)
- [Browsing subfolders](#browsing-subfolders)
- [Selecting images](#selecting-images)
- [Placing images](#placing-images)
- [Replacing an image](#replacing-an-image)
- [Dropping on an edge to split](#dropping-on-an-edge-to-split)
- [Dropping multiple images](#dropping-multiple-images)
- [Used image badges](#used-image-badges)
- [Image details for a placed frame](#image-details-for-a-placed-frame)
- [Supported formats](#supported-formats)

## Opening a folder

Click **Open Folder** in the left sidebar and select a folder from your drive. All images in that folder appear as thumbnails. The folder is opened read-only — Photobook never modifies your original files.

## Browsing subfolders

Folders inside your selected directory appear as tiles at the top of the image browser. Click a folder tile to navigate into it. A breadcrumb trail at the top of the sidebar shows your current path; click any segment to jump back to that level.

## Selecting images

Images in the sidebar can be selected independently of placing them on the canvas. This selection is used to show metadata in the right sidebar.

| Interaction | Result |
|-------------|--------|
| Click | Select that image (deselects others) |
| Ctrl/Cmd + Click | Toggle image in/out of multi-selection |
| Shift + Click | Extend selection to this image |

When a single image is selected, the right sidebar shows its name, pixel dimensions, and file size. Capture date, location, and print resolution are shown once the image is placed in a frame — see [Image details for a placed frame](#image-details-for-a-placed-frame).

To drag images onto the canvas, simply click and drag — you do not need to select them first.

## Placing images

Drag a thumbnail from the sidebar and drop it onto a frame on the canvas. The image is scaled to fill the frame while preserving its aspect ratio (cover fit).

## Replacing an image

Drag a new image from the sidebar onto an existing frame. The old image is replaced immediately. The frame dimensions do not change.

## Dropping on an edge to split

Drop an image near the **edge** of a frame instead of the centre to split the frame and place the image in the new half simultaneously:

| Drop zone | Result |
|-----------|--------|
| Centre | Replace existing image |
| Top or bottom edge | Split horizontally, image fills new half |
| Left or right edge | Split vertically, image fills new half |

Edge drop zones are highlighted as you drag over them.

## Dropping multiple images

Select multiple images in the sidebar and drag them all onto a frame at once. The frame is automatically split into a grid — one cell per image — and each image is placed in its own cell.

## Used image badges

Images that have already been placed somewhere in the book show a green checkmark badge in the sidebar. This helps you track which photos are still unused.

## Image details for a placed frame

Select a single frame that contains an image and a details panel appears at the bottom of the right sidebar:

| Row | Meaning |
|-----|---------|
| **Name** | File name of the placed image |
| **Pixels** | Natural pixel size of the image |
| **Taken** / **Modified** | Capture time from the photo's EXIF data; when the file carries no EXIF date, the file's modification time is shown instead |
| **Location** | GPS position from EXIF, if present — click to open it in OpenStreetMap |
| **Print res.** | Effective resolution at the frame's print size; highlighted when it falls below the project's Print DPI |
| **Placement** | Current image scale and rotation inside the frame, when not at defaults |

## Supported formats

| Format | Canvas | PDF export |
|--------|--------|------------|
| JPEG | Yes | Yes |
| PNG | Yes | Yes; transparency rendered on white |
| WebP, GIF, AVIF | Yes (if the browser can decode them) | **No** — the frame is left empty in the exported PDF |

> Convert WebP, GIF, or AVIF photos to JPEG or PNG before placing them in a book you intend to print.
