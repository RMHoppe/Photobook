// constants.ts — Shared UI constants for the photobook editor.

/** Padding around the spread on the canvas (px). */
export const PAD = 24;

/** Height/width of the ruler strip (px). Must match --ruler-size in CSS. */
export const RULER_SIZE = 18;

/** Sentinel node ID meaning "no selection" (matches Rust NULL_ID = u32::MAX). */
export const NULL_ID = 0xFFFFFFFF;

/** Minimum canvas zoom level. */
export const ZOOM_MIN = 0.1;

/** Maximum canvas zoom level. */
export const ZOOM_MAX = 4.0;

/** Maximum undo stack depth. */
export const UNDO_MAX = 50;

/** Maximum side length for proxy (downsampled) images used on canvas. */
export const PROXY_MAX_PX = 800;

/** Maximum side length for sidebar grid thumbnails (smaller than canvas proxy). */
export const THUMB_MAX_PX = 160;

/** JPEG quality for proxy images. */
export const PROXY_QUALITY = 0.85;

/** Maximum concurrent image decodes (createImageBitmap calls). */
export const DECODE_CONCURRENCY = 4;
