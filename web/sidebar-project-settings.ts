// sidebar-project-settings.ts — ProjectSettingsPanel (rendered inside the project settings modal).

import type { ProjectSettingsData } from './types.js';
export type { ProjectSettingsData };

export class ProjectSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: ProjectSettingsData) => void;
  private onToggleBleed:    ((show: boolean) => void) | null = null;
  private onToggleSafeZone: ((show: boolean) => void) | null = null;
  private _built = false;
  private _emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(containerEl: HTMLElement, onChange: (data: ProjectSettingsData) => void) {
    this.containerEl = containerEl;
    this.onChange = onChange;
  }

  setBleedToggleHandler(handler: (show: boolean) => void): void {
    this.onToggleBleed = handler;
  }

  setSafeZoneToggleHandler(handler: (show: boolean) => void): void {
    this.onToggleSafeZone = handler;
  }

  setBleedVisible(visible: boolean): void {
    const chk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-bleed');
    if (chk) chk.checked = visible;
  }

  setSafeZoneVisible(visible: boolean): void {
    const chk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-safe-zone');
    if (chk) chk.checked = visible;
  }

  show(data: ProjectSettingsData): void {
    if (!this._built || this.containerEl.dataset.panel !== 'project') this._build();
    this._populate(data);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'project';
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Page size (mm)</h4>
        <div class="bm-grid">
          ${this._field('page-w', 'Width',  1, 600)}
          ${this._field('page-h', 'Height', 1, 600)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Print</h4>
        <div class="bm-grid">
          ${this._field('bleed',     'Bleed (mm)',    0, 20,   0.5)}
          ${this._field('safe',      'Safe zone (mm)',0, 30,   0.5)}
          ${this._field('print-dpi', 'DPI',          72, 1200, 1)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Spine</h4>
        <div class="bm-grid">
          ${this._field('spine-per-page', 'Per page (mm)', 0, 2,  0.01)}
          ${this._field('spine-min',      'Minimum (mm)',  0, 50, 0.5)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Editing</h4>
        <div class="bm-grid">
          ${this._field('margin-step', 'Margin step (mm)', 0, 20, 0.5)}
        </div>
      </div>
      <div class="bm-section">
        <h4>View</h4>
        <label class="ps-toggle-row">
          <input type="checkbox" id="ps-show-bleed" checked />
          Show bleed area
        </label>
        <label class="ps-toggle-row">
          <input type="checkbox" id="ps-show-safe-zone" checked />
          Show safe zone
        </label>
      </div>
    `;

    this.containerEl.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach(el => {
      el.addEventListener('change', () => this._emit());
      el.addEventListener('input',  () => this._emit());
    });

    const bleedChk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-bleed')!;
    bleedChk.addEventListener('change', () => {
      this.onToggleBleed?.(bleedChk.checked);
    });

    const safeChk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-safe-zone')!;
    safeChk.addEventListener('change', () => {
      this.onToggleSafeZone?.(safeChk.checked);
    });
  }

  private _populate(data: ProjectSettingsData): void {
    this._set('page-w',          data.page_width_mm);
    this._set('page-h',          data.page_height_mm);
    this._set('bleed',           data.bleed_mm);
    this._set('safe',            data.safe_zone_mm);
    this._set('spine-per-page',  data.spine_mm_per_page);
    this._set('spine-min',       data.spine_min_mm);
    this._set('margin-step',     data.margin_step_mm);
    this._set('print-dpi',       data.print_dpi);
  }

  private _set(name: string, value: number): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el) return;
    el.value = value.toFixed(el.step && parseFloat(el.step) < 1 ? 2 : 0);
  }

  private _field(
    name: string,
    label: string,
    min = 0,
    max = 9999,
    step = 1,
  ): string {
    return `<div class="bm-field">
      <label>${label}</label>
      <input type="number" min="${min}" max="${max}" step="${step}" data-field="${name}" value="0" />
    </div>`;
  }

  private _emit(): void {
    if (this._emitTimer !== null) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      const g = (name: string): number => {
        const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
        if (!el) return 0;
        const v = parseFloat(el.value);
        return isNaN(v) ? 0 : v;
      };
      this.onChange({
        page_width_mm:     g('page-w'),
        page_height_mm:    g('page-h'),
        bleed_mm:          g('bleed'),
        safe_zone_mm:      g('safe'),
        spine_mm_per_page: g('spine-per-page'),
        spine_min_mm:      g('spine-min'),
        margin_step_mm:    g('margin-step'),
        print_dpi:         g('print-dpi'),
      });
    }, 150);
  }
}
