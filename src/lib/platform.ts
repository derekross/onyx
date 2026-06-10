/**
 * Platform Detection Utility
 *
 * Public API for platform detection. Internally delegates to the platform
 * adapter (@platform) so the same helpers work for Tauri Desktop, Tauri
 * Android, and the future Web/PWA build.
 */

import { createSignal } from 'solid-js';
import { platform } from '@platform';
import type { PlatformInfo as AdapterPlatformInfo, PlatformName } from '@platform';

// Re-exported shape kept compatible with existing call sites that destructure
// `{ platform, default_vault_path }`.
export interface PlatformInfo {
  platform: PlatformName;
  default_vault_path: string;
  is_web?: boolean;
}

const [platformInfo, setPlatformInfo] = createSignal<PlatformInfo | null>(null);
let cached: PlatformInfo | null = null;
let inflight: Promise<PlatformInfo> | null = null;

function toLocal(info: AdapterPlatformInfo): PlatformInfo {
  return {
    platform: info.platform,
    default_vault_path: info.default_vault_path ?? '',
    is_web: info.is_web,
  };
}

export async function initPlatform(): Promise<PlatformInfo> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = platform
    .refreshInfo()
    .then((info) => {
      const local = toLocal(info);
      cached = local;
      setPlatformInfo(local);
      console.log('[Platform] Detected:', local.platform);
      return local;
    })
    .catch((err) => {
      console.error('[Platform] Failed to detect platform:', err);
      const fallback: PlatformInfo = {
        platform: 'linux',
        default_vault_path: '',
      };
      cached = fallback;
      setPlatformInfo(fallback);
      return fallback;
    });

  return inflight;
}

export function getPlatformInfo(): PlatformInfo | null {
  return platformInfo();
}

export function usePlatformInfo() {
  return platformInfo;
}

export function isAndroid(): boolean {
  return cached?.platform === 'android';
}

export function isIOS(): boolean {
  return cached?.platform === 'ios';
}

export function isWeb(): boolean {
  return cached?.platform === 'web' || cached?.is_web === true;
}

export function isMobile(): boolean {
  const p = cached?.platform;
  return p === 'android' || p === 'ios';
}

export function isDesktop(): boolean {
  const p = cached?.platform;
  return p === 'macos' || p === 'windows' || p === 'linux';
}

export function isMacOS(): boolean {
  return cached?.platform === 'macos';
}

export function isWindows(): boolean {
  return cached?.platform === 'windows';
}

export function isLinux(): boolean {
  return cached?.platform === 'linux';
}

export function getPlatformName(): string {
  return cached?.platform || 'unknown';
}
