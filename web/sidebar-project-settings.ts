// sidebar-project-settings.ts — ProjectSettingsPanel (rendered inside the project settings modal).

import type { ProjectSettingsData } from './types.js';
import { debounce } from './utils.js';
import { numField, wrapField, bindInputs } from './ui-fields.js';
import { PRINT_SHOP_SPECS, getPrintShopSpec } from './print-shop-specs.js';
export type { ProjectSettingsData };

export type PageFormat = { value: string; label: string; w: number; h: number };

export const PAGE_FORMAT_GROUPS: { label: string; formats: PageFormat[] }[] = [
  { label: 'Square', formats: [
    { value: 'sq200', label: '20 × 20 cm (200 × 200 mm)', w: 200, h: 200 },
    { value: 'sq250', label: '25 × 25 cm (250 × 250 mm)', w: 250, h: 250 },
    { value: 'sq300', label: '30 × 30 cm (300 × 300 mm)', w: 300, h: 300 },
  ]},
  { label: 'Portrait', formats: [
    { value: 'a5-p',     label: 'A5 (148 × 210 mm)',        w: 148, h: 210 },
    { value: 'a4-p',     label: 'A4 (210 × 297 mm)',        w: 210, h: 297 },
    { value: 'a3-p',     label: 'A3 (297 × 420 mm)',        w: 297, h: 420 },
    { value: 'letter-p', label: 'US Letter (216 × 279 mm)', w: 216, h: 279 },
  ]},
  { label: 'Landscape', formats: [
    { value: 'a5-l',     label: 'A5 (210 × 148 mm)',        w: 210, h: 148 },
    { value: 'a4-l',     label: 'A4 (297 × 210 mm)',        w: 297, h: 210 },
    { value: 'a3-l',     label: 'A3 (420 × 297 mm)',        w: 420, h: 297 },
    { value: 'letter-l', label: 'US Letter (279 × 216 mm)', w: 279, h: 216 },
  ]},
];

// Flat list used for dimension look-ups in _populate().
const PAGE_FORMATS: PageFormat[] = PAGE_FORMAT_GROUPS.flatMap(g => g.formats);

function pageFormatOptionsHtml(): string {
  return PAGE_FORMAT_GROUPS.map(g =>
    `<optgroup label="${g.label}">${
      g.formats.map(f => `<option value="${f.value}">${f.label}</option>`).join('')
    }</optgroup>`,
  ).join('') + '<option value="custom">Custom</option>';
}

export class ProjectSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: ProjectSettingsData) => void;
  private onToggleBleed:    ((show: boolean) => void) | null = null;
  private onToggleSafeZone: ((show: boolean) => void) | null = null;
  private onToggleEndpapers: ((enabled: boolean) => void) | null = null;
  private _built = false;

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

  setEndpapersToggleHandler(handler: (enabled: boolean) => void): void {
    this.onToggleEndpapers = handler;
  }

  setBleedVisible(visible: boolean): void {
    const chk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-bleed');
    if (chk) chk.checked = visible;
  }

  setSafeZoneVisible(visible: boolean): void {
    const chk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-safe-zone');
    if (chk) chk.checked = visible;
  }

  setEndpapersEnabled(enabled: boolean): void {
    const chk = this.containerEl.querySelector<HTMLInputElement>('#ps-endpapers');
    if (chk) chk.checked = enabled;
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
    const specOptions = '<option value="">Custom settings</option>' +
      PRINT_SHOP_SPECS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    this.containerEl.innerHTML = `
      <div class="ps-two-col">
        <div class="ps-col">
          <div class="bm-section">
            <h4>Print shop preset</h4>
            <div class="bm-grid">
              ${wrapField('Preset', `<select id="ps-print-spec">${specOptions}</select>`, true)}
            </div>
          </div>
          <div class="bm-section">
            <h4>Page size</h4>
            <div class="bm-grid">
              ${wrapField('Format', `<select id="ps-format">${pageFormatOptionsHtml()}</select>`, true)}
            </div>
            <div id="ps-custom-size" class="bm-grid" hidden>
              ${numField('page-w', 'Width (mm)',  { min: 1, max: 600, step: 1 })}
              ${numField('page-h', 'Height (mm)', { min: 1, max: 600, step: 1 })}
            </div>
          </div>
          <div class="bm-section">
            <h4>Print</h4>
            <div class="bm-grid">
              ${numField('bleed',     'Bleed (mm)',     { min: 0, max: 20,   step: 0.5 })}
              ${numField('safe',      'Safe zone (mm)', { min: 0, max: 30,   step: 0.5 })}
              ${numField('print-dpi', 'DPI',            { min: 72, max: 1200, step: 1  })}
            </div>
          </div>
          <div class="bm-section">
            <h4>Spine</h4>
            <div class="bm-grid">
              ${numField('spine-per-page', 'Per page (mm)', { min: 0, max: 2,  step: 0.01 })}
              ${numField('spine-min',      'Minimum (mm)',  { min: 0, max: 50, step: 0.5  })}
            </div>
          </div>
        </div>
        <div class="ps-col">
          <div class="bm-section">
            <h4>Binding</h4>
            <label class="ps-toggle-row">
              <input type="checkbox" id="ps-endpapers" />
              Endpapers (non-printable inner pages)
            </label>
          </div>
          <div class="bm-section">
            <h4>Export</h4>
            <label class="ps-toggle-row">
              <input type="checkbox" id="ps-split-cover" />
              Separate cover PDF
            </label>
            <label class="ps-toggle-row">
              <input type="checkbox" id="ps-body-pages" />
              Interior as single pages
            </label>
            <label class="ps-toggle-row">
              <input type="checkbox" id="ps-cover-pages" />
              Cover as front &amp; back pages
            </label>
            <label class="ps-toggle-row">
              <input type="checkbox" id="ps-crop-marks" />
              Crop marks
            </label>
            <div class="bm-grid">
              ${numField('cover-wrap', 'Cover wrap (mm)', { min: 0, max: 30, step: 0.5 })}
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
        </div>
      </div>
    `;

    bindInputs(this.containerEl, () => this._emit(), 'input[type="number"]');

    const formatSel  = this.containerEl.querySelector<HTMLSelectElement>('#ps-format')!;
    const customSize = this.containerEl.querySelector<HTMLElement>('#ps-custom-size')!;
    formatSel.addEventListener('change', () => {
      const fmt = PAGE_FORMATS.find(f => f.value === formatSel.value);
      if (!fmt || fmt.value === 'custom') {
        customSize.hidden = false;
        return;
      }
      customSize.hidden = true;
      this._set('page-w', fmt.w);
      this._set('page-h', fmt.h);
      this._emit();
    });

    const bleedChk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-bleed')!;
    bleedChk.addEventListener('change', () => {
      this.onToggleBleed?.(bleedChk.checked);
    });

    const safeChk = this.containerEl.querySelector<HTMLInputElement>('#ps-show-safe-zone')!;
    safeChk.addEventListener('change', () => {
      this.onToggleSafeZone?.(safeChk.checked);
    });

    const endpapersChk = this.containerEl.querySelector<HTMLInputElement>('#ps-endpapers')!;
    endpapersChk.addEventListener('change', () => {
      this.onToggleEndpapers?.(endpapersChk.checked);
    });

    // Export option checkboxes go through the regular settings change path.
    for (const id of ['ps-split-cover', 'ps-body-pages', 'ps-cover-pages', 'ps-crop-marks']) {
      this.containerEl.querySelector<HTMLInputElement>(`#${id}`)!
        .addEventListener('change', () => this._emit());
    }

    // Selecting a print-shop preset asks for confirmation, then prefills settings.
    const specSel = this.containerEl.querySelector<HTMLSelectElement>('#ps-print-spec')!;
    let _prevSpecValue = specSel.value;
    specSel.addEventListener('change', () => {
      const spec = getPrintShopSpec(specSel.value);
      if (!spec) {
        // Switching to "Custom settings" — no confirmation needed.
        _prevSpecValue = specSel.value;
        this._emit();
        return;
      }
      if (!confirm(`Apply preset "${spec.name}"?\n\nThis will overwrite your current page size, bleed, DPI, and export settings.`)) {
        specSel.value = _prevSpecValue;
        return;
      }
      _prevSpecValue = specSel.value;
      this._applySpecSettings(spec.settings);
      this._emit();
    });
  }

  private _applySpecSettings(s: Partial<ProjectSettingsData>): void {
    const num: [keyof ProjectSettingsData, string][] = [
      ['page_width_mm', 'page-w'], ['page_height_mm', 'page-h'],
      ['bleed_mm', 'bleed'], ['safe_zone_mm', 'safe'],
      ['spine_mm_per_page', 'spine-per-page'], ['spine_min_mm', 'spine-min'],
      ['print_dpi', 'print-dpi'], ['cover_wrap_mm', 'cover-wrap'],
    ];
    for (const [key, field] of num) {
      const v = s[key];
      if (typeof v === 'number') this._set(field, v);
    }
    if (typeof s.export_split_cover === 'boolean') this._setChecked('ps-split-cover', s.export_split_cover);
    if (typeof s.export_body_pages  === 'boolean') this._setChecked('ps-body-pages',  s.export_body_pages);
    if (typeof s.export_cover_pages === 'boolean') this._setChecked('ps-cover-pages', s.export_cover_pages);
    if (typeof s.export_crop_marks  === 'boolean') this._setChecked('ps-crop-marks',  s.export_crop_marks);

    // Page-size selector: reflect the spec's size (or switch to Custom).
    if (typeof s.page_width_mm === 'number' && typeof s.page_height_mm === 'number') {
      const fmt = PAGE_FORMATS.find(f => f.w === s.page_width_mm && f.h === s.page_height_mm);
      const formatSel  = this.containerEl.querySelector<HTMLSelectElement>('#ps-format');
      const customSize = this.containerEl.querySelector<HTMLElement>('#ps-custom-size');
      if (formatSel && customSize) {
        formatSel.value   = fmt ? fmt.value : 'custom';
        customSize.hidden = fmt !== undefined;
      }
    }

    // Endpapers have document side effects, so they go through their
    // dedicated toggle handler rather than the settings change path.
    if (typeof s.endpapers === 'boolean') {
      const chk = this.containerEl.querySelector<HTMLInputElement>('#ps-endpapers');
      if (chk && chk.checked !== s.endpapers) {
        chk.checked = s.endpapers;
        this.onToggleEndpapers?.(s.endpapers);
      }
    }
  }

  private _populate(data: ProjectSettingsData): void {
    this._set('page-w', data.page_width_mm);
    this._set('page-h', data.page_height_mm);

    const fmt = PAGE_FORMATS.find(
      f => f.value !== 'custom' && f.w === data.page_width_mm && f.h === data.page_height_mm,
    );
    const formatSel  = this.containerEl.querySelector<HTMLSelectElement>('#ps-format');
    const customSize = this.containerEl.querySelector<HTMLElement>('#ps-custom-size');
    if (formatSel && customSize) {
      formatSel.value  = fmt ? fmt.value : 'custom';
      customSize.hidden = fmt !== undefined;
    }

    this._set('bleed',           data.bleed_mm);
    this._set('safe',            data.safe_zone_mm);
    this._set('spine-per-page',  data.spine_mm_per_page);
    this._set('spine-min',       data.spine_min_mm);
    this._set('print-dpi',       data.print_dpi);
    this._set('cover-wrap',      data.cover_wrap_mm);
    this._setChecked('ps-endpapers',   data.endpapers);
    this._setChecked('ps-split-cover', data.export_split_cover);
    this._setChecked('ps-body-pages',  data.export_body_pages);
    this._setChecked('ps-cover-pages', data.export_cover_pages);
    this._setChecked('ps-crop-marks',  data.export_crop_marks);

    const specSel = this.containerEl.querySelector<HTMLSelectElement>('#ps-print-spec');
    if (specSel) specSel.value = getPrintShopSpec(data.print_spec_id) ? data.print_spec_id : '';
  }

  private _setChecked(id: string, checked: boolean): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`#${id}`);
    if (el) el.checked = checked;
  }

  private _set(name: string, value: number): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el) return;
    el.value = value.toFixed(el.step && parseFloat(el.step) < 1 ? 2 : 0);
  }

  private _emit = debounce(() => {
    const g = (name: string): number => {
      const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
      if (!el) return 0;
      const v = parseFloat(el.value);
      return isNaN(v) ? 0 : v;
    };
    const checked = (id: string): boolean =>
      this.containerEl.querySelector<HTMLInputElement>(`#${id}`)?.checked ?? false;
    this.onChange({
      page_width_mm:     g('page-w'),
      page_height_mm:    g('page-h'),
      bleed_mm:          g('bleed'),
      safe_zone_mm:      g('safe'),
      spine_mm_per_page: g('spine-per-page'),
      spine_min_mm:      g('spine-min'),
      print_dpi:         g('print-dpi'),
      endpapers:         checked('ps-endpapers'),
      export_crop_marks:  checked('ps-crop-marks'),
      export_split_cover: checked('ps-split-cover'),
      export_body_pages:  checked('ps-body-pages'),
      export_cover_pages: checked('ps-cover-pages'),
      cover_wrap_mm:      g('cover-wrap'),
      print_spec_id:      this.containerEl.querySelector<HTMLSelectElement>('#ps-print-spec')?.value ?? '',
    });
  }, 150);
}
