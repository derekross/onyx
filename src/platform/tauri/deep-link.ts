import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import type { DeepLink } from '../types';

export const deepLink: DeepLink = {
  async onOpenUrl(cb) {
    const off = await onOpenUrl(cb);
    return () => off();
  },
  getCurrent() {
    return getCurrent();
  },
  getLaunchArgs() {
    return invoke<string[]>('get_deep_link_args');
  },
  async onReceived(cb) {
    const off = await listen<string>('deep-link-received', (event) => cb(event.payload));
    return () => off();
  },
};
