// randomize-layout-dialog.ts — Floating dialog for the Randomize Layout tool.
// Shows min/max ranges for gap and rotation; a Re-roll button triggers a new
// randomization pass with the current settings.

import { numField, bindInputs, setNumField, readNumField } from './ui-fields.js';

export interface RandomizeLayoutValues {
  gapMin:  number;
  gapMax:  number;
  rotMin:  number;
  rotMax:  number;
}

const DEFAULTS: RandomizeLayoutValues = {
  gapMin: 0,
  gapMax: 6,
  rotMin: -5,
  rotMax: 5,
};

export class RandomizeLayoutDialog {
  private readonly _el: HTMLElement;
  private readonly _onReroll: (values: RandomizeLayoutValues) => void;
  private _built = false;

  constructor(el: HTMLElement, onReroll: (values: RandomizeLayoutValues) => void) {
    this._el = el;
    this._onReroll = onReroll;
  }

  show(initial?: Partial<RandomizeLayoutValues>): void {
    if (!this._built) this._build();
    if (initial) this._setValues({ ...DEFAULTS, ...initial });
    this._el.hidden = false;
  }

  hide(): void { this._el.hidden = true; }

  get isVisible(): boolean { return !this._el.hidden; }

  getValues(): RandomizeLayoutValues {
    if (!this._built) return { ...DEFAULTS };
    return {
      gapMin: readNumField(this._el, 'rl-gap-min') ?? DEFAULTS.gapMin,
      gapMax: readNumField(this._el, 'rl-gap-max') ?? DEFAULTS.gapMax,
      rotMin: readNumField(this._el, 'rl-rot-min') ?? DEFAULTS.rotMin,
      rotMax: readNumField(this._el, 'rl-rot-max') ?? DEFAULTS.rotMax,
    };
  }

  private _setValues(v: RandomizeLayoutValues): void {
    setNumField(this._el, 'rl-gap-min', v.gapMin);
    setNumField(this._el, 'rl-gap-max', v.gapMax);
    setNumField(this._el, 'rl-rot-min', v.rotMin);
    setNumField(this._el, 'rl-rot-max', v.rotMax);
  }

  private _build(): void {
    this._built = true;
    this._el.innerHTML = `
      <div class="tool-dialog-header">
        <span class="tool-dialog-title">Randomize Layout</span>
      </div>
      <div class="rl-section">
        <div class="tool-dialog-section-label">Gap (mm)</div>
        <div class="bm-grid">
          ${numField('rl-gap-min', 'Min', { min: null, max: 50, step: 0.5 })}
          ${numField('rl-gap-max', 'Max', { min: null, max: 50, step: 0.5 })}
        </div>
      </div>
      <div class="rl-section">
        <div class="tool-dialog-section-label">Rotation (°)</div>
        <div class="bm-grid">
          ${numField('rl-rot-min', 'Min', { min: null, max: 45, step: 0.5 })}
          ${numField('rl-rot-max', 'Max', { min: null, max: 45, step: 0.5 })}
        </div>
      </div>
      <button class="rl-reroll-btn">Re-roll</button>
    `;
    this._setValues(DEFAULTS);

    this._el.querySelector('.rl-reroll-btn')!.addEventListener('click', () => {
      this._onReroll(this.getValues());
    });
  }
}
