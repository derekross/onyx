import { getVersion, onBackButtonPress } from '@tauri-apps/api/app';
import type { AppLifecycle } from '../types';

export const app: AppLifecycle = {
  getVersion() {
    return getVersion();
  },
  async onBackButton(cb) {
    const listener = await onBackButtonPress((event) => {
      void cb({ canGoBack: event.canGoBack });
    });
    return () => {
      void listener.unregister();
    };
  },
};
