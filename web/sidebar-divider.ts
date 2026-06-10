// sidebar-divider.ts — DividerPanel (shown in sidebar when a divider is selected).

import type { ChainHalfGaps } from './types.js';

export class DividerPanel {
  private containerEl: HTMLElement;
  private onChangeA: (v: number) => void;
  private onChangeB: (v: number) => void;
  private _built = false;
  private _axis: 'h' | 'v' = 'v';

  constructor(
    containerEl: HTMLElement,
    onChangeA: (v: number) => void,
    onChangeB: (v: number) => void,
  ) {
    this.containerEl = containerEl;
    this.onChangeA = onChangeA;
    this.onChangeB = onChangeB;
  }

  show(data: ChainHalfGaps): void {
    if (!this._built) this._build();
    if (data.axis !== this._axis) {
      this._axis = data.axis;
      this._updateLabels();
    }
    const inputA = this.containerEl.querySelector('#divider-gap-a') as HTMLInputElement;
    const inputB = this.containerEl.querySelector('#divider-gap-b') as HTMLInputElement;
    if (data.a === null) { inputA.value = ''; inputA.placeholder = 'Mixed'; }
    else { inputA.value = data.a.toFixed(2); inputA.placeholder = ''; }
    if (data.b === null) { inputB.value = ''; inputB.placeholder = 'Mixed'; }
    else { inputB.value = data.b.toFixed(2); inputB.placeholder = ''; }
  }

  private _labels(): [string, string] {
    return this._axis === 'v' ? ['Left (mm)', 'Right (mm)'] : ['Top (mm)', 'Bottom (mm)'];
  }

  private _updateLabels(): void {
    const [la, lb] = this._labels();
    const elA = this.containerEl.querySelector('[data-label="a"]');
    const elB = this.containerEl.querySelector('[data-label="b"]');
    if (elA) elA.textContent = la;
    if (elB) elB.textContent = lb;
  }

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'divider';
    const [la, lb] = this._labels();
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Gap (mm)</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label data-label="a">${la}</label>
            <input id="divider-gap-a" type="number" min="-50" max="50" step="0.5" value="0" />
          </div>
          <div class="bm-field">
            <label data-label="b">${lb}</label>
            <input id="divider-gap-b" type="number" min="-50" max="50" step="0.5" value="0" />
          </div>
        </div>
      </div>`;

    const inputA = this.containerEl.querySelector('#divider-gap-a') as HTMLInputElement;
    const inputB = this.containerEl.querySelector('#divider-gap-b') as HTMLInputElement;
    inputA.addEventListener('change', () => {
      const v = parseFloat(inputA.value);
      if (!isNaN(v)) this.onChangeA(v);
    });
    inputB.addEventListener('change', () => {
      const v = parseFloat(inputB.value);
      if (!isNaN(v)) this.onChangeB(v);
    });
  }
}
