# Exporting to PDF

## Table of Contents

- [Starting an export](#starting-an-export)
- [Export progress](#export-progress)
- [Cancelling an export](#cancelling-an-export)
- [PDF output](#pdf-output)
- [Print specifications](#print-specifications)
- [Export options](#export-options)
- [Image resolution warnings](#image-resolution-warnings)

## Starting an export

Click **Export PDF** in the toolbar. The export runs entirely in the browser — no server upload is needed.

## Export progress

A progress bar appears in the toolbar while the PDF is being generated. For large books with many high-resolution images this may take several seconds.

## Cancelling an export

Click the **Cancel** button that appears next to the progress bar to stop the export at any time.

## PDF output

When the export is complete, the browser downloads a `.pdf` file automatically. The filename is `photobook.pdf` — or `photobook-cover.pdf` and `photobook-body.pdf` when **Separate cover PDF** is enabled (see [Export options](#export-options)).

## Print specifications

The exported PDF:

- Conforms to **PDF/X-4** with an embedded **sRGB output intent** — the hand-off format accepted by digital photo printers; no manual CMYK conversion is needed
- Uses the page dimensions set in Project Settings (in mm)
- Sets the **TrimBox** and **BleedBox** so automated print workflows can position and trim pages without crop marks
- Resizes images to the configured print DPI without upscaling
- Converts images with supported embedded RGB or greyscale ICC profiles (including Adobe RGB and Display P3) to sRGB after cropping and resizing, leaving the original files unchanged
- Includes bleed area if configured in Project Settings
- Embeds fonts used in text elements
- Applies corner radius and border styling at pixel level

> For best print quality, use JPEG or PNG images at a minimum of 300 DPI at their intended print size. You can adjust the target DPI in **Project Settings → Print DPI**.

Images without an embedded profile are assumed to be sRGB. Invalid or unsupported profiles retain the decoder's default colours; profile-based CMYK conversion is not supported.

## Export options

The **Export** section in Project Settings controls how the PDF is produced. Check your print shop's specifications to choose the right combination:

- **Separate cover PDF** — exports two files: `photobook-cover.pdf` (the cover spread) and `photobook-body.pdf` (all interior spreads). Most print shops want the cover and the book block as separate files because they are printed on different stock.
- **Interior as single pages** — exports each interior spread as two single pages instead of one wide spread page. Use this for shops that impose pages themselves. Content crossing the gutter automatically provides the bleed on each page's binding edge. With endpapers enabled, the non-printable endpaper halves are skipped, so the file starts with a right-hand page and ends with a left-hand page.
- **Cover as front & back pages** — replaces the wraparound cover spread with two standalone single pages: a **Front Cover** at the start of the book and a **Back Cover** at the end, each edited like a normal page (no spine — the print shop generates it). The export puts the front cover first and the back cover last in the file. Combined with *Interior as single pages* this produces the single-file layout services like Peecho expect. Toggling this option resets the cover's frame layout (background colours and text are carried over), so set it before designing the cover — or use Undo to get the old design back.
- **Crop marks** — off by default. Automated print workflows read the TrimBox instead of marks; enable only if your shop explicitly asks for printed marks.
- **Cover wrap (mm)** — extra material beyond the bleed on every cover edge (the turn-in that wraps around hardcover boards, typically 15–20 mm). Edge frames and background colours automatically extend through the wrap area.
- **Print shop preset** — selecting a preset prefills the settings above with a shop's requirements, enables its preflight rules, and enforces its page-count limits: the book is extended to the shop's minimum page count immediately, and adding or removing spreads beyond the allowed range is blocked.

## Preflight checks

When you click **Export PDF**, the document is checked against the selected print-shop preset (or a default low-resolution rule). If issues are found, a dialog lists them before the export starts:

- **Page count** — too few/too many interior pages, or not a multiple the shop's binding requires (errors — shops reject these).
- **Low resolution** — images that would print below the shop's minimum DPI.
- **Empty frames** — frames without an image.
- **Text in the safe zone** — text close to a trim edge or the spine that may be cut off.

You can cancel to fix the issues, or choose **Export anyway**.

## Image resolution warnings

If a placed image's effective resolution falls below the **Print DPI** setting, a badge appears on that frame in the canvas. Hover over the badge to see the actual DPI. To resolve the warning:

- Use a higher-resolution version of the image, or
- Make the frame smaller so the image is not stretched as much, or
- Lower the Print DPI setting if your printer accepts it.
