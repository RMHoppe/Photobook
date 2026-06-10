// outer-margin-dialog.ts — Floating dialog for setting outer margins of the
// current frame selection. Opened by the outer-margin toolbar button.

import { numField, bindInputs, setNumField, readNumField } from './ui-fields.js';
import {
  MarginModeController, marginSectionHtml, detectSidesMode,
  type Sides, type MarginMode,
} from './margin-mode-controller.js';
import { debounce } from './utils.js';

export class OuterMarginDialog {
  private readonly _el: HTMLElement;
  private readonly _onChange: (margins: Sides) => void;
  private _ctrl!: MarginModeController;
  private _built = false;

  constructor(el: HTMLElement, onChange: (margins: Sides) => void) {
    this._el = el;
    this._onChange = onChange;
  }

  show(initial: Sides): void {
    if (!this._built) this._build();
    this._updateUI(initial);
    this._el.hidden = false;
  }

  hide(): void {
    this._el.hidden = true;
  }

  get isVisible(): boolean { return !this._el.hidden; }

  /** Current field values (for reading defaults when re-activating). */
  getValues(): Sides {
    if (!this._built) return { top: 5, right: 5, bottom: 5, left: 5 };
    return this._readSides();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _build(): void {
    this._built = true;
    this._el.innerHTML = `
      <div class="om-title">Outer Margins (mm)</div>
      ${marginSectionHtml('', (name, label) => numField(name, label, { min: 0 }), 'om')}
    `;

    bindInputs(this._el, () => this._emitDebounced());

    this._ctrl = new MarginModeController(this._el, 'om');
    this._ctrl.bindButtons(mode => this._onModeChange(mode));
  }

  private _updateUI(m: Sides): void {
    const mode = detectSidesMode(m);
    this._ctrl.setMode(mode);
    if (mode === 'all') {
      setNumField(this._el, 'om-all', m.top);
    } else if (mode === 'xy') {
      setNumField(this._el, 'om-v', m.top);
      setNumField(this._el, 'om-h', m.right);
    } else {
      setNumField(this._el, 'om-top',    m.top);
      setNumField(this._el, 'om-right',  m.right);
      setNumField(this._el, 'om-bottom', m.bottom);
      setNumField(this._el, 'om-left',   m.left);
    }
  }

  private _onModeChange(mode: MarginMode): void {
    const prev = this._readSides();
    const prevMode = this._ctrl.mode;
    this._ctrl.setMode(mode);
    const refining = { all: 1, xy: 2, each: 3 }[mode] > { all: 1, xy: 2, each: 3 }[prevMode];

    if (mode === 'all') {
      const same = prev.top === prev.right && prev.right === prev.bottom && prev.bottom === prev.left;
      setNumField(this._el, 'om-all', same ? prev.top : null);
    } else if (mode === 'xy') {
      const v = prev.top === prev.bottom ? prev.top : null;
      const h = prev.right === prev.left  ? prev.right : null;
      if (!refining || v !== null) setNumField(this._el, 'om-v', v);
      if (!refining || h !== null) setNumField(this._el, 'om-h', h);
    } else {
      if (prev.top    !== null) setNumField(this._el, 'om-top',    prev.top);
      if (prev.right  !== null) setNumField(this._el, 'om-right',  prev.right);
      if (prev.bottom !== null) setNumField(this._el, 'om-bottom', prev.bottom);
      if (prev.left   !== null) setNumField(this._el, 'om-left',   prev.left);
    }
    this._emitDebounced();
  }

  private _readSides(): Sides {
    if (this._ctrl.mode === 'all') {
      const v = readNumField(this._el, 'om-all');
      return { top: v, right: v, bottom: v, left: v };
    }
    if (this._ctrl.mode === 'xy') {
      const v = readNumField(this._el, 'om-v');
      const h = readNumField(this._el, 'om-h');
      return { top: v, right: h, bottom: v, left: h };
    }
    return {
      top:    readNumField(this._el, 'om-top'),
      right:  readNumField(this._el, 'om-right'),
      bottom: readNumField(this._el, 'om-bottom'),
      left:   readNumField(this._el, 'om-left'),
    };
  }

  private _emitDebounced = debounce(() => {
    this._onChange(this._readSides());
  }, 120);
}
