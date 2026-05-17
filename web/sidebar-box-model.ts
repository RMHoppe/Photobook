// sidebar-box-model.ts — BoxModelEditor panel (shown when a frame is selected).
//
// Multi-selection sentinel values:
//   -1          for f32 fields that are always ≥ 0, e.g. border.width (Rust skips value < 0)
//   null/absent for fields that can be negative, e.g. margins and rotation (Rust Option::None → skip)
//   "__mixed__" for color fields (Rust skips this exact string)
//   ""          for border-position (Rust deserialises as BorderPosition::Mixed → skip)

import type { BoxModel } from './types.js';

export class BoxModelEditor {
  private containerEl: HTMLElement;
  private onChange: (json: string) => void;
  private onZOrder: (direction: 'up' | 'down') => void;
  private onDiceClick: (field: 'rotation') => void;
  private _built = false;
  private _emitTimer: ReturnType<typeof setTimeout> | null = null;
  private _marginMode: 'all' | 'xy' | 'each' = 'each';

  constructor(
    containerEl: HTMLElement,
    onChange: (json: string) => void,
    onZOrder: (direction: 'up' | 'down') => void,
    onDiceClick: (field: 'rotation') => void,
  ) {
    this.containerEl = containerEl;
    this.onChange = onChange;
    this.onZOrder = onZOrder;
    this.onDiceClick = onDiceClick;
  }

  clear(): void {
    this.containerEl.innerHTML = '<p class="no-selection">Select a frame to edit</p>';
    this._built = false;
  }

  update(boxModelJson: string, zIndex?: number, selectionCount = 1): void {
    const bm = JSON.parse(boxModelJson) as BoxModel;

    if (!this._built || this.containerEl.dataset.panel !== 'boxmodel') this._build();

    // Show dice buttons only when multiple frames are selected.
    const multiSel = selectionCount > 1;
    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-dice]').forEach(btn => {
      btn.hidden = !multiSel;
    });

    // Margin (null = mixed sentinel; allows negative values)
    this._updateMarginUI(bm.margin);

    // Border
    const border = bm.border ?? {};
    this._set('border-width',    border.width    ?? 0);
    this._set('border-radius',   border.radius   ?? 0);
    this._set('border-color',    border.color    ?? '#000000');
    this._set('border-position', border.position ?? 'centered');

    // Node transform (undefined/null → show Mixed placeholder)
    this._setOffset('node-rotation', bm.face_rotation_deg);

    // Z-order label
    const orderLabel = this.containerEl.querySelector<HTMLElement>('.bm-z-label');
    if (orderLabel) {
      orderLabel.textContent = zIndex !== undefined ? String(zIndex + 1) : '—';
    }
    const orderBtns = this.containerEl.querySelector<HTMLElement>('.bm-order-btns');
    if (orderBtns) {
      orderBtns.style.display = zIndex !== undefined ? '' : 'none';
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
      <div class="bm-section">
        <div class="bm-section-header">
          <h4>Margin (mm)</h4>
          <div class="margin-mode-bar">
            <button class="margin-mode-btn" data-margin-mode="all"  title="All sides equal">All</button>
            <button class="margin-mode-btn" data-margin-mode="xy"   title="Vertical / Horizontal">X·Y</button>
            <button class="margin-mode-btn" data-margin-mode="each" title="Each side individually">Each</button>
          </div>
        </div>
        <div class="margin-pane" data-margin-pane="all">
          <div class="bm-grid">${this._field('margin-all', 'All', true)}</div>
        </div>
        <div class="margin-pane" data-margin-pane="xy">
          <div class="bm-grid">
            ${this._field('margin-v', 'Vertical',   true)}
            ${this._field('margin-h', 'Horizontal', true)}
          </div>
        </div>
        <div class="margin-pane" data-margin-pane="each">
          <div class="bm-grid">
            ${this._field('margin-top',    'Top',    true)}
            ${this._field('margin-right',  'Right',  true)}
            ${this._field('margin-bottom', 'Bottom', true)}
            ${this._field('margin-left',   'Left',   true)}
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Border</h4>
        <div class="bm-grid">
          ${this._field('border-width',  'Width (mm)')}
          ${this._field('border-radius', 'Radius (mm)')}
          ${this._colorField('border-color', 'Color')}
        </div>
        <div class="bm-grid" style="margin-top:4px">
          ${this._selectField('border-position', 'Position', [
            ['inner',    'Inner'],
            ['centered', 'Centered'],
            ['outer',    'Outer'],
          ])}
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid">
          ${this._offsetFieldWithDice('node-rotation', 'Rotation (°)', 'rotation')}
        </div>
      </div>
      <div class="bm-section">
        <h4>Order</h4>
        <div class="bm-order-row">
          <div class="bm-order-btns">
            <button class="bm-order-btn" data-zorder="down" title="Move down (render below)">↓</button>
            <button class="bm-order-btn" data-zorder="up"   title="Move up (render above)">↑</button>
          </div>
          <span class="bm-z-label">—</span>
        </div>
      </div>
    `;

    this.containerEl.querySelectorAll('input, select').forEach(el => {
      const onUserInput = () => {
        delete (el as HTMLElement & { dataset: DOMStringMap }).dataset.mixed;
        this._emit();
      };
      el.addEventListener('change', onUserInput);
      el.addEventListener('input',  onUserInput);
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-zorder]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.onZOrder(btn.dataset.zorder as 'up' | 'down');
      });
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-dice]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.onDiceClick(btn.dataset.dice as 'rotation');
      });
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-margin-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setMarginMode(btn.dataset.marginMode as 'all' | 'xy' | 'each');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Field HTML builders
  // ---------------------------------------------------------------------------

  private _wrapField(label: string, input: string, fullWidth = false): string {
    return `<div class="bm-field${fullWidth ? ' bm-full-width' : ''}"><label>${label}</label>${input}</div>`;
  }

  private _field(name: string, label: string, allowNegative = false): string {
    const minAttr = allowNegative ? '' : 'min="0" ';
    return this._wrapField(label, `<input type="number" ${minAttr}max="200" step="0.5" data-field="${name}" value="0" />`);
  }

  private _colorField(name: string, label: string): string {
    return this._wrapField(label, `<input type="color" data-field="${name}" value="#000000" />`);
  }

  private _offsetFieldWithDice(name: string, label: string, dice: string): string {
    return this._wrapField(label,
      `<div class="bm-input-row"><input type="number" step="0.5" data-field="${name}" value="0" /><button class="bm-dice-btn" data-dice="${dice}" title="Randomize across selection" hidden>⚄</button></div>`);
  }

  private _selectField(name: string, label: string, options: [string, string][]): string {
    const opts = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    return this._wrapField(label,
      `<select data-field="${name}"><option value="" hidden>—</option>${opts}</select>`, true);
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
  // Margin mode selector helpers
  // ---------------------------------------------------------------------------

  private _detectMarginMode(m: { top: number | null; right: number | null; bottom: number | null; left: number | null }): 'all' | 'xy' | 'each' {
    const { top: t, right: r, bottom: b, left: l } = m;
    if (t == null || r == null || b == null || l == null) return 'each';
    if (t === r && r === b && b === l) return 'all';
    if (t === b && l === r) return 'xy';
    return 'each';
  }

  private _updateMarginUI(margin: { top: number | null; right: number | null; bottom: number | null; left: number | null } | undefined): void {
    const m = margin ?? { top: null, right: null, bottom: null, left: null };
    this._marginMode = this._detectMarginMode(m);
    this._applyMarginMode();
    if (this._marginMode === 'all') {
      this._setOffset('margin-all', m.top);
    } else if (this._marginMode === 'xy') {
      this._setOffset('margin-v', m.top);
      this._setOffset('margin-h', m.right);
    } else {
      this._setOffset('margin-top',    m.top);
      this._setOffset('margin-right',  m.right);
      this._setOffset('margin-bottom', m.bottom);
      this._setOffset('margin-left',   m.left);
    }
  }

  private _setMarginMode(mode: 'all' | 'xy' | 'each'): void {
    const prev = this._readCurrentMargins();
    this._marginMode = mode;
    this._applyMarginMode();
    if (mode === 'all') {
      this._setOffset('margin-all', prev.top ?? prev.right ?? prev.bottom ?? prev.left ?? 0);
    } else if (mode === 'xy') {
      this._setOffset('margin-v', prev.top);
      this._setOffset('margin-h', prev.right);
    } else {
      this._setOffset('margin-top',    prev.top);
      this._setOffset('margin-right',  prev.right);
      this._setOffset('margin-bottom', prev.bottom);
      this._setOffset('margin-left',   prev.left);
    }
    this._emit();
  }

  private _readCurrentMargins(): { top: number | null; right: number | null; bottom: number | null; left: number | null } {
    if (this._marginMode === 'all') {
      const v = this._gOffset('margin-all');
      return { top: v, right: v, bottom: v, left: v };
    }
    if (this._marginMode === 'xy') {
      const v = this._gOffset('margin-v');
      const h = this._gOffset('margin-h');
      return { top: v, right: h, bottom: v, left: h };
    }
    return {
      top:    this._gOffset('margin-top'),
      right:  this._gOffset('margin-right'),
      bottom: this._gOffset('margin-bottom'),
      left:   this._gOffset('margin-left'),
    };
  }

  private _applyMarginMode(): void {
    this.containerEl.querySelectorAll<HTMLElement>('[data-margin-pane]').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.marginPane === this._marginMode);
    });
    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-margin-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.marginMode === this._marginMode);
    });
  }

  private _emit(): void {
    if (this._emitTimer !== null) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      const bm = {
        margin: this._readCurrentMargins(),
        border: {
          width:    this._gNum('border-width'),
          radius:   this._gNum('border-radius'),
          color:    this._gColor('border-color'),
          position: this._gSel('border-position'),
        },
        face_rotation_deg: this._gOffset('node-rotation'),
      };
      this.onChange(JSON.stringify(bm));
    }, 150);
  }
}
