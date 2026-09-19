// persist.ts — Best-effort session persistence.
//
// IndexedDB stores what must survive a reload: the autosaved document
// (crash/close recovery) and FileSystemDirectoryHandle objects for recently
// opened image folders (one-click re-link; handles can only live in
// structured-clone storage, not localStorage). localStorage holds small view
// preferences. Everything here swallows failures — persistence must never
// break the editor (private windows, denied quota, browsers without the
// File System Access API…).

const DB_NAME = 'photobook-persist';
const KV_STORE = 'kv';
const RECENT_FOLDER_MAX = 5;

let _db: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  _db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(KV_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const store = (await db()).transaction(KV_STORE, 'readonly').objectStore(KV_STORE);
    return await new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const tx = (await db()).transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).put(value, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Autosave — crash/close recovery for the current document
// ---------------------------------------------------------------------------

export interface Autosave {
  /** Raw editor.save_state() JSON. */
  json: string;
  /** Last project name the user saved under. */
  name: string;
  /** Epoch ms of the autosave. */
  saved: number;
}

export async function readAutosave(): Promise<Autosave | null> {
  return (await idbGet<Autosave>('autosave')) ?? null;
}

export function writeAutosave(json: string, name: string): Promise<void> {
  return idbSet('autosave', { json, name, saved: Date.now() } satisfies Autosave);
}

export async function clearAutosave(): Promise<void> {
  try {
    const tx = (await db()).transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).delete('autosave');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Recent image folders — directory handles for one-click re-link
// ---------------------------------------------------------------------------

export async function recentFolders(): Promise<FileSystemDirectoryHandle[]> {
  return (await idbGet<FileSystemDirectoryHandle[]>('recent-folders')) ?? [];
}

/** Put `handle` at the front of the recent-folders list (deduplicated, capped). */
export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const kept: FileSystemDirectoryHandle[] = [];
    for (const h of await recentFolders()) {
      const same = await h.isSameEntry(handle).catch(() => false);
      if (!same) kept.push(h);
    }
    await idbSet('recent-folders', [handle, ...kept].slice(0, RECENT_FOLDER_MAX));
  } catch {
    /* best effort */
  }
}

/**
 * Re-acquire read permission on a stored handle. With `ask` the browser may
 * show a permission prompt, which requires a user gesture; without it only
 * an already-granted permission succeeds.
 */
export async function folderPermission(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  type WithPermissions = {
    queryPermission?(desc: { mode: string }): Promise<string>;
    requestPermission?(desc: { mode: string }): Promise<string>;
  };
  const h = handle as FileSystemDirectoryHandle & WithPermissions;
  try {
    if ((await h.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    if (!ask) return false;
    return (await h.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Print-on-demand order history — device-local (an order belongs to a
// person/device/provider session, not to the project file)
// ---------------------------------------------------------------------------

const POD_ORDERS_MAX = 20;

export interface PodOrderRecord {
  /** Local record id (uuid). */
  id: string;
  providerId: string;
  /** Provider-side reference for status lookups / checkout reopening. */
  orderRef: string;
  specId: string;
  productId: string;
  options: Record<string, string>;
  pdfPageCount: number;
  quote: { currency: string; total: number } | null;
  checkoutUrl: string | null;
  /** OrderPhase, stored as a plain string to keep persist.ts dependency-free. */
  status: string;
  created: number;
  updated: number;
  projectName: string;
}

export async function readPodOrders(): Promise<PodOrderRecord[]> {
  return (await idbGet<PodOrderRecord[]>('pod-orders')) ?? [];
}

/** Insert or update (matched by `id`); newest first, capped. */
export async function upsertPodOrder(rec: PodOrderRecord): Promise<void> {
  try {
    const rest = (await readPodOrders()).filter(r => r.id !== rec.id);
    await idbSet('pod-orders', [rec, ...rest].slice(0, POD_ORDERS_MAX));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// View preferences — localStorage (small, synchronous)
// ---------------------------------------------------------------------------

const PREFS_KEY = 'photobook-prefs';

export interface ViewPrefs {
  showBleed?: boolean;
  showSafeZone?: boolean;
}

export function readPrefs(): ViewPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as ViewPrefs;
  } catch {
    return {};
  }
}

export function writePrefs(patch: Partial<ViewPrefs>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    /* best effort */
  }
}
