// fonts.ts — Local Font Access API wrapper.

// Minimal interface for the Local Font Access API (Chrome 103+).
interface FontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
  blob(): Promise<Blob>;
}

declare global {
  interface Window {
    queryLocalFonts?(options?: { postscriptNames?: string[] }): Promise<FontData[]>;
  }
}

// Indexed by family name → list of faces.
let _fontsByFamily: Map<string, FontData[]> = new Map();

// Byte cache: postscriptName → ArrayBuffer.
const _fontBytes: Map<string, ArrayBuffer> = new Map();

/** Returns sorted unique family names, or [] if the API is unavailable / denied. */
export async function loadLocalFonts(): Promise<string[]> {
  if (typeof window.queryLocalFonts !== 'function') return [];
  let faces: FontData[];
  try {
    faces = await window.queryLocalFonts();
  } catch {
    // User denied permission or API threw.
    return [];
  }

  _fontsByFamily = new Map();
  for (const face of faces) {
    const list = _fontsByFamily.get(face.family) ?? [];
    list.push(face);
    _fontsByFamily.set(face.family, list);
  }
  return [..._fontsByFamily.keys()].sort((a, b) => a.localeCompare(b));
}

/** True if the Local Font Access API is supported in this browser. */
export function localFontsSupported(): boolean {
  return typeof window.queryLocalFonts === 'function';
}

export type FontLoadErrorCode = 'not_supported' | 'denied';

export interface FontLoadResult {
  families: string[];
  error: FontLoadErrorCode | null;
}

/**
 * Like loadLocalFonts() but returns an error code instead of silently returning [].
 * Use this when you need to distinguish "not supported" from "denied".
 */
export async function tryLoadLocalFonts(): Promise<FontLoadResult> {
  if (typeof window.queryLocalFonts !== 'function') {
    return { families: [], error: 'not_supported' };
  }
  let faces: FontData[];
  try {
    faces = await window.queryLocalFonts();
  } catch {
    return { families: [], error: 'denied' };
  }
  _fontsByFamily = new Map();
  for (const face of faces) {
    const list = _fontsByFamily.get(face.family) ?? [];
    list.push(face);
    _fontsByFamily.set(face.family, list);
  }
  return { families: [..._fontsByFamily.keys()].sort((a, b) => a.localeCompare(b)), error: null };
}

/**
 * Return the raw TTF/OTF bytes for the best-matching face of `family`.
 * Returns null if the family was not discovered or the blob read fails.
 */
export async function getFontBytes(
  family: string,
  bold: boolean,
  italic: boolean,
): Promise<ArrayBuffer | null> {
  const faces = _fontsByFamily.get(family);
  if (!faces || faces.length === 0) return null;

  // Score each face by how well its style string matches bold/italic.
  const score = (f: FontData): number => {
    const s = f.style.toLowerCase();
    const hasBold   = s.includes('bold')   || s.includes('heavy') || s.includes('black');
    const hasItalic = s.includes('italic') || s.includes('oblique');
    return (hasBold === bold ? 2 : 0) + (hasItalic === italic ? 1 : 0);
  };
  const best = faces.reduce((a, b) => (score(a) >= score(b) ? a : b));

  const cached = _fontBytes.get(best.postscriptName);
  if (cached) return cached;

  try {
    const blob = await best.blob();
    const buf = await blob.arrayBuffer();
    _fontBytes.set(best.postscriptName, buf);
    return buf;
  } catch {
    return null;
  }
}
