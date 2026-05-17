// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).

import type { SpreadSettingsData } from './types.js';
export type { SpreadSettingsData };

export class SpreadSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: SpreadSettingsData) => void;
  private _built = false;
  private _emitTimer: ReturnType<typeof setTimeout> | null = null;
  private _marginMode: 'all' | 'xy' | 'each' = 'each';

  constructor(containerEl: HTMLElement, onChange: (data: SpreadSettingsData) => void) {
    this.containerEl = containerEl;
    this.onChange = onChange;
  }

  show(data: SpreadSettingsData): void {
    if (!this._built) this._build();
    this._populate(data);
  }

  private _build(): void {
    this._built = true;
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <div class="bm-section-header">
          <h4>Spread margin (mm)</h4>
          <div class="margin-mode-bar">
            <button class="margin-mode-btn" data-margin-mode="all"  title="All sides equal">All</button>
            <button class="margin-mode-btn" data-margin-mode="xy"   title="Vertical / Horizontal">X·Y</button>
            <button class="margin-mode-btn" data-margin-mode="each" title="Each side individually">Each</button>
          </div>
        </div>
        <div class="margin-pane" data-margin-pane="all">
          <div class="bm-grid">${this._numField('margin-all', 'All')}</div>
        </div>
        <div class="margin-pane" data-margin-pane="xy">
          <div class="bm-grid">
            ${this._numField('margin-v', 'Vertical')}
            ${this._numField('margin-h', 'Horizontal')}
          </div>
        </div>
        <div class="margin-pane" data-margin-pane="each">
          <div class="bm-grid">
            ${this._numField('margin-top',    'Top')}
            ${this._numField('margin-right',  'Right')}
            ${this._numField('margin-bottom', 'Bottom')}
            ${this._numField('margin-left',   'Left')}
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Page backgrounds</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>Left page</label>
            <input type="color" data-field="left-bg" value="#ffffff" />
          </div>
          <div class="bm-field">
            <label>Right page</label>
            <input type="color" data-field="right-bg" value="#ffffff" />
          </div>
        </div>
      </div>
    `;

    this.containerEl.querySelectorAll<HTMLInputElement>('input').forEach(el => {
      el.addEventListener('change', () => this._emit());
      el.addEventListener('input',  () => this._emit());
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-margin-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setMarginMode(btn.dataset.marginMode as 'all' | 'xy' | 'each');
      });
    });
  }

  private _populate(data: SpreadSettingsData): void {
    const mode = this._detectMarginMode(data);
    this._marginMode = mode;
    this._applyMarginMode();
    if (mode === 'all') {
      this._setNum('margin-all', data.margin_top);
    } else if (mode === 'xy') {
      this._setNum('margin-v', data.margin_top);
      this._setNum('margin-h', data.margin_right);
    } else {
      this._setNum('margin-top',    data.margin_top);
      this._setNum('margin-right',  data.margin_right);
      this._setNum('margin-bottom', data.margin_bottom);
      this._setNum('margin-left',   data.margin_left);
    }
    this._setColor('left-bg',  data.left_bg  || '#ffffff');
    this._setColor('right-bg', data.right_bg || '#ffffff');
  }

  private _setNum(name: string, value: number): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value.toFixed(2);
  }

  private _setColor(name: string, value: string): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value;
  }

  private _numField(name: string, label: string): string {
    return `<div class="bm-field">
      <label>${label}</label>
      <input type="number" min="0" max="200" step="0.5" data-field="${name}" value="0" />
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Margin mode selector helpers
  // ---------------------------------------------------------------------------

  private _detectMarginMode(data: SpreadSettingsData): 'all' | 'xy' | 'each' {
    const { margin_top: t, margin_right: r, margin_bottom: b, margin_left: l } = data;
    if (t === r && r === b && b === l) return 'all';
    if (t === b && l === r) return 'xy';
    return 'each';
  }

  private _setMarginMode(mode: 'all' | 'xy' | 'each'): void {
    const prev = this._readCurrentMargins();
    this._marginMode = mode;
    this._applyMarginMode();
    if (mode === 'all') {
      this._setNum('margin-all', prev.top);
    } else if (mode === 'xy') {
      this._setNum('margin-v', prev.top);
      this._setNum('margin-h', prev.right);
    } else {
      this._setNum('margin-top',    prev.top);
      this._setNum('margin-right',  prev.right);
      this._setNum('margin-bottom', prev.bottom);
      this._setNum('margin-left',   prev.left);
    }
    this._emit();
  }

  private _readCurrentMargins(): { top: number; right: number; bottom: number; left: number } {
    const g = (name: string): number => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
      if (!el) return 0;
      const v = parseFloat(el.value);
      return isNaN(v) ? 0 : v;
    };
    if (this._marginMode === 'all') {
      const v = g('margin-all');
      return { top: v, right: v, bottom: v, left: v };
    }
    if (this._marginMode === 'xy') {
      const vert = g('margin-v');
      const horiz = g('margin-h');
      return { top: vert, right: horiz, bottom: vert, left: horiz };
    }
    return {
      top:    g('margin-top'),
      right:  g('margin-right'),
      bottom: g('margin-bottom'),
      left:   g('margin-left'),
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
      const gc = (name: string): string => {
        const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
        return el ? el.value : '#ffffff';
      };
      const margins = this._readCurrentMargins();
      this.onChange({
        margin_top:    margins.top,
        margin_right:  margins.right,
        margin_bottom: margins.bottom,
        margin_left:   margins.left,
        left_bg:  gc('left-bg'),
        right_bg: gc('right-bg'),
      });
    }, 150);
  }
}
