# Exporting to PDF

## Table of Contents

- [Starting an export](#starting-an-export)
- [Export progress](#export-progress)
- [Cancelling an export](#cancelling-an-export)
- [PDF output](#pdf-output)
- [Print specifications](#print-specifications)
- [Image resolution warnings](#image-resolution-warnings)

## Starting an export

Click **Export PDF** in the toolbar. The export runs entirely in the browser — no server upload is needed.

## Export progress

A progress bar appears in the toolbar while the PDF is being generated. For large books with many high-resolution images this may take several seconds.

## Cancelling an export

Click the **Cancel** button that appears next to the progress bar to stop the export at any time.

## PDF output

When the export is complete, the browser downloads a `.pdf` file automatically. The filename is `photobook.pdf`.

## Print specifications

The exported PDF:

- Uses the page dimensions set in Project Settings (in mm)
- Embeds all images at their original resolution
- Includes bleed area if configured in Project Settings
- Embeds fonts used in text elements
- Applies corner radius and border styling at pixel level

> For best print quality, use JPEG or PNG images at a minimum of 300 DPI at their intended print size. You can adjust the target DPI in **Project Settings → Print DPI**.

## Image resolution warnings

If a placed image's effective resolution falls below the **Print DPI** setting, a badge appears on that frame in the canvas. Hover over the badge to see the actual DPI. To resolve the warning:

- Use a higher-resolution version of the image, or
- Make the frame smaller so the image is not stretched as much, or
- Lower the Print DPI setting if your printer accepts it.
