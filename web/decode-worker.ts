// decode-worker.ts — decodes + downsizes image proxies off the main thread.
//
// `createImageBitmap` already decodes off-thread in modern browsers, but routing
// it through a worker also moves the resize/allocation work and any fallback
// path off the UI thread, keeping large-folder browsing smooth. The decoded
// ImageBitmap is transferred back (zero-copy).

interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}
const ctx = self as unknown as WorkerCtx;

interface DecodeRequest { reqId: number; bytes: ArrayBuffer; maxWidth: number; }

ctx.addEventListener('message', async (e: MessageEvent) => {
  const msg = e.data as DecodeRequest;
  if (!msg || typeof msg.reqId !== 'number') return;

  try {
    const blob = new Blob([msg.bytes]);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: msg.maxWidth,
        resizeQuality: 'medium',
      } as ImageBitmapOptions);
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    ctx.postMessage({ reqId: msg.reqId, ok: true, bitmap }, [bitmap]);
  } catch (err) {
    ctx.postMessage({ reqId: msg.reqId, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});
