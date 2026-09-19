// sidebar-divider.ts — DividerPanel (shown in sidebar when a divider is selected).

import type { BoundaryGap, MultiDividerGaps } from './types.js';

type AxisMode = 'all' | 'h' | 'v';

export class DividerPanel {
  private containerEl: HTMLElement;
  private onChangeAll: (halfValue: number) => void;
  private onChangeA: (axis: 'h' | 'v', v: number) => void;
  private onChangeB: (axis: 'h' | 'v', v: number) => void;
  private onChangeBoundary: (v: number) => void;
  private _built = false;
  private _builtBoundary = false;
  private _axisMode: AxisMode = 'all';

  constructor(
    containerEl: HTMLElement,
    onChangeAll: (halfValue: number) => void,
    onChangeA: (axis: 'h' | 'v', v: number) => void,
    onChangeB: (axis: 'h' | 'v', v: number) => void,
    onChangeBoundary: (v: number) => void,
  ) {
    this.containerEl = containerEl;
    this.onChangeAll = onChangeAll;
    this.onChangeA = onChangeA;
    this.onChangeB = onChangeB;
    this.onChangeBoundary = onChangeBoundary;
  }

  show(data: MultiDividerGaps): void {
    if (this._builtBoundary) this._teardown();
    if (!this._built) this._build();

    const hasH = data.h !== null;
    const hasV = data.v !== null;

    // Fall back to 'all' if the active axis has no data.
    if ((this._axisMode === 'h' && !hasH) || (this._axisMode === 'v' && !hasV)) {
      this._axisMode = 'all';
    }

    this._updateAxisButtons(hasH, hasV);
    this._activatePane(this._axisMode);

    if (this._axisMode === 'all') {
      const total = _computeAllTotal(data);
      const inp = this.containerEl.querySelector('#divider-gap-all') as HTMLInputElement;
      if (inp) {
        if (total === null) { inp.value = ''; inp.placeholder = 'Mixed'; }
        else { inp.value = total.toFixed(2); inp.placeholder = ''; }
      }
    } else {
      const gaps = data[this._axisMode] ?? { a: null, b: null };
      const [la, lb] = _axisLabels(this._axisMode);
      const elA = this.containerEl.querySelector('[data-label="a"]');
      const elB = this.containerEl.querySelector('[data-label="b"]');
      if (elA) elA.textContent = la;
      if (elB) elB.textContent = lb;
      const inpA = this.containerEl.querySelector('#divider-gap-a') as HTMLInputElement;
      const inpB = this.containerEl.querySelector('#divider-gap-b') as HTMLInputElement;
      if (inpA) {
        if (gaps.a === null) { inpA.value = ''; inpA.placeholder = 'Mixed'; }
        else { inpA.value = gaps.a.toFixed(2); inpA.placeholder = ''; }
      }
      if (inpB) {
        if (gaps.b === null) { inpB.value = ''; inpB.placeholder = 'Mixed'; }
        else { inpB.value = gaps.b.toFixed(2); inpB.placeholder = ''; }
      }
    }
  }

  showBoundary(data: BoundaryGap): void {
    if (this._built) this._teardown();
    if (!this._builtBoundary) this._buildBoundary();
    const label = this.containerEl.querySelector('[data-label="boundary"]');
    if (label) label.textContent = _boundaryLabel(data.side);
    const input = this.containerEl.querySelector('#boundary-gap') as HTMLInputElement;
    if (input) { input.value = data.gap.toFixed(2); input.placeholder = ''; }
  }

  private _teardown(): void {
    this.containerEl.innerHTML = '';
    this._built = false;
    this._builtBoundary = false;
    this._axisMode = 'all';
  }

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'divider';
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <div class="bm-section-header">
          <h4>Gap (mm)</h4>
          <div class="divider-axis-bar">
            <button class="divider-axis-btn" data-divider-axis="all" title="All dividers">All</button>
            <button class="divider-axis-btn" data-divider-axis="h"   title="Horizontal dividers">H</button>
            <button class="divider-axis-btn" data-divider-axis="v"   title="Vertical dividers">V</button>
          </div>
        </div>
        <div class="divider-pane" data-divider-pane="all">
          <div class="bm-grid">
            <div class="bm-field">
              <label>Total (mm)</label>
              <input id="divider-gap-all" type="number" min="-50" max="50" step="0.5" value="0" />
            </div>
          </div>
        </div>
        <div class="divider-pane" data-divider-pane="axes">
          <div class="bm-grid">
            <div class="bm-field">
              <label data-label="a">Left (mm)</label>
              <input id="divider-gap-a" type="number" min="-50" max="50" step="0.5" value="0" />
            </div>
            <div class="bm-field">
              <label data-label="b">Right (mm)</label>
              <input id="divider-gap-b" type="number" min="-50" max="50" step="0.5" value="0" />
            </div>
          </div>
        </div>
      </div>`;

    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-divider-axis]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._axisMode = btn.dataset.dividerAxis as AxisMode;
        this._activatePane(this._axisMode);
        this._markActiveButton();
        // Labels update on the next show() call; values will refresh with refreshBoxModel.
      });
    });

    const inpAll = this.containerEl.querySelector('#divider-gap-all') as HTMLInputElement;
    inpAll.addEventListener('change', () => {
      const v = parseFloat(inpAll.value);
      if (!isNaN(v)) this.onChangeAll(v / 2);
    });

    const inpA = this.containerEl.querySelector('#divider-gap-a') as HTMLInputElement;
    const inpB = this.containerEl.querySelector('#divider-gap-b') as HTMLInputElement;
    inpA.addEventListener('change', () => {
      const v = parseFloat(inpA.value);
      if (!isNaN(v)) this.onChangeA(this._axisMode as 'h' | 'v', v);
    });
    inpB.addEventListener('change', () => {
      const v = parseFloat(inpB.value);
      if (!isNaN(v)) this.onChangeB(this._axisMode as 'h' | 'v', v);
    });

    this._activatePane('all');
    this._markActiveButton();
  }

  private _activatePane(mode: AxisMode): void {
    const paneKey = mode === 'all' ? 'all' : 'axes';
    this.containerEl.querySelectorAll<HTMLElement>('[data-divider-pane]').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.dividerPane === paneKey);
    });
  }

  private _markActiveButton(): void {
    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-divider-axis]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.dividerAxis === this._axisMode);
    });
  }

  private _updateAxisButtons(hasH: boolean, hasV: boolean): void {
    const btnH = this.containerEl.querySelector<HTMLButtonElement>('[data-divider-axis="h"]');
    const btnV = this.containerEl.querySelector<HTMLButtonElement>('[data-divider-axis="v"]');
    if (btnH) btnH.hidden = !hasH;
    if (btnV) btnV.hidden = !hasV;
    this._markActiveButton();
  }

  private _buildBoundary(): void {
    this._builtBoundary = true;
    this.containerEl.dataset.panel = 'divider-boundary';
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Edge Gap (mm)</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label data-label="boundary">Edge</label>
            <input id="boundary-gap" type="number" min="0" max="50" step="0.5" value="0" />
          </div>
        </div>
      </div>`;

    const input = this.containerEl.querySelector('#boundary-gap') as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!isNaN(v)) this.onChangeBoundary(v);
    });
  }
}

function _axisLabels(axis: 'h' | 'v'): [string, string] {
  return axis === 'v' ? ['Left (mm)', 'Right (mm)'] : ['Top (mm)', 'Bottom (mm)'];
}

function _computeAllTotal(data: MultiDividerGaps): number | null {
  const totals: (number | null)[] = [];
  if (data.h !== null) {
    totals.push(data.h.a !== null && data.h.b !== null ? data.h.a + data.h.b : null);
  }
  if (data.v !== null) {
    totals.push(data.v.a !== null && data.v.b !== null ? data.v.a + data.v.b : null);
  }
  if (totals.length === 0) return 0;
  const first = totals[0];
  if (first === null) return null;
  for (const t of totals) {
    if (t === null || Math.abs(t - first) > 1e-3) return null;
  }
  return first;
}

function _boundaryLabel(side: BoundaryGap['side']): string {
  return { top: 'Top (mm)', bottom: 'Bottom (mm)', left: 'Left (mm)', right: 'Right (mm)' }[side];
}
