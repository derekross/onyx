import { convertFileSrc } from '@tauri-apps/api/core';
import type { Assets } from '../types';

export const assets: Assets = {
  resolveAssetUrl(absolutePath) {
    return convertFileSrc(absolutePath);
  },
};
