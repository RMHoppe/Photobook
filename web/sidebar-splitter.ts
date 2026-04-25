// sidebar-splitter.ts — SplitterEditor panel (shown when BSP split node(s) are selected).
//
// All box model fields (including gap) are emitted together via onBoxModelChange and routed
// to set_split_box_model on the Rust side. Ratio is emitted separately via onRatioChange
// and routed to set_split_ratios.

import type { BoxModel } from './types.js';

export class SplitterEditor {
  private containerEl: HTMLElement;
  private onBoxModelChange: (json: string) => void;
  private onRatioChange: (ratio: number) => void;
  private _built = false;
  private _emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    containerEl: HTMLElement,
    onBoxModelChange: (json: string) => void,
    onRatioChange: (ratio: number) => void,
  ) {
    this.containerEl = containerEl;
    this.onBoxModelChange = onBoxModelChange;
    this.onRatioChange = onRatioChange;
  }

  /** Populate the panel from the split node's merged box model + ratio + axis. */
  update(bm: BoxModel, ratio: number, axis: 'v' | 'h' | ''): void {
    if (!this._built || this.containerEl.dataset.panel !== 'splitter') this._build();

    const active = document.activeElement;

    const setNum = (field: string, v: number) => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
      if (!el || active === el) return;
      if (v < 0) { el.value = ''; el.placeholder = 'Mixed'; }
      else        { el.value = v.toFixed(2); el.placeholder = ''; }
    };

    const setColor = (field: string, v: string) => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
      if (!el || active === el) return;
      el.value = (v && v !== '' && v !== '__mixed__') ? v : '#ffffff';
    };

    const setSel = (field: string, v: string) => {
      const el = this.containerEl.querySelector<HTMLSelectElement>(`[data-field="${field}"]`);
      if (!el || active === el) return;
      el.value = (!v || v === 'mixed') ? '' : v;
    };

    // Splitter-specific
    setNum('sp-gap', bm.gap ?? 0);

    const ratioEl = this.containerEl.querySelector<HTMLInputElement>('[data-field="sp-ratio"]');
    if (ratioEl && active !== ratioEl) {
      if (ratio < 0) { ratioEl.value = ''; ratioEl.placeholder = 'Mixed'; }
      else           { ratioEl.value = (ratio * 100).toFixed(1); ratioEl.placeholder = ''; }
    }

    const axisEl = this.containerEl.querySelector<HTMLElement>('.sp-axis-label');
    if (axisEl) {
      axisEl.textContent = axis === 'v' ? 'Vertical' : axis === 'h' ? 'Horizontal' : 'Mixed';
    }

    // Shared box model
    setNum('margin-top',    bm.margin?.top    ?? 0);
    setNum('margin-right',  bm.margin?.right  ?? 0);
    setNum('margin-bottom', bm.margin?.bottom ?? 0);
    setNum('margin-left',   bm.margin?.left   ?? 0);
    setColor('bg-color',      bm.bg ?? '');
    setNum('border-width',    bm.border?.width    ?? 0);
    setColor('border-color',  bm.border?.color    ?? '#000000');
    setSel('border-position', bm.border?.position ?? 'centered');

    const rotEl = this.containerEl.querySelector<HTMLInputElement>('[data-field="node-rotation"]');
    if (rotEl && active !== rotEl) {
      const rot = bm.node_rotation_deg ?? 0;
      if (Math.abs(rot) >= 9998) { rotEl.value = ''; rotEl.placeholder = 'Mixed'; }
      else                        { rotEl.value = rot.toFixed(2); rotEl.placeholder = ''; }
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'splitter';
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Gap (mm)</h4>
        <div class="bm-grid">
          ${this._numField('sp-gap', 'Gap', 0, 200)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Split Ratio</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>First child (%)</label>
            <input type="number" min="5" max="95" step="1" data-field="sp-ratio" value="50" />
          </div>
        </div>
        <p class="sp-axis-label" style="margin:4px 0 0;font-size:12px;color:#888;">—</p>
      </div>
      <div class="bm-section">
        <h4>Margin (mm)</h4>
        <div class="bm-grid">
          ${this._numField('margin-top',    'Top')}
          ${this._numField('margin-right',  'Right')}
          ${this._numField('margin-bottom', 'Bottom')}
          ${this._numField('margin-left',   'Left')}
        </div>
      </div>
      <div class="bm-section">
        <h4>Background</h4>
        <div class="bm-bg-row">
          <input type="color" data-field="bg-color" value="#ffffff" />
        </div>
      </div>
      <div class="bm-section">
        <h4>Border</h4>
        <div class="bm-grid">
          ${this._numField('border-width', 'Width (mm)')}
          <div class="bm-field">
            <label>Color</label>
            <input type="color" data-field="border-color" value="#000000" />
          </div>
        </div>
        <div class="bm-grid" style="margin-top:4px">
          <div class="bm-field bm-full-width">
            <label>Position</label>
            <select data-field="border-position">
              <option value="" hidden>—</option>
              <option value="inner">Inner</option>
              <option value="centered">Centered</option>
              <option value="outer">Outer</option>
            </select>
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid">
          ${this._numField('node-rotation', 'Rotation (°)', -360, 360, 0.5)}
        </div>
      </div>
    `;

    // Ratio input — dedicated callback
    const ratioEl = this.containerEl.querySelector<HTMLInputElement>('[data-field="sp-ratio"]')!;
    const onRatioInput = () => this._scheduleRatio(ratioEl);
    ratioEl.addEventListener('input',  onRatioInput);
    ratioEl.addEventListener('change', onRatioInput);

    // All other inputs — box model callback (includes gap)
    this.containerEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(el => {
      if ((el as HTMLElement).dataset.field === 'sp-ratio') return;
      const onInput = () => this._scheduleBoxModel();
      el.addEventListener('input',  onInput);
      el.addEventListener('change', onInput);
    });
  }

  private _numField(name: string, label: string, min = 0, max = 200, step = 0.5): string {
    return `<div class="bm-field">
      <label>${label}</label>
      <input type="number" min="${min}" max="${max}" step="${step}" data-field="${name}" value="0" />
    </div>`;
  }

  private _scheduleRatio(el: HTMLInputElement): void {
    if (this._emitTimer !== null) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      const v = parseFloat(el.value);
      if (!isNaN(v)) this.onRatioChange(Math.max(5, Math.min(95, v)) / 100);
    }, 150);
  }

  private _scheduleBoxModel(): void {
    if (this._emitTimer !== null) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      const gNum = (field: string): number => {
        const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
        if (!el || el.dataset.mixed) return -1;
        const v = parseFloat(el.value);
        return isNaN(v) ? 0 : v;
      };
      const gColor = (field: string): string => {
        const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
        return (!el || el.dataset.mixed) ? '__mixed__' : (el.value || '#ffffff');
      };
      const gSel = (field: string): string => {
        const el = this.containerEl.querySelector<HTMLSelectElement>(`[data-field="${field}"]`);
        return (!el || (el as HTMLElement & { dataset: DOMStringMap }).dataset.mixed) ? '' : el.value;
      };
      const rotEl = this.containerEl.querySelector<HTMLInputElement>('[data-field="node-rotation"]');
      const rotV = rotEl && !rotEl.dataset.mixed ? parseFloat(rotEl.value) : NaN;

      const bm = {
        margin: {
          top:    gNum('margin-top'),
          right:  gNum('margin-right'),
          bottom: gNum('margin-bottom'),
          left:   gNum('margin-left'),
        },
        gap:  gNum('sp-gap'),   // included — set_split_box_model writes gap directly
        bg:   gColor('bg-color'),
        border: {
          width:    gNum('border-width'),
          color:    gColor('border-color'),
          position: gSel('border-position'),
        },
        node_rotation_deg: isNaN(rotV) ? 9999 : rotV,
      };
      this.onBoxModelChange(JSON.stringify(bm));
    }, 150);
  }
}
