// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).

import type { SpreadSettingsData } from './types.js';
import { colorField, bindInputs } from './ui-fields.js';

export type { SpreadSettingsData };

export class SpreadSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: SpreadSettingsData) => void;
  /** Layout currently built: 'two' (left/right pages), 'one' (single page), or null. */
  private _builtMode: 'one' | 'two' | null = null;

  constructor(containerEl: HTMLElement, onChange: (data: SpreadSettingsData) => void) {
    this.containerEl = containerEl;
    this.onChange = onChange;
  }

  /** `singlePage` — standalone front/back cover page (one background field). */
  show(data: SpreadSettingsData, singlePage = false): void {
    const mode = singlePage ? 'one' : 'two';
    if (this._builtMode !== mode) this._build(mode);
    this._populate(data);
  }

  private _build(mode: 'one' | 'two'): void {
    this._builtMode = mode;
    const fields = mode === 'one'
      ? colorField('left-bg', 'Page')
      : `${colorField('left-bg',  'Left page')}
         ${colorField('right-bg', 'Right page')}`;
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>${mode === 'one' ? 'Page background' : 'Page backgrounds'}</h4>
        <div class="bm-grid">
          ${fields}
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
    const gc = (name: string): string | null => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
      return el ? el.value : null;
    };
    const left = gc('left-bg') ?? '#ffffff';
    // Single-page spreads keep left_bg == right_bg (one page, one colour).
    this.onChange({
      left_bg:  left,
      right_bg: gc('right-bg') ?? left,
    });
  }
}
