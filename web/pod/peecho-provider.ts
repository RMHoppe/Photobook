// pod/peecho-provider.ts — Peecho provider backed by the static catalogue.
//
// Real products, sizes, page limits and pricing come from peecho-catalog.ts
// (a snapshot of GET /offering/list). Quotes are computed locally from the
// real base + per-page prices, so what the user sees matches Peecho.
//
// `ordersEnabled` is FALSE: Peecho's REST API has no CORS, so order submission
// (and the live spine/quote endpoints) can't run from the browser — that needs
// the backend proxy (see print-shop-roadmap memory). Until then the order
// dialog shows the real product/price and an "export & order manually" path.

import type {
  OrderProvider, ProviderProduct, QuoteRequest, Quote,
  OrderRequest, OrderResult, OrderProgress, OrderPhase,
} from './provider.js';
import type { PeechoCategory } from './peecho-catalog.js';
import { findPeechoOffering } from './peecho-catalog.js';

const CATEGORY_NAMES: Record<PeechoCategory, string> = {
  layflat:   'Layflat photo book',
  softcover: 'Softcover photo book',
  hardcover: 'Hardcover photo book',
};

export class PeechoProvider implements OrderProvider {
  readonly id = 'peecho';
  readonly name = 'Peecho';
  readonly capabilities = {
    hostedCheckout: true,
    directUpload: false,
    needsFileUrl: true,
    ordersEnabled: false, // REST API has no CORS — needs the backend proxy
  };

  getProduct(productId: string): ProviderProduct | undefined {
    if (!(productId in CATEGORY_NAMES)) return undefined;
    // Size and paper are determined by the resolved offering, so no options here.
    return { id: productId, name: CATEGORY_NAMES[productId as PeechoCategory], options: [] };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const offering = findPeechoOffering(
      req.productId as PeechoCategory, req.widthMm, req.heightMm, req.pdfPageCount,
    );
    if (!offering) {
      return {
        currency: 'EUR', total: 0, lines: [],
        disclaimer: '',
        unavailable: `Peecho doesn't offer this ${req.productId} at ${req.widthMm}×${req.heightMm} mm with ${req.pdfPageCount} pages. Adjust the page size or count in Project Settings.`,
      };
    }
    const base = offering.basePriceCents / 100;
    const pages = (offering.perPageCents * req.pdfPageCount) / 100;
    const total = Math.round((base + pages) * 100) / 100;
    return {
      currency: offering.currency,
      total,
      lines: [
        { label: `${offering.name} — base`, amount: base },
        { label: `${req.pdfPageCount} pages × €${(offering.perPageCents / 100).toFixed(2)}`, amount: Math.round(pages * 100) / 100 },
      ],
      disclaimer: `${offering.paperType} paper. Final price including shipping and taxes is shown at Peecho checkout.`,
    };
  }

  // Order submission needs the backend proxy (no CORS); never reached while
  // ordersEnabled is false, but implemented defensively.
  async createOrder(
    _req: OrderRequest,
    _onProgress: (p: OrderProgress) => void,
    _signal: AbortSignal,
  ): Promise<OrderResult> {
    throw new Error('Online ordering with Peecho is not connected yet.');
  }

  async getOrderStatus(_orderRef: string): Promise<OrderPhase | null> {
    return null;
  }
}
