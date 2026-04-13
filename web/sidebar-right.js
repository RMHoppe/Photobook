// sidebar-right.js — Box model editor for the selected BSP node.

export class BoxModelEditor {
  constructor(containerEl, onChange, onApplyToChildren) {
    this.containerEl = containerEl;
    this.onChange = onChange; // callback(json)
    this.onApplyToChildren = onApplyToChildren; // callback('gap' | 'bg')
    this._built = false;
    this._emitTimer = null;
  }

  clear() {
    this.containerEl.innerHTML = '<p class="no-selection">Select a frame to edit</p>';
    this._built = false;
  }

  update(boxModelJson) {
    const bm = JSON.parse(boxModelJson);

    if (!this._built) {
      this._build();
    }

    // Margin
    this._set('margin-top',    bm.margin.top);
    this._set('margin-right',  bm.margin.right);
    this._set('margin-bottom', bm.margin.bottom);
    this._set('margin-left',   bm.margin.left);

    // Gap
    this._set('gap', bm.gap);

    // Background
    this._set('bg-color', (bm.bg && bm.bg.length > 0) ? bm.bg : '#ffffff');

    // Border
    const border = bm.border || {};
    this._set('border-width',    border.width    ?? 0);
    this._set('border-color',    border.color    ?? '#000000');
    this._set('border-position', border.position ?? 'centered');
  }

  _set(name, value) {
    const el = this.containerEl.querySelector(`[data-field="${name}"]`);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else if (el.type === 'number') {
      el.value = typeof value === 'number' ? value.toFixed(2) : value;
    } else {
      el.value = value;
    }
  }

  _build() {
    this._built = true;
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Margin (mm)</h4>
        <div class="bm-grid">
          ${this._field('margin-top', 'Top')}
          ${this._field('margin-right', 'Right')}
          ${this._field('margin-bottom', 'Bottom')}
          ${this._field('margin-left', 'Left')}
        </div>
      </div>
      <div class="bm-section gap-field">
        <h4>Gap (mm)</h4>
        <div class="bm-apply-row">
          ${this._field('gap', 'Gap')}
          <button class="bm-apply-btn" data-apply="gap" title="Apply to all children">↓</button>
        </div>
      </div>
      <div class="bm-section">
        <h4>Background</h4>
        <div class="bm-bg-row">
          <input type="color" data-field="bg-color" value="#ffffff" />
          <button class="bm-apply-btn" data-apply="bg" title="Apply to all children">↓</button>
        </div>
      </div>
      <div class="bm-section">
        <h4>Border</h4>
        <div class="bm-grid">
          ${this._field('border-width', 'Width (mm)')}
          ${this._colorField('border-color', 'Color')}
        </div>
        <div class="bm-grid" style="margin-top:4px">
          ${this._selectField('border-position', 'Position', [
            ['inner',    'Inner'],
            ['centered', 'Centered'],
            ['outer',    'Outer'],
          ])}
        </div>
      </div>
    `;

    this.containerEl.querySelectorAll('input, select').forEach(el => {
      el.addEventListener('change', () => this._emit());
      el.addEventListener('input',  () => this._emit());
    });

    this.containerEl.querySelectorAll('[data-apply]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._emit(); // flush pending value first
        if (this.onApplyToChildren) this.onApplyToChildren(btn.dataset.apply);
      });
    });
  }

  _field(name, label) {
    return `<div class="bm-field">
      <label>${label}</label>
      <input type="number" min="0" max="200" step="0.5" data-field="${name}" value="0" />
    </div>`;
  }

  _colorField(name, label) {
    return `<div class="bm-field">
      <label>${label}</label>
      <input type="color" data-field="${name}" value="#000000" />
    </div>`;
  }

  _selectField(name, label, options) {
    const opts = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    return `<div class="bm-field bm-full-width">
      <label>${label}</label>
      <select data-field="${name}">${opts}</select>
    </div>`;
  }

  _emit() {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      const gNum = name => {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        return el ? (parseFloat(el.value) || 0) : 0;
      };
      const gStr = name => {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        return el ? el.value : '';
      };
      const bm = {
        margin:  { top: gNum('margin-top'), right: gNum('margin-right'), bottom: gNum('margin-bottom'), left: gNum('margin-left') },
        gap:     gNum('gap'),
        bg:      gStr('bg-color') || '#ffffff',
        border: {
          width:    gNum('border-width'),
          color:    gStr('border-color') || '#000000',
          position: gStr('border-position') || 'centered',
        },
      };
      this.onChange(JSON.stringify(bm));
    }, 150);
  }
}
