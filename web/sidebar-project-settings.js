// sidebar-project-settings.ts — ProjectSettingsPanel (rendered inside the project settings modal).
import { debounce } from './utils.js';
import { numField, bindInputs } from './ui-fields.js';
export class ProjectSettingsPanel {
    containerEl;
    onChange;
    onToggleBleed = null;
    onToggleSafeZone = null;
    onToggleEndpapers = null;
    _built = false;
    constructor(containerEl, onChange) {
        this.containerEl = containerEl;
        this.onChange = onChange;
    }
    setBleedToggleHandler(handler) {
        this.onToggleBleed = handler;
    }
    setSafeZoneToggleHandler(handler) {
        this.onToggleSafeZone = handler;
    }
    setEndpapersToggleHandler(handler) {
        this.onToggleEndpapers = handler;
    }
    setBleedVisible(visible) {
        const chk = this.containerEl.querySelector('#ps-show-bleed');
        if (chk)
            chk.checked = visible;
    }
    setSafeZoneVisible(visible) {
        const chk = this.containerEl.querySelector('#ps-show-safe-zone');
        if (chk)
            chk.checked = visible;
    }
    setEndpapersEnabled(enabled) {
        const chk = this.containerEl.querySelector('#ps-endpapers');
        if (chk)
            chk.checked = enabled;
    }
    show(data) {
        if (!this._built || this.containerEl.dataset.panel !== 'project')
            this._build();
        this._populate(data);
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    _build() {
        this._built = true;
        this.containerEl.dataset.panel = 'project';
        this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Page size (mm)</h4>
        <div class="bm-grid">
          ${numField('page-w', 'Width', { min: 1, max: 600, step: 1 })}
          ${numField('page-h', 'Height', { min: 1, max: 600, step: 1 })}
        </div>
      </div>
      <div class="bm-section">
        <h4>Print</h4>
        <div class="bm-grid">
          ${numField('bleed', 'Bleed (mm)', { min: 0, max: 20, step: 0.5 })}
          ${numField('safe', 'Safe zone (mm)', { min: 0, max: 30, step: 0.5 })}
          ${numField('print-dpi', 'DPI', { min: 72, max: 1200, step: 1 })}
        </div>
      </div>
      <div class="bm-section">
        <h4>Spine</h4>
        <div class="bm-grid">
          ${numField('spine-per-page', 'Per page (mm)', { min: 0, max: 2, step: 0.01 })}
          ${numField('spine-min', 'Minimum (mm)', { min: 0, max: 50, step: 0.5 })}
        </div>
      </div>
      <div class="bm-section">
        <h4>Editing</h4>
        <div class="bm-grid">
          ${numField('margin-step', 'Margin step (mm)', { min: 0, max: 20, step: 0.5 })}
        </div>
      </div>
      <div class="bm-section">
        <h4>Binding</h4>
        <label class="ps-toggle-row">
          <input type="checkbox" id="ps-endpapers" />
          Endpapers (non-printable inner pages)
        </label>
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
        bindInputs(this.containerEl, () => this._emit(), 'input[type="number"]');
        const bleedChk = this.containerEl.querySelector('#ps-show-bleed');
        bleedChk.addEventListener('change', () => {
            this.onToggleBleed?.(bleedChk.checked);
        });
        const safeChk = this.containerEl.querySelector('#ps-show-safe-zone');
        safeChk.addEventListener('change', () => {
            this.onToggleSafeZone?.(safeChk.checked);
        });
        const endpapersChk = this.containerEl.querySelector('#ps-endpapers');
        endpapersChk.addEventListener('change', () => {
            this.onToggleEndpapers?.(endpapersChk.checked);
        });
    }
    _populate(data) {
        this._set('page-w', data.page_width_mm);
        this._set('page-h', data.page_height_mm);
        this._set('bleed', data.bleed_mm);
        this._set('safe', data.safe_zone_mm);
        this._set('spine-per-page', data.spine_mm_per_page);
        this._set('spine-min', data.spine_min_mm);
        this._set('margin-step', data.margin_step_mm);
        this._set('print-dpi', data.print_dpi);
    }
    _set(name, value) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el)
            return;
        el.value = value.toFixed(el.step && parseFloat(el.step) < 1 ? 2 : 0);
    }
    _emit = debounce(() => {
        const g = (name) => {
            const el = this.containerEl.querySelector(`[data-field="${name}"]`);
            if (!el)
                return 0;
            const v = parseFloat(el.value);
            return isNaN(v) ? 0 : v;
        };
        this.onChange({
            page_width_mm: g('page-w'),
            page_height_mm: g('page-h'),
            bleed_mm: g('bleed'),
            safe_zone_mm: g('safe'),
            spine_mm_per_page: g('spine-per-page'),
            spine_min_mm: g('spine-min'),
            margin_step_mm: g('margin-step'),
            print_dpi: g('print-dpi'),
            endpapers: this.containerEl.querySelector('#ps-endpapers')?.checked ?? false,
        });
    }, 150);
}
