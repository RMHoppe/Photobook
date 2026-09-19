// pod/peecho-catalog.ts — Snapshot of Peecho photobook offerings.
//
// Fetched from GET /rest/v3/offering/list (category BO) on 2026-06-13.
// The catalogue is effectively static reference data; this snapshot lets the
// app show real products, sizes, page limits and pricing without a server
// (the REST API has no CORS, so it cannot be called from the browser).
// Prices are in minor units (euro cents).

export type PeechoCategory = 'layflat' | 'softcover' | 'hardcover';

export interface PeechoOffering {
  id: number;
  category: PeechoCategory;
  name: string;
  widthMm: number;
  heightMm: number;
  minPages: number;
  maxPages: number;
  paperType: string;
  basePriceCents: number;
  perPageCents: number;
  currency: string;
  /** Premium (Mohawk/luxury) variant — de-prioritised when auto-resolving. */
  luxury: boolean;
}

export const PEECHO_OFFERINGS: PeechoOffering[] = [
  { id: 7071422, category: 'layflat', name: "Layflat Photobook A4 (landscape)", widthMm: 297, heightMm: 210, minPages: 18, maxPages: 122, paperType: "Ephoto", basePriceCents: 1295, perPageCents: 40, currency: "EUR", luxury: false },
  { id: 7071423, category: 'layflat', name: "Layflat Photobook (square) (square)", widthMm: 210, heightMm: 210, minPages: 18, maxPages: 122, paperType: "Ephoto", basePriceCents: 1295, perPageCents: 40, currency: "EUR", luxury: false },
  { id: 7071424, category: 'layflat', name: "Layflat Photobook (square Large) (square)", widthMm: 297, heightMm: 297, minPages: 18, maxPages: 122, paperType: "Ephoto", basePriceCents: 1395, perPageCents: 60, currency: "EUR", luxury: false },
  { id: 7071425, category: 'layflat', name: "Layflat Photobook A4 (portrait)", widthMm: 210, heightMm: 297, minPages: 18, maxPages: 122, paperType: "Ephoto", basePriceCents: 1295, perPageCents: 40, currency: "EUR", luxury: false },
  { id: 7071413, category: 'softcover', name: "Softcover luxury book square (210x210mm / 8.3x8.3 inch) (square)", widthMm: 210, heightMm: 210, minPages: 20, maxPages: 300, paperType: "Mohawk", basePriceCents: 585, perPageCents: 25, currency: "EUR", luxury: true },
  { id: 7071414, category: 'softcover', name: "Softcover Photobook A4 (Portrait) (portrait)", widthMm: 210, heightMm: 297, minPages: 20, maxPages: 300, paperType: "Matte", basePriceCents: 420, perPageCents: 16, currency: "EUR", luxury: false },
  { id: 7071415, category: 'softcover', name: "Softcover Photobook A4 (landscape) (landscape)", widthMm: 297, heightMm: 210, minPages: 20, maxPages: 300, paperType: "Matte", basePriceCents: 420, perPageCents: 16, currency: "EUR", luxury: false },
  { id: 7071416, category: 'softcover', name: "Softcover Photobook A5 (Portrait) (portrait)", widthMm: 148, heightMm: 210, minPages: 20, maxPages: 300, paperType: "Matte", basePriceCents: 400, perPageCents: 15, currency: "EUR", luxury: false },
  { id: 7071417, category: 'softcover', name: "Softcover Photobook A5 (landscape) (landscape)", widthMm: 210, heightMm: 148, minPages: 20, maxPages: 300, paperType: "Matte", basePriceCents: 400, perPageCents: 15, currency: "EUR", luxury: false },
  { id: 7071418, category: 'softcover', name: "Softcover Photobook (Square Large)  (square)", widthMm: 294, heightMm: 294, minPages: 24, maxPages: 300, paperType: "Matte", basePriceCents: 699, perPageCents: 28, currency: "EUR", luxury: false },
  { id: 7071419, category: 'softcover', name: "Softcover Photobook (Square)  (square)", widthMm: 210, heightMm: 210, minPages: 20, maxPages: 300, paperType: "Matte", basePriceCents: 420, perPageCents: 16, currency: "EUR", luxury: false },
  { id: 7071420, category: 'softcover', name: "Softcover Luxury book Mohawk A4 (portrait) (portrait)", widthMm: 210, heightMm: 297, minPages: 20, maxPages: 480, paperType: "Mohawk", basePriceCents: 420, perPageCents: 25, currency: "EUR", luxury: true },
  { id: 7071421, category: 'softcover', name: "Softcover Luxury book Mohawk A5 (portrait) (portrait)", widthMm: 148, heightMm: 210, minPages: 20, maxPages: 480, paperType: "Matte", basePriceCents: 400, perPageCents: 20, currency: "EUR", luxury: true },
  { id: 7071395, category: 'hardcover', name: "Hardcover Photobook A5 (portrait)", widthMm: 148, heightMm: 210, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 520, perPageCents: 16, currency: "EUR", luxury: false },
  { id: 7071396, category: 'hardcover', name: "Hardcover Photobook A5 (landscape)", widthMm: 210, heightMm: 148, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 520, perPageCents: 16, currency: "EUR", luxury: false },
  { id: 7071397, category: 'hardcover', name: "Hardcover Photobook A4  (portrait)", widthMm: 210, heightMm: 297, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071398, category: 'hardcover', name: "Hardcover Photobook (Square) (square)", widthMm: 210, heightMm: 210, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071399, category: 'hardcover', name: "Hardcover Photobook A4 (landscape)", widthMm: 297, heightMm: 210, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071400, category: 'hardcover', name: "Hardcover Photobook Letter (portrait)", widthMm: 216, heightMm: 280, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071401, category: 'hardcover', name: "Hardcover Photobook (Square Large) (square)", widthMm: 294, heightMm: 294, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 1245, perPageCents: 25, currency: "EUR", luxury: false },
  { id: 7071402, category: 'hardcover', name: "Hardcover Photobook Letter (landscape)", widthMm: 280, heightMm: 216, minPages: 24, maxPages: 298, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071403, category: 'hardcover', name: "Hardcover Photobook A4 >300 pgs (portrait)", widthMm: 210, heightMm: 297, minPages: 300, maxPages: 504, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071404, category: 'hardcover', name: "Hardcover Photobook A4 >300pgs (landscape)", widthMm: 297, heightMm: 210, minPages: 300, maxPages: 504, paperType: "Gloss", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071405, category: 'hardcover', name: "Hardcover Photobook A5 >300pgs (portrait)", widthMm: 148, heightMm: 210, minPages: 300, maxPages: 504, paperType: "Uncoated", basePriceCents: 520, perPageCents: 16, currency: "EUR", luxury: false },
  { id: 7071406, category: 'hardcover', name: "Hardcover book Letter >300 pgs (landscape)", widthMm: 280, heightMm: 216, minPages: 300, maxPages: 504, paperType: "Matte", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071407, category: 'hardcover', name: "Hardcover Photobook (Square) >300pgs (square)", widthMm: 210, heightMm: 210, minPages: 300, maxPages: 504, paperType: "Matte", basePriceCents: 620, perPageCents: 21, currency: "EUR", luxury: false },
  { id: 7071408, category: 'hardcover', name: "Hardcover Luxury book Mohawk A4 (portrait)", widthMm: 210, heightMm: 297, minPages: 24, maxPages: 480, paperType: "Mohawk", basePriceCents: 620, perPageCents: 25, currency: "EUR", luxury: true },
  { id: 7071409, category: 'hardcover', name: "Hardcover Luxury book Mohawk A4 (landscape)", widthMm: 297, heightMm: 210, minPages: 20, maxPages: 480, paperType: "Mohawk", basePriceCents: 620, perPageCents: 25, currency: "EUR", luxury: true },
  { id: 7071410, category: 'hardcover', name: "Hardcover Luxury book Mohawk A5 (portrait)", widthMm: 148, heightMm: 210, minPages: 20, maxPages: 480, paperType: "Mohawk", basePriceCents: 520, perPageCents: 20, currency: "EUR", luxury: true },
  { id: 7071411, category: 'hardcover', name: "Hardcover Luxury book Mohawk A5 (landscape)", widthMm: 210, heightMm: 148, minPages: 20, maxPages: 480, paperType: "Mohawk", basePriceCents: 520, perPageCents: 20, currency: "EUR", luxury: true },
  { id: 7071412, category: 'hardcover', name: "Hardcover Luxury book Mohawk (Square) (square)", widthMm: 210, heightMm: 210, minPages: 20, maxPages: 480, paperType: "Mohawk", basePriceCents: 620, perPageCents: 25, currency: "EUR", luxury: true },
];

/** Find the standard (non-luxury preferred) offering for a category, page size
 *  and page count. Returns undefined when Peecho offers no match. */
export function findPeechoOffering(
  category: PeechoCategory, widthMm: number, heightMm: number, pages: number,
): PeechoOffering | undefined {
  const matches = PEECHO_OFFERINGS.filter(o =>
    o.category === category && o.widthMm === widthMm && o.heightMm === heightMm
    && pages >= o.minPages && pages <= o.maxPages);
  return matches.find(o => !o.luxury) ?? matches[0];
}

/** All distinct page sizes offered for a category (for size validation/UI). */
export function peechoSizes(category: PeechoCategory): { widthMm: number; heightMm: number }[] {
  const seen = new Set<string>();
  const sizes: { widthMm: number; heightMm: number }[] = [];
  for (const o of PEECHO_OFFERINGS) {
    if (o.category !== category) continue;
    const k = `${o.widthMm}x${o.heightMm}`;
    if (!seen.has(k)) { seen.add(k); sizes.push({ widthMm: o.widthMm, heightMm: o.heightMm }); }
  }
  return sizes;
}
