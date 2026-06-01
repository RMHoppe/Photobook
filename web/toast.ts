// toast.ts — lightweight, dependency-free toast notifications.
//
// Reuses the visual language of the existing `.font-toast` (see styles.css): a
// dark pill anchored bottom-right. Toasts stack and auto-dismiss; `error` toasts
// stay until dismissed so failures aren't missed.

export type ToastKind = 'info' | 'error';

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container) return container;
  const el = document.createElement('div');
  el.className = 'toast-container';
  document.body.appendChild(el);
  container = el;
  return el;
}

/**
 * Show a toast. `info` auto-dismisses after `durationMs` (default 4 s);
 * `error` stays until the user dismisses it (pass a duration to override).
 */
export function showToast(message: string, kind: ToastKind = 'info', durationMs?: number): void {
  const root = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `app-toast app-toast--${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'app-toast-text';
  text.textContent = message;

  const dismiss = document.createElement('button');
  dismiss.className = 'banner-dismiss';
  dismiss.title = 'Dismiss';
  dismiss.innerHTML = '<i class="fa-solid fa-xmark"></i>';

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    toast.remove();
  };
  dismiss.addEventListener('click', remove);

  toast.append(text, dismiss);
  root.appendChild(toast);

  const ttl = durationMs ?? (kind === 'error' ? 0 : 4000);
  if (ttl > 0) setTimeout(remove, ttl);
}
