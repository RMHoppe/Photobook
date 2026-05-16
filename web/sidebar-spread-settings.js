// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).
export class SpreadSettingsPanel {
    containerEl;
    onChange;
    _built = false;
    _emitTimer = null;
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
      <div class="bm-section">
        <h4>Default margins (mm)</h4>
        <div class="bm-grid">
          ${this._numField('def-margin-top', 'Top')}
          ${this._numField('def-margin-right', 'Right')}
          ${this._numField('def-margin-bottom', 'Bottom')}
          ${this._numField('def-margin-left', 'Left')}
        </div>
      </div>
      <div class="bm-section">
        <h4>Page backgrounds</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>Left page</label>
            <input type="color" data-field="left-bg" value="#ffffff" />
          </div>
          <div class="bm-field">
            <label>Right page</label>
            <input type="color" data-field="right-bg" value="#ffffff" />
          </div>
        </div>
      </div>
    `;
        this.containerEl.querySelectorAll('input').forEach(el => {
            el.addEventListener('change', () => this._emit());
            el.addEventListener('input', () => this._emit());
        });
    }
    _populate(data) {
        this._setNum('def-margin-top', data.default_margin_top);
        this._setNum('def-margin-right', data.default_margin_right);
        this._setNum('def-margin-bottom', data.default_margin_bottom);
        this._setNum('def-margin-left', data.default_margin_left);
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
    _numField(name, label) {
        return `<div class="bm-field">
      <label>${label}</label>
      <input type="number" min="0" max="200" step="0.5" data-field="${name}" value="0" />
    </div>`;
    }
    _emit() {
        if (this._emitTimer !== null)
            clearTimeout(this._emitTimer);
        this._emitTimer = setTimeout(() => {
            const g = (name) => {
                const el = this.containerEl.querySelector(`[data-field="${name}"]`);
                if (!el)
                    return 0;
                const v = parseFloat(el.value);
                return isNaN(v) ? 0 : v;
            };
            const gc = (name) => {
                const el = this.containerEl.querySelector(`[data-field="${name}"]`);
                return el ? el.value : '#ffffff';
            };
            this.onChange({
                default_margin_top: g('def-margin-top'),
                default_margin_right: g('def-margin-right'),
                default_margin_bottom: g('def-margin-bottom'),
                default_margin_left: g('def-margin-left'),
                left_bg: gc('left-bg'),
                right_bg: gc('right-bg'),
            });
        }, 150);
    }
}
