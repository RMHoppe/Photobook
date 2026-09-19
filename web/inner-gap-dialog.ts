// inner-gap-dialog.ts — Floating dialog for setting inner gaps of the current
// frame selection. Opened by the inner-gap toolbar button.

import { numField, bindInputs, setNumField, readNumField } from './ui-fields.js';
import { MarginModeController, type MarginMode } from './margin-mode-controller.js';
import { debounce } from './utils.js';
import type { InnerGaps } from './types.js';

type GapMode = 'all' | 'xy';

function detectGapMode(gaps: InnerGaps): GapMode {
  return gaps.h === gaps.v ? 'all' : 'xy';
}

export class InnerGapDialog {
  private readonly _el: HTMLElement;
  private readonly _onChange: (gaps: InnerGaps) => void;
  private _ctrl!: MarginModeController;
  private _built = false;

  constructor(el: HTMLElement, onChange: (gaps: InnerGaps) => void) {
    this._el = el;
    this._onChange = onChange;
  }

  show(initial: InnerGaps): void {
    if (!this._built) this._build();
    this._updateUI(initial);
    this._el.hidden = false;
  }

  hide(): void {
    this._el.hidden = true;
  }

  get isVisible(): boolean { return !this._el.hidden; }

  getValues(): InnerGaps {
    if (!this._built) return { h: 0, v: 0 };
    return this._readGaps();
  }

  private _build(): void {
    this._built = true;
    this._el.innerHTML = `
      <div class="tool-dialog-header">
        <span class="tool-dialog-title">Inner Gaps (mm)</span>
        <div class="margin-mode-bar">
          <button class="margin-mode-btn" data-ig-mode="all" title="All equal"><i class="ti ti-square"></i></button>
          <button class="margin-mode-btn" data-ig-mode="xy"  title="H and V separately"><i class="ti ti-border-style"></i></button>
        </div>
      </div>
      <div class="margin-pane" data-ig-pane="all">
        <div class="bm-grid">${numField('ig-all', 'All', { min: 0, fullWidth: true })}</div>
      </div>
      <div class="margin-pane" data-ig-pane="xy">
        <div class="bm-grid">
          ${numField('ig-h', '↔ H', { min: 0 })}
          ${numField('ig-v', '↕ V', { min: 0 })}
        </div>
      </div>
    `;
    bindInputs(this._el, () => this._emitDebounced());
    this._ctrl = new MarginModeController(this._el, 'ig');
    this._ctrl.bindButtons(mode => this._onModeChange(mode as GapMode));
  }

  private _updateUI(gaps: InnerGaps): void {
    const mode = detectGapMode(gaps);
    this._ctrl.setMode(mode);
    if (mode === 'all') {
      setNumField(this._el, 'ig-all', gaps.h);
    } else {
      setNumField(this._el, 'ig-h', gaps.h);
      setNumField(this._el, 'ig-v', gaps.v);
    }
  }

  private _onModeChange(mode: GapMode): void {
    const prev = this._readGaps();
    this._ctrl.setMode(mode);
    if (mode === 'all') {
      const same = prev.h === prev.v;
      setNumField(this._el, 'ig-all', same ? prev.h : null);
    } else {
      setNumField(this._el, 'ig-h', prev.h);
      setNumField(this._el, 'ig-v', prev.v);
    }
    this._emitDebounced();
  }

  private _readGaps(): InnerGaps {
    if ((this._ctrl.mode as GapMode) === 'all') {
      const v = readNumField(this._el, 'ig-all');
      return { h: v, v };
    }
    return {
      h: readNumField(this._el, 'ig-h'),
      v: readNumField(this._el, 'ig-v'),
    };
  }

  private _emitDebounced = debounce(() => {
    this._onChange(this._readGaps());
  }, 120);
}
