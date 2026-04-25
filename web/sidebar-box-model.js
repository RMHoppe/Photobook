// sidebar-box-model.ts — BoxModelEditor panel (shown when a BSP node is selected).
//
// Multi-selection sentinel values:
//   -1          for f32 fields that are always ≥ 0 (Rust skips any value < 0)
//   null/absent for offset fields that can be negative (Rust Option::None → skip)
//   "__mixed__" for color fields (Rust skips this exact string)
//   ""          for border-position (Rust deserialises as BorderPosition::Mixed → skip)
export class BoxModelEditor {
    containerEl;
    onChange;
    onApplyToChildren;
    onZOrder;
    onDiceClick;
    _built = false;
    _emitTimer = null;
    constructor(containerEl, onChange, onApplyToChildren, onZOrder, onDiceClick) {
        this.containerEl = containerEl;
        this.onChange = onChange;
        this.onApplyToChildren = onApplyToChildren;
        this.onZOrder = onZOrder;
        this.onDiceClick = onDiceClick;
    }
    clear() {
        this.containerEl.innerHTML = '<p class="no-selection">Select a frame to edit</p>';
        this._built = false;
    }
    update(boxModelJson, zIndex, selectionCount = 1) {
        const bm = JSON.parse(boxModelJson);
        if (!this._built || this.containerEl.dataset.panel !== 'boxmodel')
            this._build();
        // Show dice buttons only when multiple frames are selected.
        const multiSel = selectionCount > 1;
        this.containerEl.querySelectorAll('[data-dice]').forEach(btn => {
            btn.hidden = !multiSel;
        });
        // Margin
        this._set('margin-top', bm.margin?.top);
        this._set('margin-right', bm.margin?.right);
        this._set('margin-bottom', bm.margin?.bottom);
        this._set('margin-left', bm.margin?.left);
        // Background — "" means transparent/unset; "__mixed__" means disagreeing nodes.
        this._set('bg-color', bm.bg ?? '');
        // Border
        const border = bm.border ?? {};
        this._set('border-width', border.width ?? 0);
        this._set('border-color', border.color ?? '#000000');
        this._set('border-position', border.position ?? 'centered');
        // Node transform (undefined/null → show Mixed placeholder)
        this._setOffset('node-rotation', bm.node_rotation_deg);
        // Z-order label
        const orderLabel = this.containerEl.querySelector('.bm-z-label');
        if (orderLabel) {
            orderLabel.textContent = zIndex !== undefined ? String(zIndex + 1) : '—';
        }
        const orderBtns = this.containerEl.querySelector('.bm-order-btns');
        if (orderBtns) {
            orderBtns.style.display = zIndex !== undefined ? '' : 'none';
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    /**
     * Set a single field. Handles sentinel values produced by the Rust multi-selection merger:
     *   f32 sentinel  : -1 (or any negative) → blank number input
     *   string sentinel: "__mixed__"          → dimmed colour swatch
     *   position sentinel: "mixed"            → "—" select option
     */
    _set(name, value) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el)
            return;
        // Reset mixed state from previous update.
        delete el.dataset.mixed;
        if (el instanceof HTMLInputElement && el.type === 'number') {
            if (typeof value === 'number' && value < 0) {
                el.value = '';
                el.placeholder = 'Mixed';
                el.dataset.mixed = '1';
            }
            else {
                el.value = typeof value === 'number' ? value.toFixed(2) : (String(value ?? '0'));
                el.placeholder = '';
            }
        }
        else if (el instanceof HTMLInputElement && el.type === 'color') {
            if (value === '__mixed__') {
                el.value = '#808080';
                el.dataset.mixed = '1';
            }
            else {
                el.value = (value && value !== '') ? String(value) : '#ffffff';
            }
        }
        else if (el instanceof HTMLSelectElement) {
            if (!value || value === 'mixed') {
                el.value = '';
                el.dataset.mixed = '1';
            }
            else {
                el.value = String(value);
            }
        }
        else {
            el.value = String(value ?? '');
        }
    }
    /** Like _set but treats null/undefined as the mixed sentinel (for fields that can be negative). */
    _setOffset(name, value) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el)
            return;
        delete el.dataset.mixed;
        if (value == null) {
            el.value = '';
            el.placeholder = 'Mixed';
            el.dataset.mixed = '1';
        }
        else {
            el.value = typeof value === 'number' ? value.toFixed(2) : String(value);
            el.placeholder = '';
        }
    }
    _build() {
        this._built = true;
        this.containerEl.dataset.panel = 'boxmodel';
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
            ['inner', 'Inner'],
            ['centered', 'Centered'],
            ['outer', 'Outer'],
        ])}
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid">
          ${this._offsetFieldWithDice('node-rotation', 'Rotation (°)', 'rotation')}
        </div>
      </div>
      <div class="bm-section">
        <h4>Order</h4>
        <div class="bm-order-row">
          <div class="bm-order-btns">
            <button class="bm-order-btn" data-zorder="down" title="Move down (render below)">↓</button>
            <button class="bm-order-btn" data-zorder="up"   title="Move up (render above)">↑</button>
          </div>
          <span class="bm-z-label">—</span>
        </div>
      </div>
    `;
        this.containerEl.querySelectorAll('input, select').forEach(el => {
            const onUserInput = () => {
                delete el.dataset.mixed;
                this._emit();
            };
            el.addEventListener('change', onUserInput);
            el.addEventListener('input', onUserInput);
        });
        this.containerEl.querySelectorAll('[data-apply]').forEach(btn => {
            btn.addEventListener('click', () => {
                this._emit();
                if (this.onApplyToChildren)
                    this.onApplyToChildren(btn.dataset.apply);
            });
        });
        this.containerEl.querySelectorAll('[data-zorder]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.onZOrder(btn.dataset.zorder);
            });
        });
        this.containerEl.querySelectorAll('[data-dice]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.onDiceClick(btn.dataset.dice);
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
    _offsetFieldWithDice(name, label, dice) {
        return `<div class="bm-field">
      <label>${label}</label>
      <div class="bm-input-row">
        <input type="number" step="0.5" data-field="${name}" value="0" />
        <button class="bm-dice-btn" data-dice="${dice}" title="Randomize across selection" hidden>⚄</button>
      </div>
    </div>`;
    }
    _selectField(name, label, options) {
        const opts = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        return `<div class="bm-field bm-full-width">
      <label>${label}</label>
      <select data-field="${name}">
        <option value="" hidden>—</option>
        ${opts}
      </select>
    </div>`;
    }
    _emit() {
        if (this._emitTimer !== null)
            clearTimeout(this._emitTimer);
        this._emitTimer = setTimeout(() => {
            const gNum = (name) => {
                const el = this.containerEl.querySelector(`[data-field="${name}"]`);
                if (!el || el.dataset.mixed)
                    return -1;
                const v = parseFloat(el.value);
                return isNaN(v) ? 0 : v;
            };
            const gColor = (name) => {
                const el = this.containerEl.querySelector(`[data-field="${name}"]`);
                if (!el || el.dataset.mixed)
                    return '__mixed__';
                return el.value || '#ffffff';
            };
            const gSel = (name) => {
                const el = this.containerEl.querySelector(`[data-field="${name}"]`);
                if (!el || el.dataset.mixed)
                    return '';
                return el.value;
            };
            const gOffset = (name) => {
                const el = this.containerEl.querySelector(`[data-field="${name}"]`);
                if (!el || el.dataset.mixed)
                    return null;
                const v = parseFloat(el.value);
                return isNaN(v) ? 0 : v;
            };
            const bm = {
                margin: {
                    top: gNum('margin-top'),
                    right: gNum('margin-right'),
                    bottom: gNum('margin-bottom'),
                    left: gNum('margin-left'),
                },
                gap: gNum('gap'),
                bg: gColor('bg-color'),
                border: {
                    width: gNum('border-width'),
                    color: gColor('border-color'),
                    position: gSel('border-position'),
                },
                node_rotation_deg: gOffset('node-rotation'),
            };
            this.onChange(JSON.stringify(bm));
        }, 150);
    }
}
