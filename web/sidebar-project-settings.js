// sidebar-project-settings.ts — ProjectSettingsPanel (rendered inside the project settings modal).
import { debounce } from './utils.js';
import { numField, wrapField, bindInputs } from './ui-fields.js';
const PAGE_FORMAT_GROUPS = [
    { label: 'Square', formats: [
            { value: 'sq200', label: '20 × 20 cm (200 × 200 mm)', w: 200, h: 200 },
            { value: 'sq250', label: '25 × 25 cm (250 × 250 mm)', w: 250, h: 250 },
            { value: 'sq300', label: '30 × 30 cm (300 × 300 mm)', w: 300, h: 300 },
        ] },
    { label: 'Portrait', formats: [
            { value: 'a5-p', label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
            { value: 'a4-p', label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
            { value: 'a3-p', label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
            { value: 'letter-p', label: 'US Letter (216 × 279 mm)', w: 216, h: 279 },
        ] },
    { label: 'Landscape', formats: [
            { value: 'a5-l', label: 'A5 (210 × 148 mm)', w: 210, h: 148 },
            { value: 'a4-l', label: 'A4 (297 × 210 mm)', w: 297, h: 210 },
            { value: 'a3-l', label: 'A3 (420 × 297 mm)', w: 420, h: 297 },
            { value: 'letter-l', label: 'US Letter (279 × 216 mm)', w: 279, h: 216 },
        ] },
];
// Flat list used for dimension look-ups in _populate().
const PAGE_FORMATS = PAGE_FORMAT_GROUPS.flatMap(g => g.formats);
function pageFormatOptionsHtml() {
    return PAGE_FORMAT_GROUPS.map(g => `<optgroup label="${g.label}">${g.formats.map(f => `<option value="${f.value}">${f.label}</option>`).join('')}</optgroup>`).join('') + '<option value="custom">Custom</option>';
}
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
        <h4>Page size</h4>
        <div class="bm-grid">
          ${wrapField('Format', `<select id="ps-format">${pageFormatOptionsHtml()}</select>`, true)}
        </div>
        <div id="ps-custom-size" class="bm-grid" hidden>
          ${numField('page-w', 'Width (mm)', { min: 1, max: 600, step: 1 })}
          ${numField('page-h', 'Height (mm)', { min: 1, max: 600, step: 1 })}
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
        const formatSel = this.containerEl.querySelector('#ps-format');
        const customSize = this.containerEl.querySelector('#ps-custom-size');
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
        const fmt = PAGE_FORMATS.find(f => f.value !== 'custom' && f.w === data.page_width_mm && f.h === data.page_height_mm);
        const formatSel = this.containerEl.querySelector('#ps-format');
        const customSize = this.containerEl.querySelector('#ps-custom-size');
        if (formatSel && customSize) {
            formatSel.value = fmt ? fmt.value : 'custom';
            customSize.hidden = fmt !== undefined;
        }
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
