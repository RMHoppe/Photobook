import { marked } from 'marked';
import type { Tokens } from 'marked';

interface DocEntry {
  title: string;
  file: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

marked.use({
  renderer: {
    heading({ tokens, depth, text }: Tokens.Heading): string {
      const id = slugify(text);
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
    },
  },
});

export class DocsPanel {
  private modal: HTMLDialogElement;
  private nav: HTMLElement;
  private content: HTMLElement;
  private entries: DocEntry[] = [];

  constructor() {
    this.modal   = document.getElementById('docs-modal') as HTMLDialogElement;
    this.nav     = document.getElementById('docs-nav')!;
    this.content = document.getElementById('docs-content')!;

    document.getElementById('docs-close')!.addEventListener('click', () => this.close());

    // Click on the backdrop (the dialog element itself, not its children) closes.
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }

  async open(file?: string): Promise<void> {
    if (!this.entries.length) {
      await this._loadIndex();
    }
    const target = file ?? this.entries[0]?.file;
    if (target) await this._showDoc(target);
    this.modal.showModal();
  }

  close(): void {
    this.modal.close();
  }

  private async _loadIndex(): Promise<void> {
    const res = await fetch('docs/index.json');
    this.entries = (await res.json()) as DocEntry[];
    this._renderNav();
  }

  private _renderNav(): void {
    this.nav.innerHTML = '';
    for (const entry of this.entries) {
      const btn = document.createElement('button');
      btn.className = 'docs-nav-item';
      btn.textContent = entry.title;
      btn.dataset.file = entry.file;
      btn.addEventListener('click', () => this._showDoc(entry.file));
      this.nav.appendChild(btn);
    }
  }

  private async _showDoc(file: string): Promise<void> {
    for (const btn of Array.from(this.nav.querySelectorAll<HTMLElement>('.docs-nav-item'))) {
      btn.classList.toggle('active', btn.dataset.file === file);
    }

    this.content.innerHTML = '<p class="docs-loading">Loading…</p>';

    const res = await fetch(`docs/${file}`);
    const md  = await res.text();
    this.content.innerHTML = marked(md) as string;
    this.content.scrollTop = 0;
  }
}
