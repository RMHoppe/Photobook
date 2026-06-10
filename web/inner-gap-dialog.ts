// inner-gap-dialog.ts — Floating dialog for setting inner gaps of the current
// frame selection. Opened by the inner-gap toolbar button.

import { numField, bindInputs, setNumField, readNumField } from './ui-fields.js';
import { debounce } from './utils.js';
import type { InnerGaps } from './types.js';

export class InnerGapDialog {
  private readonly _el: HTMLElement;
  private readonly _onChange: (gaps: InnerGaps) => void;
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
      <div class="ig-title">Inner Gaps (mm)</div>
      <div class="ig-fields">
        ${numField('ig-h', '↔ H', { min: 0 })}
        ${numField('ig-v', '↕ V', { min: 0 })}
      </div>
    `;
    bindInputs(this._el, () => this._emitDebounced());
  }

  private _updateUI(gaps: InnerGaps): void {
    setNumField(this._el, 'ig-h', gaps.h);
    setNumField(this._el, 'ig-v', gaps.v);
  }

  private _readGaps(): InnerGaps {
    return {
      h: readNumField(this._el, 'ig-h'),
      v: readNumField(this._el, 'ig-v'),
    };
  }

  private _emitDebounced = debounce(() => {
    this._onChange(this._readGaps());
  }, 120);
}
