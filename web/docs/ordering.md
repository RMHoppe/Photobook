# Ordering a Printed Book

Besides downloading a print-ready PDF, the editor connects to print-on-demand shops so you can have your book printed and delivered.

> **Peecho — products and prices are live; one-click online ordering is coming.** Selecting a Peecho preset shows the real Peecho product, page-size, page limits and a live price estimate. Direct in-app order submission needs a small server component (the Peecho API can't be called from the browser), so for now the **Order Book** dialog generates the print-ready PDF and you upload it at [peecho.com](https://www.peecho.com) to place the order. The simulated provider used during development still demonstrates the full end-to-end flow.

The shop prints, ships, and handles payment. Your photos and the finished PDF stay on your computer — nothing is stored on our side.

## How to order

1. **Pick a print-on-demand preset** in **Project Settings → Print shop preset** (for example *Peecho — Layflat photo book*). Presets configure the page setup the shop expects and unlock the **Order Book** button in the toolbar. Generic presets are download-only.
2. **Design your book.** The preset enforces the shop's page-count limits while you add or remove spreads.
3. Click **Order Book**. The pre-flight check runs first — unlike a plain export, problems the shop would reject (wrong page count, for example) **block ordering** until fixed. Warnings (low-resolution images, text near the trim) still let you continue.
4. **Review the order**: product, page size, page count, options (paper type, finish), and a live price estimate. The final price including shipping and taxes is always shown at checkout.
5. Click **Generate PDF & upload**. The print-ready PDF is produced and transferred; progress is shown and you can cancel at any time.
6. Click **Open checkout** to complete the order on the print shop's own checkout page — address, shipping, and payment all happen there, directly with the shop.

## Order history

The **Order history** tab in the order dialog lists your orders with their status (*awaiting checkout*, *paid*, *cancelled*). While an order is awaiting checkout you can reopen its checkout page from there — useful if you closed the tab before paying.

Order history is stored **on this device only** (in your browser). It is not part of the project file and is never uploaded.

## Ordering vs. exporting

The **Export PDF** button is unaffected by ordering: it always downloads the print-ready files to your computer, for any preset, so you can order from a print shop of your choice manually.
