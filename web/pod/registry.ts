// pod/registry.ts — Binds provider ids referenced by print-shop specs to
// OrderProvider implementations.
//
// Specs name the real shop ('peecho'); the registry decides which
// implementation backs that id. Milestone 1 binds everything to the
// simulated MockProvider — the order dialog shows a "simulated" notice while
// `isSimulated(provider)` is true. Milestone 2 swaps the 'peecho' binding to
// the real adapter; specs, persistence and UI stay untouched.

import type { PrintShopSpec } from '../types.js';
import type { OrderProvider, ProviderProduct } from './provider.js';
import { MockProvider } from './mock-provider.js';
import { PeechoProvider } from './peecho-provider.js';

const PROVIDERS: Record<string, OrderProvider> = {
  // Real Peecho catalogue + local quotes; order submission gated until the
  // backend proxy lands (capabilities.ordersEnabled === false).
  peecho: new PeechoProvider(),
  // Fully simulated end-to-end provider, kept for tests/demos.
  mock: new MockProvider(),
};

export function getProvider(providerId: string): OrderProvider | undefined {
  return PROVIDERS[providerId];
}

/** True while the binding behind a spec's provider id is the simulation. */
export function isSimulated(provider: OrderProvider): boolean {
  return provider instanceof MockProvider;
}

/** Resolve a spec's ordering target, or null when the spec is download-only
 *  (no `order` ref, unknown provider, or unknown product). */
export function getOrderTarget(spec: PrintShopSpec | undefined):
  { provider: OrderProvider; product: ProviderProduct } | null {
  if (!spec?.order) return null;
  const provider = getProvider(spec.order.providerId);
  const product = provider?.getProduct(spec.order.productId);
  return provider && product ? { provider, product } : null;
}
