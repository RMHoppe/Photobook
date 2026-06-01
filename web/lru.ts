// lru.ts — a byte-budgeted LRU cache, drop-in compatible with the Map subset
// (get/set/has/delete) used by the image caches.
//
// Eviction drops references only; it does NOT call ImageBitmap.close(), because
// the same bitmap may be co-owned (e.g. a sidebar proxy is also handed to the
// canvas renderer). Once every cache drops a bitmap it becomes unreferenced and
// the GC reclaims it. Bounding the maps is what stops unbounded growth; misses
// are cheap to refill (buffers re-read from disk, proxies re-decoded).

export class LruCache<V> {
  private map = new Map<string, V>();
  private bytes = 0;

  /**
   * @param budgetBytes soft ceiling; the most-recently-used entry is always kept.
   * @param sizeOf      estimated retained bytes for a value.
   * @param onEvict     called when an entry is removed (by eviction or delete).
   */
  constructor(
    private readonly budgetBytes: number,
    private readonly sizeOf: (v: V) => number,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Mark as most-recently-used (re-insert moves it to the end).
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.bytes -= this.sizeOf(existing);
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += this.sizeOf(value);
    this.evict();
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.bytes -= this.sizeOf(v);
      this.map.delete(key);
      this.onEvict?.(key, v);
    }
  }

  private evict(): void {
    // Keep at least the most-recently-used entry even if it alone exceeds budget.
    while (this.bytes > this.budgetBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      const v = this.map.get(oldest)!;
      this.bytes -= this.sizeOf(v);
      this.map.delete(oldest);
      this.onEvict?.(oldest, v);
    }
  }
}

/** Estimated retained bytes for a decoded raster (RGBA = 4 bytes/px). */
export function rasterBytes(v: HTMLImageElement | ImageBitmap): number {
  const w = 'naturalWidth' in v && v.naturalWidth ? v.naturalWidth : v.width;
  const h = 'naturalHeight' in v && v.naturalHeight ? v.naturalHeight : v.height;
  return Math.max(w * h * 4, 1);
}
