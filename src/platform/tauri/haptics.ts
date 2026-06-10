// Tauri haptics adapter — uses @tauri-apps/plugin-haptics on mobile.
// Plugin is dynamically imported so desktop builds don't carry it.

import type { Haptics } from '../types';
import { cachedPlatformInfo } from './info';

type HapticsModule = typeof import('@tauri-apps/plugin-haptics');
let modulePromise: Promise<HapticsModule | null> | null = null;

function isMobile(): boolean {
  const info = cachedPlatformInfo();
  return info ? info.platform === 'android' || info.platform === 'ios' : false;
}

async function load(): Promise<HapticsModule | null> {
  if (!isMobile()) return null;
  if (!modulePromise) {
    modulePromise = import('@tauri-apps/plugin-haptics').catch((err) => {
      console.warn('[Haptics] Failed to load plugin:', err);
      return null;
    });
  }
  return modulePromise;
}

async function safe(run: (m: HapticsModule) => Promise<unknown> | unknown) {
  const m = await load();
  if (!m) return;
  try {
    await run(m);
  } catch {
    /* haptics are best-effort */
  }
}

export const haptics: Haptics = {
  impact(style) {
    return safe((m) => m.impactFeedback(style)).then(() => undefined);
  },
  notification(style) {
    return safe((m) => m.notificationFeedback(style)).then(() => undefined);
  },
  selection() {
    return safe((m) => m.selectionFeedback()).then(() => undefined);
  },
  vibrate(durationMs) {
    return safe((m) => m.vibrate(durationMs)).then(() => undefined);
  },
};
