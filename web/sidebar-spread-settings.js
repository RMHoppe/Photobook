// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).
import { debounce } from './utils.js';
import { numField, colorField } from './ui-fields.js';
import { MarginModeController, marginSectionHtml } from './margin-mode-controller.js';
export class SpreadSettingsPanel {
    containerEl;
    onChange;
    _built = false;
    _marginCtrl;
    constructor(containerEl, onChange) {
        this.containerEl = containerEl;
        this.onChange = onChange;
    }
    show(data) {
        if (!this._built)
            this._build();
        this._populate(data);
    }
    _build() {
        this._built = true;
        this.containerEl.innerHTML = `
      ${marginSectionHtml('Spread margin (mm)', (name, label) => numField(name, label))}
      <div class="bm-section">
        <h4>Page backgrounds</h4>
        <div class="bm-grid">
          ${colorField('left-bg', 'Left page')}
          ${colorField('right-bg', 'Right page')}
        </div>
      </div>
    `;
        this.containerEl.querySelectorAll('input').forEach(el => {
            el.addEventListener('change', () => this._emit());
            el.addEventListener('input', () => this._emit());
        });
        this._marginCtrl = new MarginModeController(this.containerEl);
        this._marginCtrl.bindButtons(mode => this._setMarginMode(mode));
    }
    _populate(data) {
        const mode = this._detectMarginMode(data);
        this._marginCtrl.setMode(mode);
        if (mode === 'all') {
            this._setNum('margin-all', data.margin_top);
        }
        else if (mode === 'xy') {
            this._setNum('margin-v', data.margin_top);
            this._setNum('margin-h', data.margin_right);
        }
        else {
            this._setNum('margin-top', data.margin_top);
            this._setNum('margin-right', data.margin_right);
            this._setNum('margin-bottom', data.margin_bottom);
            this._setNum('margin-left', data.margin_left);
        }
        this._setColor('left-bg', data.left_bg || '#ffffff');
        this._setColor('right-bg', data.right_bg || '#ffffff');
    }
    _setNum(name, value) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (el)
            el.value = value.toFixed(2);
    }
    _setColor(name, value) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (el)
            el.value = value;
    }
    // ---------------------------------------------------------------------------
    // Margin mode selector helpers
    // ---------------------------------------------------------------------------
    _detectMarginMode(data) {
        const { margin_top: t, margin_right: r, margin_bottom: b, margin_left: l } = data;
        if (t === r && r === b && b === l)
            return 'all';
        if (t === b && l === r)
            return 'xy';
        return 'each';
    }
    _setMarginMode(mode) {
        const prev = this._readCurrentMargins();
        this._marginCtrl.setMode(mode);
        if (mode === 'all') {
            this._setNum('margin-all', prev.top);
        }
        else if (mode === 'xy') {
            this._setNum('margin-v', prev.top);
            this._setNum('margin-h', prev.right);
        }
        else {
            this._setNum('margin-top', prev.top);
            this._setNum('margin-right', prev.right);
            this._setNum('margin-bottom', prev.bottom);
            this._setNum('margin-left', prev.left);
        }
        this._emit();
    }
    _readCurrentMargins() {
        const g = (name) => {
            const el = this.containerEl.querySelector(`[data-field="${name}"]`);
            if (!el)
                return 0;
            const v = parseFloat(el.value);
            return isNaN(v) ? 0 : v;
        };
        if (this._marginCtrl.mode === 'all') {
            const v = g('margin-all');
            return { top: v, right: v, bottom: v, left: v };
        }
        if (this._marginCtrl.mode === 'xy') {
            const vert = g('margin-v');
            const horiz = g('margin-h');
            return { top: vert, right: horiz, bottom: vert, left: horiz };
        }
        return {
            top: g('margin-top'),
            right: g('margin-right'),
            bottom: g('margin-bottom'),
            left: g('margin-left'),
        };
    }
    _emit = debounce(() => {
        const gc = (name) => {
            const el = this.containerEl.querySelector(`[data-field="${name}"]`);
            return el ? el.value : '#ffffff';
        };
        const margins = this._readCurrentMargins();
        this.onChange({
            margin_top: margins.top,
            margin_right: margins.right,
            margin_bottom: margins.bottom,
            margin_left: margins.left,
            left_bg: gc('left-bg'),
            right_bg: gc('right-bg'),
        });
    }, 150);
}
