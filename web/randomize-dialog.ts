import { getAllSelected } from './wasm-bridge.js';
import type { PhotobookEditor } from './pkg/photobook_core.js';

const DEFAULTS: Record<string, { title: string; min: string; max: string; step: string }> = {
  rotation: { title: 'Randomize Rotation', min: '-15', max: '15', step: '0.5' },
};

export class RandomizeDialog {
  private _el: HTMLDivElement;

  constructor(
    container: HTMLElement,
    private _editor: PhotobookEditor,
    private _onApply: (nodeIds: number[], min: number, max: number) => void,
  ) {
    this._el = document.createElement('div');
    this._el.id = 'randomize-dialog';
    this._el.hidden = true;
    this._el.innerHTML = `
      <h5 id="rd-title">Randomize</h5>
      <div class="rd-row"><label>Min</label><input id="rd-min" type="number" step="0.01" value="0" /></div>
      <div class="rd-row"><label>Max</label><input id="rd-max" type="number" step="0.01" value="1" /></div>
      <div class="rd-actions">
        <button id="rd-cancel">Cancel</button>
        <button id="rd-apply">Apply</button>
      </div>
    `;
    container.appendChild(this._el);

    this._el.querySelector('#rd-cancel')!.addEventListener('click', () => {
      this._el.hidden = true;
    });

    this._el.querySelector('#rd-apply')!.addEventListener('click', () => {
      this._el.hidden = true;
      const min = parseFloat((this._el.querySelector<HTMLInputElement>('#rd-min')!).value);
      const max = parseFloat((this._el.querySelector<HTMLInputElement>('#rd-max')!).value);
      if (isNaN(min) || isNaN(max) || min > max) return;
      const selected = getAllSelected(this._editor);
      if (selected.length < 2) return;
      this._onApply(selected, min, max);
    });
  }

  show(field: 'rotation'): void {
    const d = DEFAULTS[field];
    this._el.querySelector<HTMLElement>('#rd-title')!.textContent = d.title;
    const minEl = this._el.querySelector<HTMLInputElement>('#rd-min')!;
    const maxEl = this._el.querySelector<HTMLInputElement>('#rd-max')!;
    minEl.value = d.min; minEl.step = d.step;
    maxEl.value = d.max; maxEl.step = d.step;
    this._el.hidden = false;
  }
}
