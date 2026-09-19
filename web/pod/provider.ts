// pod/provider.ts — Print-on-demand provider contract and domain types.
//
// An OrderProvider adapts one print shop's ordering API. Milestone 1 ships a
// mock implementation only; real adapters (Peecho first) plug in behind the
// same interface via pod/registry.ts without UI changes. These types never
// cross the WASM boundary, so they live here rather than in web/types.ts.

export interface ProviderCapabilities {
  /** End customer pays the provider directly on a hosted checkout page
   *  (Peecho model) — no payment handling in the app. */
  hostedCheckout: boolean;
  /** Files upload browser → provider; no publicly reachable file URL needed. */
  directUpload: boolean;
  /** Provider fetches files by URL — requires presigned storage (milestone 3). */
  needsFileUrl: boolean;
  /** Whether `createOrder` can actually place an order yet. False when the
   *  provider's catalog/quotes are live but order submission still needs the
   *  backend proxy (Peecho: the REST API has no CORS). The dialog then shows
   *  real product/price info and an "export & order manually" path instead. */
  ordersEnabled: boolean;
}

export interface ProductOptionDef {
  id: string;                                   // e.g. 'paper'
  label: string;                                // 'Paper type'
  choices: { id: string; label: string }[];
  defaultChoice: string;
}

export interface ProviderProduct {
  /** Provider-side product / SKU id (referenced by PrintShopSpec.order). */
  id: string;
  name: string;
  options: ProductOptionDef[];
}

export interface QuoteRequest {
  productId: string;
  /** Page count as the provider counts it (PDF pages). */
  pdfPageCount: number;
  /** Trim size in mm — needed to resolve a size-specific product/price. */
  widthMm: number;
  heightMm: number;
  /** optionId → choiceId for every product option. */
  options: Record<string, string>;
}

export interface Quote {
  currency: string;                             // ISO code, e.g. 'EUR'
  total: number;                                // major units
  lines: { label: string; amount: number }[];
  /** Shown under the price, e.g. shipping/taxes disclaimer. */
  disclaimer: string;
  /** Set when no price could be produced (e.g. the chosen size/page count is
   *  not offered); the dialog shows this instead of a total. */
  unavailable?: string;
}

export interface OrderFile {
  name: string;
  bytes: Uint8Array;
  /** 'book' = single combined PDF; 'cover'/'body' for split exports. */
  role: 'book' | 'cover' | 'body';
}

export type OrderPhase =
  | 'creating'            // order/publication being registered
  | 'uploading'           // file transfer in progress
  | 'processing'          // provider-side processing after upload
  | 'awaiting-checkout'   // checkoutUrl available, payment pending
  | 'paid'
  | 'failed'
  | 'cancelled';

export interface OrderProgress {
  phase: OrderPhase;
  /** 0..1 while phase === 'uploading'. */
  uploadFraction?: number;
  message?: string;
}

export interface OrderRequest {
  productId: string;
  options: Record<string, string>;
  pdfPageCount: number;
  files: OrderFile[];
}

export interface OrderResult {
  /** Provider-side reference used for status lookups. */
  orderRef: string;
  /** Hosted checkout URL the user completes payment on. */
  checkoutUrl: string;
}

export interface OrderProvider {
  readonly id: string;            // 'peecho', 'mock'
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  getProduct(productId: string): ProviderProduct | undefined;

  /** Estimate the price for the current configuration. */
  quote(req: QuoteRequest): Promise<Quote>;

  /** Create the order and transfer the files. Rejects with a DOMException
   *  named 'AbortError' (or Error('Export cancelled')) when `signal` fires. */
  createOrder(
    req: OrderRequest,
    onProgress: (p: OrderProgress) => void,
    signal: AbortSignal,
  ): Promise<OrderResult>;

  /** Current status of a previously created order, or null when the provider
   *  cannot say (treat the stored status as final). */
  getOrderStatus(orderRef: string): Promise<OrderPhase | null>;
}
