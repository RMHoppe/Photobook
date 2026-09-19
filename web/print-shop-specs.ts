// print-shop-specs.ts — Catalog of print-shop spec presets.
//
// Each spec is data, not code: choosing one in Project Settings prefills the
// listed settings, arms its preflight rules before export, and installs its
// page-count rules (enforced when adding/removing spreads). Onboarding a new
// print shop means adding one entry here with the values from their spec sheet.
//
// The peecho-layflat entry is taken from a real spec sheet
// (pod/peecho/File specs - Layflat Book.pdf); the other entries are generic
// starting points to be replaced with real shop specs as shops are onboarded.

import type { PrintShopSpec, PreflightRules } from './types.js';

/** Rules used when no preset is selected: only warn about very low DPI. */
export const DEFAULT_PREFLIGHT_RULES: PreflightRules = {
  min_effective_dpi: 150,
  min_interior_pages: 0,
  max_interior_pages: 0,
  page_count_multiple_of: 0,
  check_gutter: true,
};

export const PRINT_SHOP_SPECS: PrintShopSpec[] = [
  {
    // Source: Peecho "Layflat photo books — File set up guidelines".
    // One PDF of single pages: front cover first, back cover last (Peecho
    // generates the spine, blanks, bleed and cut marks themselves). Content
    // size = book size (no bleed), RGB, 300 dpi, 10 mm safe margin on the
    // outside edges only (layflat — no gutter margin), 18–122 PDF pages.
    // Page 2 of the PDF is the first right-hand book page and the
    // second-to-last page is a left-hand page, which matches the endpapers
    // option, so it is enabled here.
    id: 'peecho-layflat',
    name: 'Peecho — Layflat photo book',
    order: { providerId: 'peecho', productId: 'layflat' },
    settings: {
      page_width_mm: 297,   // A4 landscape; 210×210 and 297×297 are also offered
      page_height_mm: 210,
      bleed_mm: 0,
      safe_zone_mm: 10,
      print_dpi: 300,
      endpapers: true,
      export_crop_marks: false,
      export_split_cover: false,
      export_body_pages: true,
      export_cover_pages: true,
      cover_wrap_mm: 0,
    },
    rules: {
      min_effective_dpi: 200,      // spec asks for 300 dpi; warn below 200
      // Peecho counts PDF pages (18–122). With endpapers on, exported PDF
      // pages = interior pages exactly: the two endpaper blanks that are
      // skipped cancel against the two cover pages.
      min_interior_pages: 18,
      max_interior_pages: 122,
      page_count_multiple_of: 2,
      check_gutter: false,         // layflat: no inner margin required
    },
  },
  {
    // Source: Peecho "Hardcover photo books — File set up guidelines".
    // Same single-file/single-pages/cover-as-front-and-back-pages structure as
    // the layflat, but WITHOUT endpapers: Peecho adds blank inside-cover pages
    // and binding sheets themselves. 24–500 total PDF pages including covers
    // (even number); interior pages = total - 2.
    id: 'peecho-hardcover',
    name: 'Peecho — Hardcover photo book',
    order: { providerId: 'peecho', productId: 'hardcover' },
    settings: {
      page_width_mm: 297,   // A4 landscape; also A5, Letter, 210×210, 294×294
      page_height_mm: 210,
      bleed_mm: 0,
      safe_zone_mm: 10,
      print_dpi: 300,
      endpapers: false,     // Peecho adds binding sheets and inner covers
      export_crop_marks: false,
      export_split_cover: false,
      export_body_pages: true,
      export_cover_pages: true,
      cover_wrap_mm: 0,
    },
    rules: {
      min_effective_dpi: 200,
      // Peecho counts total PDF pages (24–500). Without endpapers, exported
      // pages = interior_page_count + 2 (covers). So interior rules = total - 2.
      min_interior_pages: 22,
      max_interior_pages: 498,
      page_count_multiple_of: 2,
      check_gutter: true,   // bound book: keep content away from spine
    },
  },
  {
    // Source: Peecho "Softcover photo books — File set up guidelines".
    // Same structure as the hardcover preset. 20–300 total PDF pages including
    // covers (even number); interior pages = total - 2.
    id: 'peecho-softcover',
    name: 'Peecho — Softcover photo book',
    order: { providerId: 'peecho', productId: 'softcover' },
    settings: {
      page_width_mm: 297,   // A4 landscape; also A5, A5 portrait, A4 portrait, 210×210
      page_height_mm: 210,
      bleed_mm: 0,
      safe_zone_mm: 10,
      print_dpi: 300,
      endpapers: false,     // Peecho adds blank inside-cover pages
      export_crop_marks: false,
      export_split_cover: false,
      export_body_pages: true,
      export_cover_pages: true,
      cover_wrap_mm: 0,
    },
    rules: {
      min_effective_dpi: 200,
      // Peecho counts total PDF pages (20–300). interior rules = total - 2.
      min_interior_pages: 18,
      max_interior_pages: 298,
      page_count_multiple_of: 2,
      check_gutter: true,
    },
  },
  {
    id: 'generic-digital',
    name: 'Generic digital print (spreads)',
    settings: {
      bleed_mm: 3,
      safe_zone_mm: 5,
      print_dpi: 300,
      export_crop_marks: false,
      export_split_cover: false,
      export_body_pages: false,
      export_cover_pages: false,
      cover_wrap_mm: 0,
    },
    rules: {
      min_effective_dpi: 150,
      min_interior_pages: 0,
      max_interior_pages: 0,
      page_count_multiple_of: 2,
      check_gutter: true,
    },
  },
  {
    id: 'hardcover-layflat',
    name: 'Hardcover layflat (cover + spreads)',
    settings: {
      bleed_mm: 3,
      safe_zone_mm: 8,
      print_dpi: 300,
      export_crop_marks: false,
      export_split_cover: true,
      export_body_pages: false,
      export_cover_pages: false,
      cover_wrap_mm: 15,
    },
    rules: {
      min_effective_dpi: 150,
      min_interior_pages: 8,
      max_interior_pages: 100,
      page_count_multiple_of: 2,
      check_gutter: false,
    },
  },
  {
    id: 'perfect-bound',
    name: 'Perfect-bound (cover + single pages)',
    settings: {
      bleed_mm: 3,
      safe_zone_mm: 10,
      print_dpi: 300,
      export_crop_marks: false,
      export_split_cover: true,
      export_body_pages: true,
      export_cover_pages: false,
      cover_wrap_mm: 0,
    },
    rules: {
      min_effective_dpi: 150,
      min_interior_pages: 24,
      max_interior_pages: 400,
      page_count_multiple_of: 4,
      check_gutter: true,
    },
  },
];

export function getPrintShopSpec(id: string): PrintShopSpec | undefined {
  return PRINT_SHOP_SPECS.find(s => s.id === id);
}
