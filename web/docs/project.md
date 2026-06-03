# Project Settings & Saving

## Table of Contents

- [Saving a project](#saving-a-project)
- [Loading a project](#loading-a-project)
- [Re-linking missing images](#re-linking-missing-images)
- [Project Settings](#project-settings)

## Saving a project

Click **Save** in the toolbar. You will be prompted for a filename; the file is saved as `<name>.photobook` to your Downloads folder (or wherever your browser saves files).

The project file stores the complete layout, text, and styling. Images are stored as references to your local files — the actual image data is not bundled into the project file.

> **Tip:** Keep your image folder intact alongside the project file so images are easy to re-link later.

## Loading a project

Click **Load** in the toolbar and select a `.photobook` file. The layout is restored immediately.

If images cannot be found at their original paths, a banner appears asking you to locate the folder. See [Re-linking missing images](#re-linking-missing-images) below.

## Re-linking missing images

When a project is opened and one or more images are not found, a dialog lists the missing files and offers an **Open image folder** button. Select the folder that contains the images — the editor searches it (including subfolders) and matches files by name. A checkmark appears next to each image as it is found.

You can continue with some images still missing — those frames will appear empty. Dismiss the dialog with **Continue**.

## Project Settings

Click the **Project Settings** button (gear icon) in the toolbar to open the settings dialog.

### Page size

Choose from common presets or enter a custom size in millimetres:

| Group | Examples |
|-------|---------|
| Square | 200×200 mm, 250×250 mm, 300×300 mm |
| Portrait | A5, A4, A3, Letter |
| Landscape | A5, A4, A3, Letter |
| Custom | Any width and height from 1–600 mm |

### Print settings

| Setting | Description |
|---------|-------------|
| **Print DPI** | Target resolution for the exported PDF (default 300). A DPI badge on the canvas warns when a placed image is below this threshold at its current size. |
| **Bleed** | Extra area beyond the page edge for full-bleed prints (mm). Toggle its display with **Show Bleed**. |
| **Safe zone** | Inset area to keep text away from the trim edge (mm). Toggle its display with **Show Safe Zone**. |

### Binding / spine

| Setting | Description |
|---------|-------------|
| **Spine width per page** | Added to the inner margin to account for binding thickness |
| **Spine minimum** | Minimum inner margin before pages would overlap |
| **Spine margin step** | Snap increment when adjusting the inner margin |

### Endpapers

Toggle **Endpapers** on or off. When enabled, the first and last spreads become cover / endpaper pages and are styled differently from content spreads. Enabling endpapers requires at least three spreads total.
