// pod/order-dialog.ts — The "Order Book" dialog: product summary, live quote,
// PDF generation + upload progress, hosted-checkout handoff, and order history.
//
// Provider-agnostic: everything provider-specific comes through the
// OrderProvider resolved from the spec via pod/registry.ts. While the
// registry binds the simulated provider, a visible notice says so.

import type { PhotobookEditor } from '../pkg/photobook_core.js';
import type { PrintShopSpec, ProjectSettingsData } from '../types.js';
import { getSpreadsInfo, getPageSizeMm } from '../wasm-bridge.js';
import { generatePdfs, type BufferSource } from '../export.js';
import { showToast } from '../toast.js';
import { readPodOrders, upsertPodOrder, type PodOrderRecord } from '../persist.js';
import type { OrderProvider, ProviderProduct, Quote, OrderPhase } from './provider.js';
import { getOrderTarget, getProvider, isSimulated } from './registry.js';
import { estimatePdfPageCount } from './page-count.js';

type View = 'configure' | 'working' | 'checkout' | 'exported' | 'error';

const TERMINAL_PHASES: ReadonlySet<string> = new Set(['paid', 'failed', 'cancelled']);

export interface OrderDialogDeps {
  editor: PhotobookEditor;
  getBuffers: BufferSource;
  getSettings: () => ProjectSettingsData;
  getProjectName: () => string;
  /** Called while an order is generating so the export button can be disabled. */
  onBusyChange?: (busy: boolean) => void;
}

export class OrderDialog {
  private deps: OrderDialogDeps;
  private dialog: HTMLDialogElement;

  private spec: PrintShopSpec | null = null;
  private provider: OrderProvider | null = null;
  private product: ProviderProduct | null = null;
  private options: Record<string, string> = {};
  private pdfPageCount = 0;
  private quote: Quote | null = null;
  private view: View = 'configure';
  private errorMessage = '';
  private lastOrder: PodOrderRecord | null = null;
  private abort: AbortController | null = null;
  private _quoteTimer: number | undefined;
  private _quoteSeq = 0;

  constructor(deps: OrderDialogDeps) {
    this.deps = deps;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'confirm-dialog order-dialog';
    this.dialog.innerHTML = `
      <div class="od-tabs">
        <button class="od-tab od-tab-active" data-tab="new">New order</button>
        <button class="od-tab" data-tab="history">Order history</button>
        <button class="od-close docs-close" title="Close">&#x2715;</button>
      </div>
      <div class="od-body" id="od-new"></div>
      <div class="od-body" id="od-history" hidden></div>
    `;
    document.body.appendChild(this.dialog);

    this.dialog.querySelector('.od-close')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', (e) => {
      // Esc during an active order run: cancel the run, keep the dialog open.
      if (this.view === 'working') { e.preventDefault(); this.abort?.abort(); }
    });
    for (const tab of this.dialog.querySelectorAll<HTMLButtonElement>('.od-tab')) {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab as 'new' | 'history'));
    }
  }

  open(spec: PrintShopSpec): void {
    const target = getOrderTarget(spec);
    if (!target) return;
    this.spec = spec;
    this.provider = target.provider;
    this.product = target.product;
    this.options = Object.fromEntries(target.product.options.map(o => [o.id, o.defaultChoice]));
    this.pdfPageCount = estimatePdfPageCount(this.deps.getSettings(), getSpreadsInfo(this.deps.editor));
    this.quote = null;
    this.view = 'configure';
    this._switchTab('new');
    this._renderNew();
    this._scheduleQuote(0);
    this.dialog.showModal();
  }

  close(): void {
    this.abort?.abort();
    this.dialog.close();
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  private _switchTab(tab: 'new' | 'history'): void {
    for (const t of this.dialog.querySelectorAll<HTMLButtonElement>('.od-tab')) {
      t.classList.toggle('od-tab-active', t.dataset.tab === tab);
    }
    this.dialog.querySelector<HTMLElement>('#od-new')!.hidden = tab !== 'new';
    this.dialog.querySelector<HTMLElement>('#od-history')!.hidden = tab !== 'history';
    if (tab === 'history') void this._renderHistory();
  }

  // -------------------------------------------------------------------------
  // New-order view
  // -------------------------------------------------------------------------

  private _renderNew(): void {
    const el = this.dialog.querySelector<HTMLElement>('#od-new')!;
    if (!this.spec || !this.provider || !this.product) { el.innerHTML = ''; return; }

    if (this.view === 'configure') {
      const page = getPageSizeMm(this.deps.editor);
      const ordersEnabled = this.provider.capabilities.ordersEnabled;
      const notice = isSimulated(this.provider)
        ? '<p class="od-sim-note">Simulated provider — no real order will be placed.</p>'
        : !ordersEnabled
          ? `<p class="od-sim-note">Online ordering with ${this.provider.name} isn't connected yet. Generate the print-ready PDF below, then upload it at <a href="https://www.peecho.com" target="_blank" rel="noopener">peecho.com</a> to place your order.</p>`
          : '';
      const primaryLabel = ordersEnabled ? 'Generate PDF &amp; upload' : 'Export PDF for upload';
      el.innerHTML = `
        ${notice}
        <h3 class="od-product">${this.product.name}</h3>
        <table class="od-summary">
          <tr><td>Preset</td><td>${this.spec.name}</td></tr>
          <tr><td>Page size</td><td>${page.width_mm} × ${page.height_mm} mm</td></tr>
          <tr><td>PDF pages</td><td id="od-pages">${this.pdfPageCount}</td></tr>
        </table>
        <div class="od-options">
          ${this.product.options.map(o => `
            <label class="od-option">
              <span>${o.label}</span>
              <select data-option="${o.id}">
                ${o.choices.map(c => `<option value="${c.id}" ${c.id === this.options[o.id] ? 'selected' : ''}>${c.label}</option>`).join('')}
              </select>
            </label>`).join('')}
        </div>
        <div class="od-quote" id="od-quote"><p class="od-quote-loading">Estimating price…</p></div>
        <div class="confirm-dialog-actions">
          <button id="od-cancel">Cancel</button>
          <button id="od-start" class="btn-confirm">${primaryLabel}</button>
        </div>
      `;
      for (const sel of el.querySelectorAll<HTMLSelectElement>('select[data-option]')) {
        sel.addEventListener('change', () => {
          this.options[sel.dataset.option!] = sel.value;
          this._scheduleQuote(250);
        });
      }
      el.querySelector('#od-cancel')!.addEventListener('click', () => this.close());
      el.querySelector('#od-start')!.addEventListener('click', () => {
        void (ordersEnabled ? this._runOrder() : this._runExport());
      });
      this._renderQuote();
      return;
    }

    if (this.view === 'working') {
      el.innerHTML = `
        <h3 class="od-product">${this.product.name}</h3>
        <p id="od-phase">Preparing…</p>
        <div class="export-progress od-progress"><div class="export-progress-bar" id="od-bar"></div></div>
        <div class="confirm-dialog-actions">
          <button id="od-abort">Cancel</button>
        </div>
      `;
      el.querySelector('#od-abort')!.addEventListener('click', () => this.abort?.abort());
      return;
    }

    if (this.view === 'checkout') {
      el.innerHTML = `
        <h3 class="od-product">Your book is ready to order</h3>
        <p>The PDF was uploaded. Complete your order and payment on the print shop's checkout page.</p>
        <p class="od-hint">You can reopen this checkout later from <strong>Order history</strong>.</p>
        <div class="confirm-dialog-actions">
          <button id="od-done">Close</button>
          <button id="od-checkout" class="btn-confirm">Open checkout</button>
        </div>
      `;
      el.querySelector('#od-done')!.addEventListener('click', () => this.close());
      el.querySelector('#od-checkout')!.addEventListener('click', () => {
        if (this.lastOrder?.checkoutUrl) window.open(this.lastOrder.checkoutUrl, '_blank', 'noopener');
      });
      return;
    }

    if (this.view === 'exported') {
      el.innerHTML = `
        <h3 class="od-product">Print-ready PDF downloaded</h3>
        <p>Your PDF was saved to your computer. To order this book, upload it at the ${this.provider.name} checkout — the print and delivery are handled there.</p>
        <p class="od-hint">Product: ${this.product.name} · ${this.pdfPageCount} pages${this.quote && !this.quote.unavailable ? ` · est. ${this.quote.total.toFixed(2)} ${this.quote.currency}` : ''}</p>
        <div class="confirm-dialog-actions">
          <button id="od-done">Close</button>
          <button id="od-open-shop" class="btn-confirm">Open peecho.com</button>
        </div>
      `;
      el.querySelector('#od-done')!.addEventListener('click', () => this.close());
      el.querySelector('#od-open-shop')!.addEventListener('click', () => {
        window.open('https://www.peecho.com', '_blank', 'noopener');
      });
      return;
    }

    // error
    el.innerHTML = `
      <h3 class="od-product">Order failed</h3>
      <p class="pf-error">${this.errorMessage}</p>
      <div class="confirm-dialog-actions">
        <button id="od-close-err">Close</button>
        <button id="od-retry" class="btn-confirm">Try again</button>
      </div>
    `;
    el.querySelector('#od-close-err')!.addEventListener('click', () => this.close());
    el.querySelector('#od-retry')!.addEventListener('click', () => {
      this.view = 'configure';
      this._renderNew();
      this._scheduleQuote(0);
    });
  }

  private _scheduleQuote(delayMs: number): void {
    clearTimeout(this._quoteTimer);
    const seq = ++this._quoteSeq;
    this._quoteTimer = window.setTimeout(async () => {
      if (!this.provider || !this.product) return;
      const page = getPageSizeMm(this.deps.editor);
      try {
        const q = await this.provider.quote({
          productId: this.product.id,
          pdfPageCount: this.pdfPageCount,
          widthMm: page.width_mm,
          heightMm: page.height_mm,
          options: { ...this.options },
        });
        if (seq !== this._quoteSeq) return; // superseded by a newer request
        this.quote = q;
      } catch {
        if (seq !== this._quoteSeq) return;
        this.quote = null;
      }
      this._renderQuote();
    }, delayMs);
  }

  private _renderQuote(): void {
    const box = this.dialog.querySelector<HTMLElement>('#od-quote');
    if (!box) return;
    const startBtn = this.dialog.querySelector<HTMLButtonElement>('#od-start');
    if (!this.quote) {
      box.innerHTML = '<p class="od-quote-loading">Estimating price…</p>';
      if (startBtn) startBtn.disabled = true; // wait for a quote before acting
      return;
    }
    const q = this.quote;
    if (q.unavailable) {
      box.innerHTML = `<p class="pf-error">${q.unavailable}</p>`;
      if (startBtn) startBtn.disabled = true;
      return;
    }
    if (startBtn) startBtn.disabled = false;
    box.innerHTML = `
      <table class="od-quote-table">
        ${q.lines.map(l => `<tr><td>${l.label}</td><td>${l.amount.toFixed(2)} ${q.currency}</td></tr>`).join('')}
        <tr class="od-quote-total"><td>Estimated total</td><td id="od-total">${q.total.toFixed(2)} ${q.currency}</td></tr>
      </table>
      <p class="od-hint">${q.disclaimer}</p>
    `;
  }

  // -------------------------------------------------------------------------
  // Export run (provider not yet order-enabled): generate PDFs → download,
  // then point the user to the shop's checkout for manual upload.
  // -------------------------------------------------------------------------

  private async _runExport(): Promise<void> {
    if (!this.product) return;
    this.view = 'working';
    this._renderNew();
    this.abort = new AbortController();
    this.deps.onBusyChange?.(true);
    const bar = () => this.dialog.querySelector<HTMLElement>('#od-bar');
    const phase = () => this.dialog.querySelector<HTMLElement>('#od-phase');
    try {
      const ph = phase(); if (ph) ph.textContent = 'Rendering print-ready PDF…';
      const pdfs = await generatePdfs(this.deps.editor, this.deps.getBuffers, {
        onProgress: (f) => { const b = bar(); if (b) b.style.width = `${Math.round(f * 100)}%`; },
        signal: this.abort.signal,
      });
      for (const pdf of pdfs) {
        const url = URL.createObjectURL(new Blob([pdf.bytes as unknown as BlobPart], { type: 'application/pdf' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: pdf.name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      this.view = 'exported';
      this._renderNew();
    } catch (err) {
      const cancelled = (err as Error).name === 'AbortError' || (err as Error).message === 'Export cancelled';
      if (cancelled) {
        this.view = 'configure';
        this._renderNew();
        this._scheduleQuote(0);
      } else {
        this.errorMessage = (err as Error).message || 'Unexpected error';
        this.view = 'error';
        this._renderNew();
        showToast('Export failed: ' + this.errorMessage, 'error');
      }
    } finally {
      this.abort = null;
      this.deps.onBusyChange?.(false);
    }
  }

  // -------------------------------------------------------------------------
  // Order run: generate PDFs → provider.createOrder → checkout handoff
  // -------------------------------------------------------------------------

  private async _runOrder(): Promise<void> {
    if (!this.spec || !this.provider || !this.product) return;
    this.view = 'working';
    this._renderNew();
    this.abort = new AbortController();
    this.deps.onBusyChange?.(true);

    const phaseEl = () => this.dialog.querySelector<HTMLElement>('#od-phase');
    const barEl   = () => this.dialog.querySelector<HTMLElement>('#od-bar');
    const setBar = (fraction: number) => {
      const b = barEl();
      if (b) b.style.width = `${Math.round(fraction * 100)}%`;
    };
    const setPhase = (text: string) => {
      const p = phaseEl();
      if (p) p.textContent = text;
    };

    try {
      // PDF generation maps to 0–50 % of the bar.
      setPhase('Rendering PDF…');
      const pdfs = await generatePdfs(this.deps.editor, this.deps.getBuffers, {
        onProgress: (f) => setBar(f * 0.5),
        signal: this.abort.signal,
      });

      const files = pdfs.map(p => ({
        name: p.name,
        bytes: p.bytes,
        role: (p.name.includes('cover') ? 'cover' : p.name.includes('body') ? 'body' : 'book') as 'book' | 'cover' | 'body',
      }));

      // Upload / provider phases map to 50–100 %.
      const result = await this.provider.createOrder(
        {
          productId: this.product.id,
          options: { ...this.options },
          pdfPageCount: this.pdfPageCount,
          files,
        },
        (p) => {
          if (p.phase === 'uploading' && p.uploadFraction !== undefined) {
            setBar(0.5 + p.uploadFraction * 0.45);
            setPhase(`Uploading… ${Math.round(p.uploadFraction * 100)}%`);
          } else if (p.message) {
            setBar(p.phase === 'processing' ? 0.97 : 0.5);
            setPhase(p.message);
          }
        },
        this.abort.signal,
      );

      const rec: PodOrderRecord = {
        id: crypto.randomUUID(),
        providerId: this.provider.id,
        orderRef: result.orderRef,
        specId: this.spec.id,
        productId: this.product.id,
        options: { ...this.options },
        pdfPageCount: this.pdfPageCount,
        quote: this.quote ? { currency: this.quote.currency, total: this.quote.total } : null,
        checkoutUrl: result.checkoutUrl,
        status: 'awaiting-checkout',
        created: Date.now(),
        updated: Date.now(),
        projectName: this.deps.getProjectName(),
      };
      await upsertPodOrder(rec);
      this.lastOrder = rec;
      this.view = 'checkout';
      this._renderNew();
    } catch (err) {
      const cancelled = (err as Error).name === 'AbortError'
        || (err as Error).message === 'Export cancelled';
      if (cancelled) {
        this.view = 'configure';
        this._renderNew();
        this._scheduleQuote(0);
      } else {
        this.errorMessage = (err as Error).message || 'Unexpected error';
        this.view = 'error';
        this._renderNew();
        showToast('Order failed: ' + this.errorMessage, 'error');
      }
    } finally {
      this.abort = null;
      this.deps.onBusyChange?.(false);
    }
  }

  // -------------------------------------------------------------------------
  // History view
  // -------------------------------------------------------------------------

  private async _renderHistory(): Promise<void> {
    const el = this.dialog.querySelector<HTMLElement>('#od-history')!;
    let orders = await readPodOrders();

    // Best-effort status refresh for non-terminal orders.
    for (const rec of orders) {
      if (TERMINAL_PHASES.has(rec.status)) continue;
      const status = await getProvider(rec.providerId)?.getOrderStatus(rec.orderRef) ?? null;
      if (status && status !== rec.status) {
        rec.status = status;
        rec.updated = Date.now();
        await upsertPodOrder(rec);
      }
    }
    orders = await readPodOrders();

    if (orders.length === 0) {
      el.innerHTML = '<p class="od-hint">No orders yet. Orders are stored on this device only.</p>';
      return;
    }
    el.innerHTML = `
      <table class="od-history-table">
        ${orders.map(o => `
          <tr>
            <td>
              <div class="od-h-name">${o.projectName || 'Untitled'} — ${o.productId}</div>
              <div class="od-hint">${new Date(o.created).toLocaleString()} · ${o.pdfPageCount} pages${o.quote ? ` · ~${o.quote.total.toFixed(2)} ${o.quote.currency}` : ''}</div>
            </td>
            <td><span class="od-status od-status-${o.status}">${o.status}</span></td>
            <td>${o.status === 'awaiting-checkout' && o.checkoutUrl
              ? `<button class="od-reopen" data-url="${o.checkoutUrl}">Open checkout</button>` : ''}</td>
          </tr>`).join('')}
      </table>
      <p class="od-hint">Order history is stored on this device only.</p>
    `;
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.od-reopen')) {
      btn.addEventListener('click', () => window.open(btn.dataset.url!, '_blank', 'noopener'));
    }
  }

}
