// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).

import type { SpreadSettingsData } from './types.js';
import { debounce } from './utils.js';
import { numField, colorField, bindInputs, setNumField, readNumField } from './ui-fields.js';
import { MarginModeController, marginSectionHtml, type MarginMode, detectMarginMode } from './margin-mode-controller.js';

const SPREAD_MARGIN_DEFAULT_MM = 10;
export type { SpreadSettingsData };

export class SpreadSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: SpreadSettingsData) => void;
  private _built = false;
  private _marginCtrl!: MarginModeController;
  /** Last concrete margin values — used as fallback when a field is in mixed state. */
  private _lastMargins = { top: 0, right: 0, bottom: 0, left: 0 };

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
      ${marginSectionHtml('Spread margin (mm)', (name, label) => numField(name, label), 'margin', undefined, 'spread-margin')}
      <div class="bm-section">
        <h4>Page backgrounds</h4>
        <div class="bm-grid">
          ${colorField('left-bg',  'Left page')}
          ${colorField('right-bg', 'Right page')}
        </div>
      </div>
    `;

    bindInputs(this.containerEl, () => this._emit(), 'input');

    this.containerEl.querySelectorAll<HTMLInputElement>('[data-enable]').forEach(cb => {
      cb.addEventListener('change', () => this._onEnableToggle(cb.checked));
    });

    this._marginCtrl = new MarginModeController(this.containerEl);
    this._marginCtrl.bindButtons(mode => this._setMarginMode(mode));
  }

  private _populate(data: SpreadSettingsData): void {
    this._lastMargins = { top: data.margin_top, right: data.margin_right, bottom: data.margin_bottom, left: data.margin_left };
    const mode = detectMarginMode({ top: data.margin_top, right: data.margin_right, bottom: data.margin_bottom, left: data.margin_left });
    this._marginCtrl.setMode(mode);
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
    this._applyEnableVisibility();
  }

  private _onEnableToggle(enabled: boolean): void {
    if (enabled) {
      const m = this._readCurrentMargins();
      const allZero = (['top', 'right', 'bottom', 'left'] as const)
        .every(k => (m[k] ?? 0) <= 0);
      if (allZero) {
        this._marginCtrl.setMode('all');
        this._setNum('margin-all', SPREAD_MARGIN_DEFAULT_MM);
      }
    } else {
      this._marginCtrl.setMode('all');
      this._setNum('margin-all', 0);
    }
    this._applyEnableVisibility();
    this._emit();
  }

  private _applyEnableVisibility(): void {
    const m = this._readCurrentMargins();
    const marginsOn = (['top', 'right', 'bottom', 'left'] as const)
      .some(k => (m[k] ?? 0) > 0);
    const section = this.containerEl.querySelector<HTMLElement>('[data-section="spread-margin"]');
    const cb = section?.querySelector<HTMLInputElement>('[data-enable="spread-margin"]');
    const body = section?.querySelector<HTMLElement>('.bm-enable-body');
    if (cb) cb.checked = marginsOn;
    if (body) body.hidden = !marginsOn;
  }

  private _setNum(name: string, value: number | null): void {
    setNumField(this.containerEl, name, value);
  }

  private _setColor(name: string, value: string): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value;
  }

  // ---------------------------------------------------------------------------
  // Margin mode selector helpers
  // ---------------------------------------------------------------------------

  private _setMarginMode(mode: MarginMode): void {
    const rank: Record<MarginMode, number> = { all: 1, xy: 2, each: 3 };
    const refining = rank[mode] > rank[this._marginCtrl.mode];
    const prev = this._readCurrentMargins();
    this._marginCtrl.setMode(mode);

    if (mode === 'all') {
      const same = prev.top === prev.right && prev.right === prev.bottom && prev.bottom === prev.left;
      this._setNum('margin-all', same ? prev.top : null);
    } else if (mode === 'xy') {
      const v = prev.top === prev.bottom ? prev.top : null;
      const h = prev.right === prev.left  ? prev.right : null;
      if (!refining || v !== null) this._setNum('margin-v', v);
      if (!refining || h !== null) this._setNum('margin-h', h);
    } else {
      if (prev.top    !== null) this._setNum('margin-top',    prev.top);
      if (prev.right  !== null) this._setNum('margin-right',  prev.right);
      if (prev.bottom !== null) this._setNum('margin-bottom', prev.bottom);
      if (prev.left   !== null) this._setNum('margin-left',   prev.left);
    }
    this._emit();
  }

  private _readCurrentMargins(): { top: number | null; right: number | null; bottom: number | null; left: number | null } {
    const g = (name: string) => readNumField(this.containerEl, name);
    if (this._marginCtrl.mode === 'all') {
      const v = g('margin-all');
      return { top: v, right: v, bottom: v, left: v };
    }
    if (this._marginCtrl.mode === 'xy') {
      const vert  = g('margin-v');
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

  private _emit = debounce(() => {
    const gc = (name: string): string => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
      return el ? el.value : '#ffffff';
    };
    const m = this._readCurrentMargins();
    // Null means a field is in mixed state after a mode switch — preserve last known value.
    const top    = m.top    ?? this._lastMargins.top;
    const right  = m.right  ?? this._lastMargins.right;
    const bottom = m.bottom ?? this._lastMargins.bottom;
    const left   = m.left   ?? this._lastMargins.left;
    this._lastMargins = { top, right, bottom, left };
    this.onChange({
      margin_top:    top,
      margin_right:  right,
      margin_bottom: bottom,
      margin_left:   left,
      left_bg:  gc('left-bg'),
      right_bg: gc('right-bg'),
    });
  }, 150);
}
