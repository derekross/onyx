import type { PlatformCapabilities, PlatformInfo } from '../types';

function caps(): PlatformCapabilities {
  return {
    filesystemWatch: 'FileSystemObserver' in self,
    nativeDialog: false,
    systemKeyring: false,
    openCodeLocal: false,
    openCodeRemote: false,
    ptyLocal: false,
    ptyRemote: false,
    shellOpen: true,
    haptics: 'vibrate' in navigator,
    biometric: 'PublicKeyCredential' in window,
    notifications: 'Notification' in window,
    deepLinkScheme: true,
    pushNotifications: false,
  };
}

let cached: PlatformInfo | null = null;

export async function fetchPlatformInfo(): Promise<PlatformInfo> {
  cached = {
    platform: 'web',
    default_vault_path: 'onyx-vault',
    is_web: true,
    capabilities: caps(),
  };
  return cached;
}

export function defaultPlatformInfo(): PlatformInfo {
  return {
    platform: 'web',
    default_vault_path: 'onyx-vault',
    is_web: true,
    capabilities: caps(),
  };
}

export function cachedPlatformInfo(): PlatformInfo | null {
  return cached;
}
