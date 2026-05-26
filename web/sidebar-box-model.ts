// sidebar-box-model.ts — BoxModelEditor panel (shown when a frame is selected).
//
// Multi-selection sentinel values:
//   null/absent for border-width fields (Rust Option::None → skip, per-side pattern)
//   null/absent for margin and rotation (Rust Option::None → skip)
//   "__mixed__" for color fields (Rust skips this exact string)
//   ""          for border-position (Rust deserialises as BorderPosition::Mixed → skip)
//   -1          for border.radius (f32 field, Rust skips if < 0)

import type { BoxModel } from './types.js';
import { debounce } from './utils.js';
import { numFieldWithDice, colorField, selectField, bindInputs } from './ui-fields.js';
import { MarginModeController, marginSectionHtml, type MarginMode, type Sides, detectMarginMode } from './margin-mode-controller.js';

export type LayoutTransform = 'flip-h' | 'flip-v' | 'rotate-cw' | 'rotate-ccw';

export class BoxModelEditor {
  private containerEl: HTMLElement;
  private onChange: (json: string) => void;
  private onZOrder: (direction: 'up' | 'down') => void;
  private onDiceClick: (field: string) => void;
  private _multiSel = false;
  private onLayoutTransform: (t: LayoutTransform) => void;
  private _built = false;
  private _marginCtrl!: MarginModeController;
  private _borderWidthCtrl!: MarginModeController;

  constructor(
    containerEl: HTMLElement,
    onChange: (json: string) => void,
    onZOrder: (direction: 'up' | 'down') => void,
    onDiceClick: (field: string) => void,
    onLayoutTransform: (t: LayoutTransform) => void,
  ) {
    this.containerEl = containerEl;
    this.onChange = onChange;
    this.onZOrder = onZOrder;
    this.onDiceClick = onDiceClick;
    this.onLayoutTransform = onLayoutTransform;
  }

  clear(): void {
    this.containerEl.innerHTML = '<p class="no-selection">Select a frame to edit</p>';
    this._built = false;
  }

  update(boxModelJson: string, zIndex?: number, selectionCount = 1, selectionIsRect = false): void {
    const bm = JSON.parse(boxModelJson) as BoxModel;

    if (!this._built || this.containerEl.dataset.panel !== 'boxmodel') this._build();

    // Dice buttons only appear on field focus (when multiSel); hide all when dropping to single selection.
    this._multiSel = selectionCount > 1;
    if (!this._multiSel) {
      this.containerEl.querySelectorAll<HTMLButtonElement>('[data-dice]').forEach(btn => {
        btn.hidden = true;
      });
    }

    // Show layout-transform buttons when multiple frames form a complete rectangle.
    const showTransform = this._multiSel && selectionIsRect;
    const transformRow = this.containerEl.querySelector<HTMLElement>('.bm-layout-transform');
    if (transformRow) transformRow.hidden = !showTransform;

    // Margin (null = mixed sentinel; allows negative values)
    const margin: Sides = bm.margin ?? { top: null, right: null, bottom: null, left: null };
    this._updateSidesUI(this._marginCtrl, 'margin', margin);

    // Border widths (per-side, null = mixed)
    const border = bm.border ?? {};
    const bw: Sides = {
      top:    border.width_top    ?? null,
      right:  border.width_right  ?? null,
      bottom: border.width_bottom ?? null,
      left:   border.width_left   ?? null,
    };
    this._updateSidesUI(this._borderWidthCtrl, 'bw', bw);
    this._set('border-radius',   border.radius   ?? 0);
    this._set('border-color',    border.color    ?? '#000000');
    this._set('border-position', border.position ?? 'centered');

    // Node transform (undefined/null → show Mixed placeholder)
    this._setOffset('node-rotation', bm.face_rotation_deg);

    // Z-order label
    const orderRow     = this.containerEl.querySelector<HTMLElement>('.bm-order-row');
    const orderSection = orderRow?.closest<HTMLElement>('.bm-section') ?? null;
    if (orderSection) orderSection.hidden = zIndex === undefined;
    if (orderRow) {
      const orderLabel = orderRow.querySelector<HTMLElement>('.bm-z-label');
      if (orderLabel) orderLabel.textContent = String((zIndex ?? 0) + 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Set a single field. Handles sentinel values produced by the Rust multi-selection merger:
   *   f32 sentinel  : -1 (or any negative) → blank number input
   *   string sentinel: "__mixed__"          → dimmed colour swatch
   *   position sentinel: "mixed"            → "—" select option
   */
  private _set(name: string, value: unknown): void {
    const el = this.containerEl.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-field="${name}"]`,
    );
    if (!el) return;

    // Reset mixed state from previous update.
    delete (el as HTMLElement & { dataset: DOMStringMap }).dataset.mixed;

    if (el instanceof HTMLInputElement && el.type === 'number') {
      if (typeof value === 'number' && value < 0) {
        el.value = '';
        el.placeholder = 'Mixed';
        el.dataset.mixed = '1';
      } else {
        el.value = typeof value === 'number' ? value.toFixed(2) : (String(value ?? '0'));
        el.placeholder = '';
      }
    } else if (el instanceof HTMLInputElement && el.type === 'color') {
      if (value === '__mixed__') {
        el.value = '#808080';
        el.dataset.mixed = '1';
      } else {
        el.value = (value && value !== '') ? String(value) : '#ffffff';
      }
    } else if (el instanceof HTMLSelectElement) {
      if (!value || value === 'mixed') {
        el.value = '';
        el.dataset.mixed = '1';
      } else {
        el.value = String(value);
      }
    } else {
      (el as HTMLInputElement).value = String(value ?? '');
    }
  }

  /** Like _set but treats null/undefined as the mixed sentinel (for fields that can be negative). */
  private _setOffset(name: string, value: unknown): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el) return;
    delete el.dataset.mixed;
    if (value == null) {
      el.value = '';
      el.placeholder = 'Mixed';
      el.dataset.mixed = '1';
    } else {
      el.value = typeof value === 'number' ? value.toFixed(2) : String(value);
      el.placeholder = '';
    }
  }

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'boxmodel';
    this.containerEl.innerHTML = `
      ${marginSectionHtml('Margin (mm)', (name, label) => numFieldWithDice(name, label, { min: null }))}
      ${marginSectionHtml('Border width (mm)', (name, label) => numFieldWithDice(name, label), 'bw')}
      <div class="bm-section">
        <h4>Border style</h4>
        <div class="bm-grid">
          ${numFieldWithDice('border-radius', 'Radius (mm)')}
          ${colorField('border-color', 'Color')}
        </div>
        <div class="bm-grid" style="margin-top:4px">
          ${selectField('border-position', 'Position', [
            ['inner',    'Inner'],
            ['centered', 'Centered'],
            ['outer',    'Outer'],
          ], true)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid">
          ${numFieldWithDice('node-rotation', 'Rotation (°)', { min: null, max: undefined })}
        </div>
        <div class="bm-layout-transform" hidden>
          <div class="bm-layout-btns">
            <button class="bm-layout-btn" data-layout="flip-h"     title="Mirror left / right"><i class="fa-solid fa-left-right"></i></button>
            <button class="bm-layout-btn" data-layout="flip-v"     title="Mirror top / bottom"><i class="fa-solid fa-up-down"></i></button>
            <button class="bm-layout-btn" data-layout="rotate-cw"  title="Rotate 90° clockwise"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="bm-layout-btn" data-layout="rotate-ccw" title="Rotate 90° counter-clockwise"><i class="fa-solid fa-rotate-left"></i></button>
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Order</h4>
        <div class="bm-order-row">
          <div class="bm-order-btns">
            <button class="bm-order-btn" data-zorder="back"  title="Send to back"><i class="fa-solid fa-angles-down"></i></button>
            <button class="bm-order-btn" data-zorder="down"  title="Move down (render below)"><i class="fa-solid fa-arrow-down"></i></button>
            <button class="bm-order-btn" data-zorder="up"    title="Move up (render above)"><i class="fa-solid fa-arrow-up"></i></button>
            <button class="bm-order-btn" data-zorder="front" title="Bring to front"><i class="fa-solid fa-angles-up"></i></button>
          </div>
          <span class="bm-z-label">—</span>
        </div>
      </div>
    `;

    bindInputs(this.containerEl, () => this._emit());

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-zorder]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.onZOrder(btn.dataset.zorder as 'up' | 'down');
      });
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-dice]').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.dice === 'node-rotation' ? 'rotation' : btn.dataset.dice!;
        this.onDiceClick(field);
      });
    });

    this.containerEl.addEventListener('focusin', (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'number') return;
      const btn = input.parentElement?.querySelector<HTMLButtonElement>('.bm-dice-btn');
      if (btn && this._multiSel) btn.hidden = false;
    });

    this.containerEl.addEventListener('focusout', (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'number') return;
      const btn = input.parentElement?.querySelector<HTMLButtonElement>('.bm-dice-btn');
      if (btn) setTimeout(() => { btn.hidden = true; }, 150);
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.onLayoutTransform(btn.dataset.layout as LayoutTransform);
      });
    });

    this._marginCtrl = new MarginModeController(this.containerEl);
    this._marginCtrl.bindButtons(mode => this._setSidesMode(this._marginCtrl, 'margin', mode));

    this._borderWidthCtrl = new MarginModeController(this.containerEl, 'bw');
    this._borderWidthCtrl.bindButtons(mode => this._setSidesMode(this._borderWidthCtrl, 'bw', mode));
  }

  // ---------------------------------------------------------------------------
  // Field value readers (used by _emit)
  // ---------------------------------------------------------------------------

  private _gNum(name: string): number {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return -1;
    const v = parseFloat(el.value);
    return isNaN(v) ? 0 : v;
  }

  private _gColor(name: string): string {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return '__mixed__';
    return el.value || '#ffffff';
  }

  private _gSel(name: string): string {
    const el = this.containerEl.querySelector<HTMLSelectElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return '';
    return el.value;
  }

  private _gOffset(name: string): number | null {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return null;
    const v = parseFloat(el.value);
    return isNaN(v) ? 0 : v;
  }

  // ---------------------------------------------------------------------------
  // Shared sides helpers — used for both margin ('margin') and border width ('bw')
  // ---------------------------------------------------------------------------

  private _updateSidesUI(ctrl: MarginModeController, ns: string, m: Sides): void {
    ctrl.setMode(detectMarginMode(m));
    if (ctrl.mode === 'all') {
      this._setOffset(`${ns}-all`, m.top);
    } else if (ctrl.mode === 'xy') {
      this._setOffset(`${ns}-v`, m.top);
      this._setOffset(`${ns}-h`, m.right);
    } else {
      this._setOffset(`${ns}-top`,    m.top);
      this._setOffset(`${ns}-right`,  m.right);
      this._setOffset(`${ns}-bottom`, m.bottom);
      this._setOffset(`${ns}-left`,   m.left);
    }
  }

  private _setSidesMode(ctrl: MarginModeController, ns: string, mode: MarginMode): void {
    const rank: Record<MarginMode, number> = { all: 1, xy: 2, each: 3 };
    const refining = rank[mode] > rank[ctrl.mode];
    const prev = this._readCurrentSides(ctrl, ns);
    ctrl.setMode(mode);

    if (mode === 'all') {
      // Always coarsening — show mixed if sides differ.
      const same = prev.top === prev.right && prev.right === prev.bottom && prev.bottom === prev.left;
      this._setOffset(`${ns}-all`, same ? prev.top : null);
    } else if (mode === 'xy') {
      const v = prev.top === prev.bottom ? prev.top : null;
      const h = prev.right === prev.left  ? prev.right : null;
      // When refining from 'all', a null v/h means the all-field was mixed —
      // leave the xy fields as-is (they still hold their previous concrete values).
      if (!refining || v !== null) this._setOffset(`${ns}-v`, v);
      if (!refining || h !== null) this._setOffset(`${ns}-h`, h);
    } else {
      // Always refining — only overwrite each field if we have a concrete value;
      // otherwise preserve whatever the each-pane already shows.
      if (prev.top    !== null) this._setOffset(`${ns}-top`,    prev.top);
      if (prev.right  !== null) this._setOffset(`${ns}-right`,  prev.right);
      if (prev.bottom !== null) this._setOffset(`${ns}-bottom`, prev.bottom);
      if (prev.left   !== null) this._setOffset(`${ns}-left`,   prev.left);
    }
    this._emit();
  }

  private _readCurrentSides(ctrl: MarginModeController, ns: string): Sides {
    if (ctrl.mode === 'all') {
      const v = this._gOffset(`${ns}-all`);
      return { top: v, right: v, bottom: v, left: v };
    }
    if (ctrl.mode === 'xy') {
      const v = this._gOffset(`${ns}-v`);
      const h = this._gOffset(`${ns}-h`);
      return { top: v, right: h, bottom: v, left: h };
    }
    return {
      top:    this._gOffset(`${ns}-top`),
      right:  this._gOffset(`${ns}-right`),
      bottom: this._gOffset(`${ns}-bottom`),
      left:   this._gOffset(`${ns}-left`),
    };
  }

  private _emit = debounce(() => {
    const bw = this._readCurrentSides(this._borderWidthCtrl, 'bw');
    const bm = {
      margin: this._readCurrentSides(this._marginCtrl, 'margin'),
      border: {
        width_top:    bw.top,
        width_right:  bw.right,
        width_bottom: bw.bottom,
        width_left:   bw.left,
        radius:   this._gNum('border-radius'),
        color:    this._gColor('border-color'),
        position: this._gSel('border-position'),
      },
      face_rotation_deg: this._gOffset('node-rotation'),
    };
    this.onChange(JSON.stringify(bm));
  }, 150);
}
