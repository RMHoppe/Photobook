// pod/page-count.ts — Estimate the exported PDF page count for ordering.
//
// Providers quote by PDF page count, which depends on the export structure:
// interior pages = content spreads × 2; in cover-as-pages mode the front and
// back cover are extra single pages, while enabled endpapers remove the two
// non-printable blanks from the file. This mirrors the arithmetic documented
// on the Peecho presets in print-shop-specs.ts.

import type { ProjectSettingsData, SpreadSummary } from '../types.js';

export function estimatePdfPageCount(
  settings: Pick<ProjectSettingsData, 'export_cover_pages' | 'export_body_pages' | 'endpapers'>,
  spreads: SpreadSummary[],
): number {
  const interior = spreads.filter(s => s.kind === 'content').length * 2;
  if (!settings.export_body_pages) {
    // Spread-per-page exports: providers in this mode count spreads.
    return spreads.length;
  }
  let pages = interior;
  if (settings.endpapers) pages -= 2;          // endpaper blanks are skipped
  if (settings.export_cover_pages) pages += 2; // front + back cover pages
  return Math.max(0, pages);
}
