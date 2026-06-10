import type { AppLifecycle } from '../types';

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string) ?? 'web-dev';

export const app: AppLifecycle = {
  async getVersion() {
    return APP_VERSION;
  },
  async onBackButton(_cb) {
    // No browser equivalent of an Android back gesture. No-op.
    return () => {};
  },
};
