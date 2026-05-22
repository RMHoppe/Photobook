// margin-mode-controller.ts — Shared margin mode selector (All / X·Y / Each).

export type MarginMode = 'all' | 'xy' | 'each';

export type Sides = { top: number | null; right: number | null; bottom: number | null; left: number | null };

export function detectMarginMode(m: Sides): MarginMode {
  const { top: t, right: r, bottom: b, left: l } = m;
  if (t == null || r == null || b == null || l == null) return 'each';
  if (t === r && r === b && b === l) return 'all';
  if (t === b && l === r) return 'xy';
  return 'each';
}

export class MarginModeController {
  private _mode: MarginMode = 'each';
  private readonly _ns: string;

  constructor(private readonly el: HTMLElement, namespace = 'margin') {
    this._ns = namespace;
  }

  get mode(): MarginMode { return this._mode; }

  setMode(mode: MarginMode): void {
    this._mode = mode;
    this._apply();
  }

  bindButtons(onModeChange: (mode: MarginMode) => void): void {
    this.el.querySelectorAll<HTMLButtonElement>(`[data-${this._ns}-mode]`).forEach(btn => {
      btn.addEventListener('click', () => {
        // Call onModeChange first so it can read the current (old) mode before switching.
        // onModeChange is responsible for calling setMode itself.
        onModeChange(btn.dataset[`${this._ns}Mode`] as MarginMode);
      });
    });
  }

  private _apply(): void {
    this.el.querySelectorAll<HTMLElement>(`[data-${this._ns}-pane]`).forEach(pane => {
      pane.classList.toggle('active', pane.dataset[`${this._ns}Pane`] === this._mode);
    });
    this.el.querySelectorAll<HTMLButtonElement>(`[data-${this._ns}-mode]`).forEach(btn => {
      btn.classList.toggle('active', btn.dataset[`${this._ns}Mode`] === this._mode);
    });
  }
}

export function marginSectionHtml(
  title: string,
  fieldFn: (name: string, label: string) => string,
  ns = 'margin',
): string {
  return `
      <div class="bm-section">
        <div class="bm-section-header">
          <h4>${title}</h4>
          <div class="margin-mode-bar">
            <button class="margin-mode-btn" data-${ns}-mode="all"  title="All sides equal"><i class="fa-regular fa-square"></i></button>
            <button class="margin-mode-btn" data-${ns}-mode="xy"   title="Vertical / Horizontal"><i class="fa-solid fa-border-top-left"></i></button>
            <button class="margin-mode-btn" data-${ns}-mode="each" title="Each side individually"><i class="fa-solid fa-border-none"></i></button>
          </div>
        </div>
        <div class="margin-pane" data-${ns}-pane="all">
          <div class="bm-grid">${fieldFn(`${ns}-all`, 'All')}</div>
        </div>
        <div class="margin-pane" data-${ns}-pane="xy">
          <div class="bm-grid">
            ${fieldFn(`${ns}-v`, 'Vertical')}
            ${fieldFn(`${ns}-h`, 'Horizontal')}
          </div>
        </div>
        <div class="margin-pane" data-${ns}-pane="each">
          <div class="bm-grid">
            ${fieldFn(`${ns}-top`,    'Top')}
            ${fieldFn(`${ns}-right`,  'Right')}
            ${fieldFn(`${ns}-bottom`, 'Bottom')}
            ${fieldFn(`${ns}-left`,   'Left')}
          </div>
        </div>
      </div>`;
}
