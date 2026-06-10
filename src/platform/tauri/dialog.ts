import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import type { Dialog } from '../types';

export const dialog: Dialog = {
  async open(options) {
    return (await open(options as Parameters<typeof open>[0])) as
      | string
      | string[]
      | null;
  },
  readTextFile(path) {
    return readTextFile(path);
  },
  writeTextFile(path, content) {
    return writeTextFile(path, content);
  },
  async mkdir(path, recursive = true) {
    await mkdir(path, { recursive });
  },
  pathExists(path) {
    return exists(path);
  },
};
