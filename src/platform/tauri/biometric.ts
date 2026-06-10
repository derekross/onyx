// Tauri biometric adapter — uses @tauri-apps/plugin-biometric on mobile.

import type { Biometric, BiometricStatus } from '../types';
import { cachedPlatformInfo } from './info';

type BiometricModule = typeof import('@tauri-apps/plugin-biometric');
let modulePromise: Promise<BiometricModule | null> | null = null;

function isMobile(): boolean {
  const info = cachedPlatformInfo();
  return info ? info.platform === 'android' || info.platform === 'ios' : false;
}

async function load(): Promise<BiometricModule | null> {
  if (!isMobile()) return null;
  if (!modulePromise) {
    modulePromise = import('@tauri-apps/plugin-biometric').catch((err) => {
      console.warn('[Biometric] Failed to load plugin:', err);
      return null;
    });
  }
  return modulePromise;
}

export const biometric: Biometric = {
  async checkStatus(): Promise<BiometricStatus> {
    const m = await load();
    if (!m) return { isAvailable: false };
    try {
      const status = await m.checkStatus();
      return {
        isAvailable: status.isAvailable,
        biometryType: status.biometryType?.toString(),
        error: status.error,
      };
    } catch (err) {
      return { isAvailable: false, error: String(err) };
    }
  },
  async authenticate(reason) {
    const m = await load();
    // On desktop the OS keyring handles security — treat as authenticated.
    if (!m) return true;
    try {
      const status = await m.checkStatus();
      if (!status.isAvailable) return true;
      await m.authenticate(reason, { allowDeviceCredential: true });
      return true;
    } catch (err) {
      console.error('[Biometric] auth failed:', err);
      return false;
    }
  },
};
