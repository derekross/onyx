import { readText, writeText, readImage } from '@tauri-apps/plugin-clipboard-manager';
import type { Clipboard, ClipboardImage } from '../types';

export const clipboard: Clipboard = {
  readText() {
    return readText();
  },
  writeText(text) {
    return writeText(text);
  },
  async readImage(): Promise<ClipboardImage | null> {
    try {
      const img = await readImage();
      if (!img) return null;
      const rgba = await img.rgba();
      const size = await img.size();
      return {
        rgba: rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba),
        width: size.width,
        height: size.height,
      };
    } catch {
      return null;
    }
  },
};
