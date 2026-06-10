import { invoke } from '@tauri-apps/api/core';
import type { PlatformCapabilities, PlatformInfo, PlatformName } from '../types';

interface RawPlatformInfo {
  platform: string;
  default_vault_path: string | null;
}

function capsFor(name: PlatformName): PlatformCapabilities {
  const isAndroid = name === 'android';
  const isIOS = name === 'ios';
  const isMobile = isAndroid || isIOS;
  return {
    filesystemWatch: !isMobile,
    nativeDialog: true,
    systemKeyring: !isAndroid,
    openCodeLocal: !isMobile,
    openCodeRemote: false,
    ptyLocal: !isMobile,
    ptyRemote: false,
    shellOpen: !isMobile,
    haptics: isMobile,
    biometric: isMobile,
    notifications: true,
    deepLinkScheme: true,
    pushNotifications: false,
  };
}

function normalize(raw: RawPlatformInfo): PlatformInfo {
  const platform = (raw.platform as PlatformName) ?? 'linux';
  return {
    platform,
    default_vault_path: raw.default_vault_path,
    is_web: false,
    capabilities: capsFor(platform),
  };
}

let cached: PlatformInfo | null = null;

export async function fetchPlatformInfo(): Promise<PlatformInfo> {
  const raw = await invoke<RawPlatformInfo>('get_platform_info');
  cached = normalize(raw);
  return cached;
}

export function defaultPlatformInfo(): PlatformInfo {
  // Used as a synchronous stand-in until fetchPlatformInfo resolves.
  return {
    platform: 'linux',
    default_vault_path: null,
    is_web: false,
    capabilities: capsFor('linux'),
  };
}

export function cachedPlatformInfo(): PlatformInfo | null {
  return cached;
}
