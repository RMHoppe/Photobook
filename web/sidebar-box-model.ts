// sidebar-box-model.ts — BoxModelEditor panel (shown when a frame is selected).
//
// Multi-selection sentinel values:
//   null/absent for border-width fields (Rust Option::None → skip, per-side pattern)
//   null/absent for margin and rotation (Rust Option::None → skip)
//   "__mixed__" for color fields (Rust skips this exact string)
//   ""          for border-position (Rust deserialises as BorderPosition::Mixed → skip)
//   -1          for border.radius (f32 field, Rust skips if < 0)

import type { BoxModel } from './types.js';
import { debounce } from './utils.js';
import { numFieldWithDice, colorField, selectField, bindInputs, setNumField, readNumField } from './ui-fields.js';
import { MarginModeController, marginSectionHtml, type MarginMode, type Sides, type SideLabels, detectSidesMode } from './margin-mode-controller.js';

// Defaults applied when a toggleable section is first enabled, so the effect is
// immediately visible instead of a no-op zero.
const BORDER_DEFAULT_MM = 3;
const RADIUS_DEFAULT_MM = 10;

export class BoxModelEditor {
  private containerEl: HTMLElement;
  private onChange: (json: string) => void;
  private onZOrder: (direction: 'up' | 'down') => void;
  private onDiceClick: (field: string) => void;
  private _multiSel = false;
  private onLayerRandomize: () => void;
  private _built = false;
  private _borderWidthCtrl!: MarginModeController;
  private _radiusCtrl!: MarginModeController;
  private readonly _groups = [
    { group: 'border', ctrl: () => this._borderWidthCtrl, ns: 'bw',     def: BORDER_DEFAULT_MM },
    { group: 'radius', ctrl: () => this._radiusCtrl,      ns: 'radius', def: RADIUS_DEFAULT_MM },
  ];

  constructor(
    containerEl: HTMLElement,
    onChange: (json: string) => void,
    onZOrder: (direction: 'up' | 'down') => void,
    onDiceClick: (field: string) => void,
    onLayerRandomize: () => void,
  ) {
    this.containerEl = containerEl;
    this.onChange = onChange;
    this.onZOrder = onZOrder;
    this.onDiceClick = onDiceClick;
    this.onLayerRandomize = onLayerRandomize;
  }

  clear(): void {
    this.containerEl.innerHTML = '<p class="no-selection">Select a frame to edit</p>';
    this._built = false;
  }

  update(boxModelJson: string, zIndex?: number, selectionCount = 1): void {
    const bm = JSON.parse(boxModelJson) as BoxModel;

    if (!this._built || this.containerEl.dataset.panel !== 'boxmodel') this._build();

    // Dice buttons only appear on field focus (when multiSel); hide all when dropping to single selection.
    this._multiSel = selectionCount > 1;
    if (!this._multiSel) {
      this.containerEl.querySelectorAll<HTMLButtonElement>('[data-dice]').forEach(btn => {
        btn.hidden = true;
      });
    }

    // Border widths (per-side, null = mixed)
    const border = bm.border ?? {};
    const bw: Sides = {
      top:    border.width_top    ?? null,
      right:  border.width_right  ?? null,
      bottom: border.width_bottom ?? null,
      left:   border.width_left   ?? null,
    };
    this._updateSidesUI(this._borderWidthCtrl, 'bw', bw);
    const rad: Sides = {
      top:    border.radius_tl ?? null,
      right:  border.radius_tr ?? null,
      bottom: border.radius_br ?? null,
      left:   border.radius_bl ?? null,
    };
    this._updateSidesUI(this._radiusCtrl, 'radius', rad);
    this._set('border-color',    border.color    ?? '#000000');
    this._set('border-position', border.position ?? 'centered');

    // Node transform (undefined/null → show Mixed placeholder)
    this._setOffset('node-rotation', bm.face_rotation_deg);

    // Z-order label
    const orderRow     = this.containerEl.querySelector<HTMLElement>('.bm-order-row');
    const orderSection = orderRow?.closest<HTMLElement>('.bm-section') ?? null;
    // Show Layer controls for a single frame OR a multi-selection (the order
    // buttons apply to every selected frame).
    if (orderSection) orderSection.hidden = zIndex === undefined && selectionCount <= 1;
    if (orderRow) {
      const orderLabel = orderRow.querySelector<HTMLElement>('.bm-z-label');
      if (orderLabel) orderLabel.textContent = zIndex === undefined ? '—' : String(zIndex + 1);
    }
    const layerRand = this.containerEl.querySelector<HTMLElement>('.bm-layer-randomize');
    if (layerRand) layerRand.hidden = !this._multiSel;

    this._applyEnableVisibility();
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
  private _set(name: string, value: unknown): void {
    const el = this.containerEl.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-field="${name}"]`,
    );
    if (!el) return;

    // Reset mixed state from previous update.
    delete (el as HTMLElement & { dataset: DOMStringMap }).dataset.mixed;

    if (el instanceof HTMLInputElement && el.type === 'number') {
      if (typeof value === 'number' && value < 0) {
        el.value = '';
        el.placeholder = 'Mixed';
        el.dataset.mixed = '1';
      } else {
        el.value = typeof value === 'number' ? value.toFixed(2) : (String(value ?? '0'));
        el.placeholder = '';
      }
    } else if (el instanceof HTMLInputElement && el.type === 'color') {
      if (value === '__mixed__') {
        el.value = '#808080';
        el.dataset.mixed = '1';
      } else {
        el.value = (value && value !== '') ? String(value) : '#ffffff';
      }
    } else if (el instanceof HTMLSelectElement) {
      if (!value || value === 'mixed') {
        el.value = '';
        el.dataset.mixed = '1';
      } else {
        el.value = String(value);
      }
    } else {
      (el as HTMLInputElement).value = String(value ?? '');
    }
  }

  private _setOffset(name: string, value: number | null | undefined): void {
    setNumField(this.containerEl, name, value);
  }

  // -------------------------------------------------------------------------
  // Section enable toggles
  // -------------------------------------------------------------------------

  private _onEnableToggle(group: string, enabled: boolean): void {
    const g = this._groups.find(g => g.group === group);
    if (!g) return;
    const ctrl = g.ctrl();
    if (enabled) {
      const cur = this._readCurrentSides(ctrl, g.ns);
      const allZero = (['top', 'right', 'bottom', 'left'] as const)
        .every(k => cur[k] !== null && (cur[k] as number) <= 0);
      if (allZero) {
        ctrl.setMode('all');
        this._setOffset(`${g.ns}-all`, g.def);
      }
    } else {
      ctrl.setMode('all');
      this._setOffset(`${g.ns}-all`, 0);
    }
    this._applyEnableVisibility();
    this._emit();
  }

  /** Derive each toggleable section's enabled state from its current values and
   *  reflect it in the checkbox + body visibility. */
  private _applyEnableVisibility(): void {
    for (const { group, ctrl, ns } of this._groups) {
      const cur = this._readCurrentSides(ctrl(), ns);
      const on = (['top', 'right', 'bottom', 'left'] as const)
        .some(k => cur[k] === null || (cur[k] as number) > 0);
      this._setSectionEnabled(group, on);
    }
  }

  private _setSectionEnabled(group: string, enabled: boolean): void {
    const section = this.containerEl.querySelector<HTMLElement>(`[data-section="${group}"]`);
    if (!section) return;
    const cb = section.querySelector<HTMLInputElement>(`[data-enable="${group}"]`);
    if (cb) cb.checked = enabled;
    const body = section.querySelector<HTMLElement>('.bm-enable-body');
    if (body) body.hidden = !enabled;
  }

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'boxmodel';
    this.containerEl.innerHTML = `
      <div class="bm-section" data-section="border">
        <div class="bm-section-header">
          <h4>Border</h4>
          <label class="bm-switch"><input type="checkbox" data-enable="border" /><span class="bm-switch-track"></span></label>
        </div>
        <div class="bm-enable-body">
          ${marginSectionHtml('Width (mm)', (name, label) => numFieldWithDice(name, label), 'bw')}
          <div class="bm-grid" style="margin-top:4px">
            ${colorField('border-color', 'Color')}
            ${selectField('border-position', 'Position', [
              ['inner',    'Inner'],
              ['centered', 'Centered'],
              ['outer',    'Outer'],
            ])}
          </div>
        </div>
      </div>
      <div class="bm-section" data-section="radius">
        <div class="bm-section-header">
          <h4>Corner radius</h4>
          <label class="bm-switch"><input type="checkbox" data-enable="radius" /><span class="bm-switch-track"></span></label>
        </div>
        <div class="bm-enable-body">
          ${marginSectionHtml('Radius (mm)', (name, label) => numFieldWithDice(name, label), 'radius', {
            v: 'TL + BR', h: 'TR + BL',
            top: 'Top-left', right: 'Top-right', bottom: 'Bot-right', left: 'Bot-left',
          } as SideLabels)}
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid">
          ${numFieldWithDice('node-rotation', 'Rotation (°)', { min: null, max: undefined })}
        </div>
      </div>
      <div class="bm-section">
        <h4>Layer</h4>
        <div class="bm-order-row">
          <div class="bm-order-btns">
            <button class="bm-order-btn" data-zorder="back"  title="Send to back"><i class="ti ti-chevrons-down"></i></button>
            <button class="bm-order-btn" data-zorder="down"  title="Move down (render below)"><i class="ti ti-arrow-down"></i></button>
            <button class="bm-order-btn" data-zorder="up"    title="Move up (render above)"><i class="ti ti-arrow-up"></i></button>
            <button class="bm-order-btn" data-zorder="front" title="Bring to front"><i class="ti ti-chevrons-up"></i></button>
          </div>
          <span class="bm-z-label">—</span>
          <button class="bm-order-btn bm-layer-randomize" data-layer-randomize title="Randomize layering of selected frames" hidden><i class="ti ti-dice-5"></i></button>
        </div>
      </div>
    `;

    bindInputs(this.containerEl, () => this._emit());

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-zorder]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.onZOrder(btn.dataset.zorder as 'up' | 'down');
      });
    });

    this.containerEl.querySelector<HTMLButtonElement>('[data-layer-randomize]')
      ?.addEventListener('click', () => this.onLayerRandomize());

    this.containerEl.querySelectorAll<HTMLInputElement>('[data-enable]').forEach(cb => {
      cb.addEventListener('change', () => this._onEnableToggle(cb.dataset.enable!, cb.checked));
    });

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-dice]').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.dice === 'node-rotation' ? 'rotation' : btn.dataset.dice!;
        this.onDiceClick(field);
      });
    });

    this.containerEl.addEventListener('focusin', (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'number') return;
      const btn = input.parentElement?.querySelector<HTMLButtonElement>('.bm-dice-btn');
      if (btn && this._multiSel) btn.hidden = false;
    });

    this.containerEl.addEventListener('focusout', (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'number') return;
      const btn = input.parentElement?.querySelector<HTMLButtonElement>('.bm-dice-btn');
      if (btn) setTimeout(() => { btn.hidden = true; }, 150);
    });

    this._borderWidthCtrl = new MarginModeController(this.containerEl, 'bw');
    this._borderWidthCtrl.bindButtons(mode => this._setSidesMode(this._borderWidthCtrl, 'bw', mode));

    this._radiusCtrl = new MarginModeController(this.containerEl, 'radius');
    this._radiusCtrl.bindButtons(mode => this._setSidesMode(this._radiusCtrl, 'radius', mode));
  }

  // ---------------------------------------------------------------------------
  // Field value readers (used by _emit)
  // ---------------------------------------------------------------------------

  private _gNum(name: string): number {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return -1;
    const v = parseFloat(el.value);
    return isNaN(v) ? 0 : v;
  }

  private _gColor(name: string): string {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return '__mixed__';
    return el.value || '#ffffff';
  }

  private _gSel(name: string): string {
    const el = this.containerEl.querySelector<HTMLSelectElement>(`[data-field="${name}"]`);
    if (!el || el.dataset.mixed) return '';
    return el.value;
  }

  private _gOffset(name: string): number | null {
    return readNumField(this.containerEl, name);
  }

  // ---------------------------------------------------------------------------
  // Shared sides helpers — used for both margin ('margin') and border width ('bw')
  // ---------------------------------------------------------------------------

  private _updateSidesUI(ctrl: MarginModeController, ns: string, m: Sides): void {
    ctrl.setMode(detectSidesMode(m));
    if (ctrl.mode === 'all') {
      this._setOffset(`${ns}-all`, m.top);
    } else if (ctrl.mode === 'xy') {
      this._setOffset(`${ns}-v`, m.top);
      this._setOffset(`${ns}-h`, m.right);
    } else {
      this._setOffset(`${ns}-top`,    m.top);
      this._setOffset(`${ns}-right`,  m.right);
      this._setOffset(`${ns}-bottom`, m.bottom);
      this._setOffset(`${ns}-left`,   m.left);
    }
  }

  private _setSidesMode(ctrl: MarginModeController, ns: string, mode: MarginMode): void {
    const rank: Record<MarginMode, number> = { all: 1, xy: 2, each: 3 };
    const refining = rank[mode] > rank[ctrl.mode];
    const prev = this._readCurrentSides(ctrl, ns);
    ctrl.setMode(mode);

    if (mode === 'all') {
      // Always coarsening — show mixed if sides differ.
      const same = prev.top === prev.right && prev.right === prev.bottom && prev.bottom === prev.left;
      this._setOffset(`${ns}-all`, same ? prev.top : null);
    } else if (mode === 'xy') {
      const v = prev.top === prev.bottom ? prev.top : null;
      const h = prev.right === prev.left  ? prev.right : null;
      // When refining from 'all', a null v/h means the all-field was mixed —
      // leave the xy fields as-is (they still hold their previous concrete values).
      if (!refining || v !== null) this._setOffset(`${ns}-v`, v);
      if (!refining || h !== null) this._setOffset(`${ns}-h`, h);
    } else {
      // Always refining — only overwrite each field if we have a concrete value;
      // otherwise preserve whatever the each-pane already shows.
      if (prev.top    !== null) this._setOffset(`${ns}-top`,    prev.top);
      if (prev.right  !== null) this._setOffset(`${ns}-right`,  prev.right);
      if (prev.bottom !== null) this._setOffset(`${ns}-bottom`, prev.bottom);
      if (prev.left   !== null) this._setOffset(`${ns}-left`,   prev.left);
    }
    this._emit();
  }

  private _readCurrentSides(ctrl: MarginModeController, ns: string): Sides {
    if (ctrl.mode === 'all') {
      const v = this._gOffset(`${ns}-all`);
      return { top: v, right: v, bottom: v, left: v };
    }
    if (ctrl.mode === 'xy') {
      const v = this._gOffset(`${ns}-v`);
      const h = this._gOffset(`${ns}-h`);
      return { top: v, right: h, bottom: v, left: h };
    }
    return {
      top:    this._gOffset(`${ns}-top`),
      right:  this._gOffset(`${ns}-right`),
      bottom: this._gOffset(`${ns}-bottom`),
      left:   this._gOffset(`${ns}-left`),
    };
  }

  private _emit = debounce(() => {
    const bw  = this._readCurrentSides(this._borderWidthCtrl, 'bw');
    const rad = this._readCurrentSides(this._radiusCtrl, 'radius');
    const bm = {
      border: {
        width_top:    bw.top,
        width_right:  bw.right,
        width_bottom: bw.bottom,
        width_left:   bw.left,
        radius:    -1,
        radius_tl: rad.top,
        radius_tr: rad.right,
        radius_br: rad.bottom,
        radius_bl: rad.left,
        color:    this._gColor('border-color'),
        position: this._gSel('border-position'),
      },
      face_rotation_deg: this._gOffset('node-rotation'),
    };
    this.onChange(JSON.stringify(bm));
  }, 150);
}
