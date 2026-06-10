import type { Clipboard } from '../types';

export const clipboard: Clipboard = {
  async readText() {
    if (!navigator.clipboard?.readText) return '';
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  },
  async writeText(text) {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text);
  },
  async readImage() {
    // navigator.clipboard.read() returns ClipboardItem[]; decoding to raw RGBA
    // would require a canvas roundtrip. Not needed in Phase 2 — return null.
    return null;
  },
};
