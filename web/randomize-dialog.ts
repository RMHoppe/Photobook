import { getAllSelected } from './wasm-bridge.js';
import type { PhotobookEditor } from './pkg/photobook_core.js';

const DEFAULTS: Record<string, { title: string; min: string; max: string; step: string }> = {
  rotation:        { title: 'Randomize Rotation',        min: '-5',  max: '5',   step: '0.5' },
  'margin-all':    { title: 'Randomize Margin',           min: '-10', max: '0',   step: '0.5' },
  'margin-v':      { title: 'Randomize Vertical Margin',  min: '-10', max: '0',   step: '0.5' },
  'margin-h':      { title: 'Randomize Horiz. Margin',    min: '-10', max: '0',   step: '0.5' },
  'margin-top':    { title: 'Randomize Top Margin',       min: '-10', max: '0',   step: '0.5' },
  'margin-right':  { title: 'Randomize Right Margin',     min: '-10', max: '0',   step: '0.5' },
  'margin-bottom': { title: 'Randomize Bottom Margin',    min: '-10', max: '0',   step: '0.5' },
  'margin-left':   { title: 'Randomize Left Margin',      min: '-10', max: '0',   step: '0.5' },
  'bw-all':        { title: 'Randomize Border Width',     min: '0',   max: '3',   step: '0.5' },
  'bw-v':          { title: 'Randomize Vert. Border',     min: '0',   max: '3',   step: '0.5' },
  'bw-h':          { title: 'Randomize Horiz. Border',    min: '0',   max: '3',   step: '0.5' },
  'bw-top':        { title: 'Randomize Top Border',       min: '0',   max: '3',   step: '0.5' },
  'bw-right':      { title: 'Randomize Right Border',     min: '0',   max: '3',   step: '0.5' },
  'bw-bottom':     { title: 'Randomize Bottom Border',    min: '0',   max: '3',   step: '0.5' },
  'bw-left':       { title: 'Randomize Left Border',      min: '0',   max: '3',   step: '0.5' },
  'border-radius': { title: 'Randomize Corner Radius',    min: '0',   max: '10',  step: '0.5' },
  'radius-all':    { title: 'Randomize Corner Radius',    min: '0',   max: '15',  step: '0.5' },
  'radius-v':      { title: 'Randomize TL+BR Radius',     min: '0',   max: '15',  step: '0.5' },
  'radius-h':      { title: 'Randomize TR+BL Radius',     min: '0',   max: '15',  step: '0.5' },
  'radius-top':    { title: 'Randomize Top-Left',         min: '0',   max: '15',  step: '0.5' },
  'radius-right':  { title: 'Randomize Top-Right',        min: '0',   max: '15',  step: '0.5' },
  'radius-bottom': { title: 'Randomize Bottom-Right',     min: '0',   max: '15',  step: '0.5' },
  'radius-left':   { title: 'Randomize Bottom-Left',      min: '0',   max: '15',  step: '0.5' },
};

export class RandomizeDialog {
  private _el: HTMLDivElement;
  private _field = 'rotation';

  constructor(
    container: HTMLElement,
    private _editor: PhotobookEditor,
    private _onApply: (nodeIds: number[], min: number, max: number, field: string) => void,
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
      this._onApply(selected, min, max, this._field);
    });
  }

  show(field: string): void {
    this._field = field;
    const d = DEFAULTS[field] ?? DEFAULTS['rotation'];
    this._el.querySelector<HTMLElement>('#rd-title')!.textContent = d.title;
    const minEl = this._el.querySelector<HTMLInputElement>('#rd-min')!;
    const maxEl = this._el.querySelector<HTMLInputElement>('#rd-max')!;
    minEl.value = d.min; minEl.step = d.step;
    maxEl.value = d.max; maxEl.step = d.step;
    this._el.hidden = false;
  }
}
