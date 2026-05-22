// sidebar-box-model.ts — BoxModelEditor panel (shown when a frame is selected).
//
// Multi-selection sentinel values:
//   null/absent for border-width fields (Rust Option::None → skip, per-side pattern)
//   null/absent for margin and rotation (Rust Option::None → skip)
//   "__mixed__" for color fields (Rust skips this exact string)
//   ""          for border-position (Rust deserialises as BorderPosition::Mixed → skip)
//   -1          for border.radius (f32 field, Rust skips if < 0)
import { debounce } from './utils.js';
import { wrapField, numField, colorField, selectField } from './ui-fields.js';
import { MarginModeController, marginSectionHtml } from './margin-mode-controller.js';
export class BoxModelEditor {
    containerEl;
    onChange;
    onZOrder;
    onDiceClick;
    onLayoutTransform;
    _built = false;
    _marginCtrl;
    _borderWidthCtrl;
    constructor(containerEl, onChange, onZOrder, onDiceClick, onLayoutTransform) {
        this.containerEl = containerEl;
        this.onChange = onChange;
        this.onZOrder = onZOrder;
        this.onDiceClick = onDiceClick;
        this.onLayoutTransform = onLayoutTransform;
    }
    clear() {
        this.containerEl.innerHTML = '<p class="no-selection">Select a frame to edit</p>';
        this._built = false;
    }
    update(boxModelJson, zIndex, selectionCount = 1, selectionIsRect = false) {
        const bm = JSON.parse(boxModelJson);
        if (!this._built || this.containerEl.dataset.panel !== 'boxmodel')
            this._build();
        // Show dice buttons only when multiple frames are selected.
        const multiSel = selectionCount > 1;
        this.containerEl.querySelectorAll('[data-dice]').forEach(btn => {
            btn.hidden = !multiSel;
        });
        // Show layout-transform buttons when multiple frames form a complete rectangle.
        const showTransform = multiSel && selectionIsRect;
        const transformRow = this.containerEl.querySelector('.bm-layout-transform');
        if (transformRow)
            transformRow.hidden = !showTransform;
        // Margin (null = mixed sentinel; allows negative values)
        this._updateMarginUI(bm.margin);
        // Border widths (per-side, null = mixed)
        const border = bm.border ?? {};
        this._updateBorderWidthUI(border);
        this._set('border-radius', border.radius ?? 0);
        this._set('border-color', border.color ?? '#000000');
        this._set('border-position', border.position ?? 'centered');
        // Node transform (undefined/null → show Mixed placeholder)
        this._setOffset('node-rotation', bm.face_rotation_deg);
        // Z-order label
        const orderRow = this.containerEl.querySelector('.bm-order-row');
        if (orderRow) {
            orderRow.hidden = zIndex === undefined;
            const orderLabel = orderRow.querySelector('.bm-z-label');
            if (orderLabel)
                orderLabel.textContent = String((zIndex ?? 0) + 1);
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
      ${marginSectionHtml('Margin (mm)', (name, label) => numField(name, label, { min: null }))}
      ${marginSectionHtml('Border width (mm)', (name, label) => numField(name, label), 'bw')}
      <div class="bm-section">
        <h4>Border style</h4>
        <div class="bm-grid">
          ${numField('border-radius', 'Radius (mm)')}
          ${colorField('border-color', 'Color')}
        </div>
        <div class="bm-grid" style="margin-top:4px">
          ${selectField('border-position', 'Position', [
            ['inner', 'Inner'],
            ['centered', 'Centered'],
            ['outer', 'Outer'],
        ], true)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid">
          ${this._offsetFieldWithDice('node-rotation', 'Rotation (°)', 'rotation')}
        </div>
        <div class="bm-layout-transform" hidden>
          <div class="bm-layout-btns">
            <button class="bm-layout-btn" data-layout="flip-h"     title="Mirror left / right"><i class="fa-solid fa-left-right"></i></button>
            <button class="bm-layout-btn" data-layout="flip-v"     title="Mirror top / bottom"><i class="fa-solid fa-up-down"></i></button>
            <button class="bm-layout-btn" data-layout="rotate-cw"  title="Rotate 90° clockwise"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="bm-layout-btn" data-layout="rotate-ccw" title="Rotate 90° counter-clockwise"><i class="fa-solid fa-rotate-left"></i></button>
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Order</h4>
        <div class="bm-order-row">
          <div class="bm-order-btns">
            <button class="bm-order-btn" data-zorder="back"  title="Send to back"><i class="fa-solid fa-angles-down"></i></button>
            <button class="bm-order-btn" data-zorder="down"  title="Move down (render below)"><i class="fa-solid fa-arrow-down"></i></button>
            <button class="bm-order-btn" data-zorder="up"    title="Move up (render above)"><i class="fa-solid fa-arrow-up"></i></button>
            <button class="bm-order-btn" data-zorder="front" title="Bring to front"><i class="fa-solid fa-angles-up"></i></button>
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
        this.containerEl.querySelectorAll('[data-layout]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.onLayoutTransform(btn.dataset.layout);
            });
        });
        this._marginCtrl = new MarginModeController(this.containerEl);
        this._marginCtrl.bindButtons(mode => this._setMarginMode(mode));
        this._borderWidthCtrl = new MarginModeController(this.containerEl, 'bw');
        this._borderWidthCtrl.bindButtons(mode => this._setBorderWidthMode(mode));
    }
    // ---------------------------------------------------------------------------
    // Field HTML builders (box-model-specific)
    // ---------------------------------------------------------------------------
    _offsetFieldWithDice(name, label, dice) {
        return wrapField(label, `<div class="bm-input-row"><input type="number" step="0.5" data-field="${name}" value="0" /><button class="bm-dice-btn" data-dice="${dice}" title="Randomize across selection" hidden><i class="fa-solid fa-dice"></i></button></div>`);
    }
    // ---------------------------------------------------------------------------
    // Field value readers (used by _emit)
    // ---------------------------------------------------------------------------
    _gNum(name) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el || el.dataset.mixed)
            return -1;
        const v = parseFloat(el.value);
        return isNaN(v) ? 0 : v;
    }
    _gColor(name) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el || el.dataset.mixed)
            return '__mixed__';
        return el.value || '#ffffff';
    }
    _gSel(name) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el || el.dataset.mixed)
            return '';
        return el.value;
    }
    _gOffset(name) {
        const el = this.containerEl.querySelector(`[data-field="${name}"]`);
        if (!el || el.dataset.mixed)
            return null;
        const v = parseFloat(el.value);
        return isNaN(v) ? 0 : v;
    }
    // ---------------------------------------------------------------------------
    // Margin mode selector helpers
    // ---------------------------------------------------------------------------
    _detectMarginMode(m) {
        const { top: t, right: r, bottom: b, left: l } = m;
        if (t == null || r == null || b == null || l == null)
            return 'each';
        if (t === r && r === b && b === l)
            return 'all';
        if (t === b && l === r)
            return 'xy';
        return 'each';
    }
    _updateMarginUI(margin) {
        const m = margin ?? { top: null, right: null, bottom: null, left: null };
        this._marginCtrl.setMode(this._detectMarginMode(m));
        if (this._marginCtrl.mode === 'all') {
            this._setOffset('margin-all', m.top);
        }
        else if (this._marginCtrl.mode === 'xy') {
            this._setOffset('margin-v', m.top);
            this._setOffset('margin-h', m.right);
        }
        else {
            this._setOffset('margin-top', m.top);
            this._setOffset('margin-right', m.right);
            this._setOffset('margin-bottom', m.bottom);
            this._setOffset('margin-left', m.left);
        }
    }
    _setMarginMode(mode) {
        const rank = { all: 1, xy: 2, each: 3 };
        const refining = rank[mode] > rank[this._marginCtrl.mode];
        const prev = this._readCurrentMargins();
        this._marginCtrl.setMode(mode);
        if (mode === 'all') {
            // Always coarsening — show mixed if sides differ.
            const same = prev.top === prev.right && prev.right === prev.bottom && prev.bottom === prev.left;
            this._setOffset('margin-all', same ? prev.top : null);
        }
        else if (mode === 'xy') {
            const v = prev.top === prev.bottom ? prev.top : null;
            const h = prev.right === prev.left ? prev.right : null;
            // When refining from 'all', a null v/h means the all-field was mixed —
            // leave the xy fields as-is (they still hold their previous concrete values).
            if (!refining || v !== null)
                this._setOffset('margin-v', v);
            if (!refining || h !== null)
                this._setOffset('margin-h', h);
        }
        else {
            // Always refining — only overwrite each field if we have a concrete value;
            // otherwise preserve whatever the each-pane already shows.
            if (prev.top !== null)
                this._setOffset('margin-top', prev.top);
            if (prev.right !== null)
                this._setOffset('margin-right', prev.right);
            if (prev.bottom !== null)
                this._setOffset('margin-bottom', prev.bottom);
            if (prev.left !== null)
                this._setOffset('margin-left', prev.left);
        }
        this._emit();
    }
    _readCurrentMargins() {
        if (this._marginCtrl.mode === 'all') {
            const v = this._gOffset('margin-all');
            return { top: v, right: v, bottom: v, left: v };
        }
        if (this._marginCtrl.mode === 'xy') {
            const v = this._gOffset('margin-v');
            const h = this._gOffset('margin-h');
            return { top: v, right: h, bottom: v, left: h };
        }
        return {
            top: this._gOffset('margin-top'),
            right: this._gOffset('margin-right'),
            bottom: this._gOffset('margin-bottom'),
            left: this._gOffset('margin-left'),
        };
    }
    // ---------------------------------------------------------------------------
    // Border width mode selector helpers (mirrors margin mode logic, namespace 'bw')
    // ---------------------------------------------------------------------------
    _detectBorderWidthMode(m) {
        const { top: t, right: r, bottom: b, left: l } = m;
        if (t == null || r == null || b == null || l == null)
            return 'each';
        if (t === r && r === b && b === l)
            return 'all';
        if (t === b && l === r)
            return 'xy';
        return 'each';
    }
    _updateBorderWidthUI(border) {
        const m = {
            top: border.width_top ?? null,
            right: border.width_right ?? null,
            bottom: border.width_bottom ?? null,
            left: border.width_left ?? null,
        };
        this._borderWidthCtrl.setMode(this._detectBorderWidthMode(m));
        if (this._borderWidthCtrl.mode === 'all') {
            this._setOffset('bw-all', m.top);
        }
        else if (this._borderWidthCtrl.mode === 'xy') {
            this._setOffset('bw-v', m.top);
            this._setOffset('bw-h', m.right);
        }
        else {
            this._setOffset('bw-top', m.top);
            this._setOffset('bw-right', m.right);
            this._setOffset('bw-bottom', m.bottom);
            this._setOffset('bw-left', m.left);
        }
    }
    _setBorderWidthMode(mode) {
        const rank = { all: 1, xy: 2, each: 3 };
        const refining = rank[mode] > rank[this._borderWidthCtrl.mode];
        const prev = this._readCurrentBorderWidths();
        this._borderWidthCtrl.setMode(mode);
        if (mode === 'all') {
            const same = prev.top === prev.right && prev.right === prev.bottom && prev.bottom === prev.left;
            this._setOffset('bw-all', same ? prev.top : null);
        }
        else if (mode === 'xy') {
            const v = prev.top === prev.bottom ? prev.top : null;
            const h = prev.right === prev.left ? prev.right : null;
            if (!refining || v !== null)
                this._setOffset('bw-v', v);
            if (!refining || h !== null)
                this._setOffset('bw-h', h);
        }
        else {
            if (prev.top !== null)
                this._setOffset('bw-top', prev.top);
            if (prev.right !== null)
                this._setOffset('bw-right', prev.right);
            if (prev.bottom !== null)
                this._setOffset('bw-bottom', prev.bottom);
            if (prev.left !== null)
                this._setOffset('bw-left', prev.left);
        }
        this._emit();
    }
    _readCurrentBorderWidths() {
        if (this._borderWidthCtrl.mode === 'all') {
            const v = this._gOffset('bw-all');
            return { top: v, right: v, bottom: v, left: v };
        }
        if (this._borderWidthCtrl.mode === 'xy') {
            const v = this._gOffset('bw-v');
            const h = this._gOffset('bw-h');
            return { top: v, right: h, bottom: v, left: h };
        }
        return {
            top: this._gOffset('bw-top'),
            right: this._gOffset('bw-right'),
            bottom: this._gOffset('bw-bottom'),
            left: this._gOffset('bw-left'),
        };
    }
    _emit = debounce(() => {
        const bw = this._readCurrentBorderWidths();
        const bm = {
            margin: this._readCurrentMargins(),
            border: {
                width_top: bw.top,
                width_right: bw.right,
                width_bottom: bw.bottom,
                width_left: bw.left,
                radius: this._gNum('border-radius'),
                color: this._gColor('border-color'),
                position: this._gSel('border-position'),
            },
            face_rotation_deg: this._gOffset('node-rotation'),
        };
        this.onChange(JSON.stringify(bm));
    }, 150);
}
