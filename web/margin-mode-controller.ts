// margin-mode-controller.ts — Shared margin mode selector (All / X·Y / Each).

export type MarginMode = 'all' | 'xy' | 'each';

export class MarginModeController {
  private _mode: MarginMode = 'each';

  constructor(private readonly el: HTMLElement) {}

  get mode(): MarginMode { return this._mode; }

  setMode(mode: MarginMode): void {
    this._mode = mode;
    this._apply();
  }

  bindButtons(onModeChange: (mode: MarginMode) => void): void {
    this.el.querySelectorAll<HTMLButtonElement>('[data-margin-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.marginMode as MarginMode;
        this.setMode(mode);
        onModeChange(mode);
      });
    });
  }

  private _apply(): void {
    this.el.querySelectorAll<HTMLElement>('[data-margin-pane]').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.marginPane === this._mode);
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-margin-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.marginMode === this._mode);
    });
  }
}

export function marginSectionHtml(
  title: string,
  fieldFn: (name: string, label: string) => string,
): string {
  return `
      <div class="bm-section">
        <div class="bm-section-header">
          <h4>${title}</h4>
          <div class="margin-mode-bar">
            <button class="margin-mode-btn" data-margin-mode="all"  title="All sides equal">All</button>
            <button class="margin-mode-btn" data-margin-mode="xy"   title="Vertical / Horizontal">X·Y</button>
            <button class="margin-mode-btn" data-margin-mode="each" title="Each side individually">Each</button>
          </div>
        </div>
        <div class="margin-pane" data-margin-pane="all">
          <div class="bm-grid">${fieldFn('margin-all', 'All')}</div>
        </div>
        <div class="margin-pane" data-margin-pane="xy">
          <div class="bm-grid">
            ${fieldFn('margin-v', 'Vertical')}
            ${fieldFn('margin-h', 'Horizontal')}
          </div>
        </div>
        <div class="margin-pane" data-margin-pane="each">
          <div class="bm-grid">
            ${fieldFn('margin-top',    'Top')}
            ${fieldFn('margin-right',  'Right')}
            ${fieldFn('margin-bottom', 'Bottom')}
            ${fieldFn('margin-left',   'Left')}
          </div>
        </div>
      </div>`;
}
