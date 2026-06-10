// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).

import type { SpreadSettingsData } from './types.js';
import { colorField, bindInputs } from './ui-fields.js';

export type { SpreadSettingsData };

export class SpreadSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: SpreadSettingsData) => void;
  private _built = false;

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
        <h4>Page backgrounds</h4>
        <div class="bm-grid">
          ${colorField('left-bg',  'Left page')}
          ${colorField('right-bg', 'Right page')}
        </div>
      </div>
    `;
    bindInputs(this.containerEl, () => this._emit(), 'input');
  }

  private _populate(data: SpreadSettingsData): void {
    this._setColor('left-bg',  data.left_bg  || '#ffffff');
    this._setColor('right-bg', data.right_bg || '#ffffff');
  }

  private _setColor(name: string, value: string): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value;
  }

  private _emit(): void {
    const gc = (name: string): string => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
      return el ? el.value : '#ffffff';
    };
    this.onChange({
      left_bg:  gc('left-bg'),
      right_bg: gc('right-bg'),
    });
  }
}
