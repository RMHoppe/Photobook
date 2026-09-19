// pod/mock-provider.ts — Simulated print-on-demand provider.
//
// Exercises the full ordering pipeline (quote, upload progress, hosted
// checkout, status round-trip) without any network. The fake checkout page
// (pod/mock-checkout.html) writes the payment outcome to localStorage, which
// getOrderStatus reads back — so the order → pay → status-refresh loop is
// real and testable. Replaced by the Peecho adapter in milestone 2 via
// pod/registry.ts.

import type {
  OrderProvider, ProviderProduct, QuoteRequest, Quote,
  OrderRequest, OrderResult, OrderProgress, OrderPhase,
} from './provider.js';

/** localStorage key the fake checkout page writes order outcomes to. */
export const MOCK_ORDERS_KEY = 'photobook-mock-orders';

const PRODUCTS: ProviderProduct[] = [
  {
    id: 'layflat',
    name: 'Layflat photo book',
    options: [
      {
        id: 'paper', label: 'Paper', defaultChoice: 'silk-200',
        choices: [
          { id: 'silk-200',  label: 'Silk 200 g/m²' },
          { id: 'gloss-250', label: 'Glossy 250 g/m²' },
        ],
      },
    ],
  },
  {
    id: 'hardcover',
    name: 'Hardcover photo book',
    options: [
      {
        id: 'paper', label: 'Paper', defaultChoice: 'silk-170',
        choices: [
          { id: 'silk-170',  label: 'Silk 170 g/m²' },
          { id: 'matte-200', label: 'Matte 200 g/m²' },
        ],
      },
      {
        id: 'finish', label: 'Cover finish', defaultChoice: 'matte',
        choices: [
          { id: 'matte', label: 'Matte laminate' },
          { id: 'gloss', label: 'Gloss laminate' },
        ],
      },
    ],
  },
  {
    id: 'softcover',
    name: 'Softcover photo book',
    options: [
      {
        id: 'paper', label: 'Paper', defaultChoice: 'silk-170',
        choices: [
          { id: 'silk-170', label: 'Silk 170 g/m²' },
          { id: 'uncoated-140', label: 'Uncoated 140 g/m²' },
        ],
      },
    ],
  },
];

/** Base price + per-page price in EUR per product (mock formula). */
const PRICING: Record<string, { base: number; perPage: number }> = {
  layflat:   { base: 24.0, perPage: 0.55 },
  hardcover: { base: 18.0, perPage: 0.30 },
  softcover: { base: 9.0,  perPage: 0.25 },
};

/** Option choices that bump the price (exercises quote re-fetch on change). */
const OPTION_SURCHARGE: Record<string, number> = {
  'gloss-250': 4.0,
  'matte-200': 2.5,
  'gloss': 1.5,
};

function delay(msec: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, msec);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export class MockProvider implements OrderProvider {
  readonly id = 'mock';
  readonly name = 'Simulated print shop';
  readonly capabilities = { hostedCheckout: true, directUpload: true, needsFileUrl: false, ordersEnabled: true };

  getProduct(productId: string): ProviderProduct | undefined {
    return PRODUCTS.find(p => p.id === productId);
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    await delay(300); // simulate a pricing endpoint
    const pricing = PRICING[req.productId] ?? { base: 15.0, perPage: 0.4 };
    const lines: Quote['lines'] = [
      { label: 'Base price', amount: pricing.base },
      { label: `${req.pdfPageCount} pages × €${pricing.perPage.toFixed(2)}`, amount: req.pdfPageCount * pricing.perPage },
    ];
    for (const choice of Object.values(req.options)) {
      const surcharge = OPTION_SURCHARGE[choice];
      if (surcharge) lines.push({ label: `Option: ${choice}`, amount: surcharge });
    }
    const total = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    return {
      currency: 'EUR',
      total,
      lines,
      disclaimer: 'Final price including shipping and taxes is shown at checkout.',
    };
  }

  async createOrder(
    req: OrderRequest,
    onProgress: (p: OrderProgress) => void,
    signal: AbortSignal,
  ): Promise<OrderResult> {
    onProgress({ phase: 'creating', message: 'Creating order…' });
    await delay(400, signal);

    // Simulated upload: step the fraction over ~2 s, scaled a little by size.
    const totalBytes = req.files.reduce((a, f) => a + f.bytes.byteLength, 0);
    const steps = 20;
    const stepMs = Math.min(150, 100 + totalBytes / (1024 * 1024));
    for (let i = 1; i <= steps; i++) {
      await delay(stepMs, signal);
      onProgress({ phase: 'uploading', uploadFraction: i / steps, message: 'Uploading PDF…' });
    }

    onProgress({ phase: 'processing', message: 'Processing files…' });
    await delay(500, signal);

    const orderRef = 'mock-' + crypto.randomUUID();
    const quote = await this.quote({ productId: req.productId, pdfPageCount: req.pdfPageCount, widthMm: 0, heightMm: 0, options: req.options });
    const params = new URLSearchParams({
      order: orderRef,
      total: quote.total.toFixed(2),
      currency: quote.currency,
    });
    return { orderRef, checkoutUrl: `pod/mock-checkout.html?${params}` };
  }

  async getOrderStatus(orderRef: string): Promise<OrderPhase | null> {
    try {
      const map = JSON.parse(localStorage.getItem(MOCK_ORDERS_KEY) ?? '{}') as Record<string, string>;
      const s = map[orderRef];
      if (s === 'paid' || s === 'cancelled') return s;
      return 'awaiting-checkout';
    } catch {
      return null;
    }
  }
}
