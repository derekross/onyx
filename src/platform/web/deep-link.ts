import type { DeepLink } from '../types';

// Web deep-links work via:
//   - URLs that land on /o/<payload>  (the SolidRouter handles the route).
//   - The HTML5 navigator.registerProtocolHandler('web+onyx', '/o/%s') (best-effort).
//
// On first launch we read window.location and forward any /o/ path to onReceived
// callbacks. Phase 2 doesn't wire the SolidRouter route yet — this is the hook
// point for it.

type Listener<T> = (value: T) => void;

const openUrlListeners = new Set<Listener<string[]>>();
const receivedListeners = new Set<Listener<string>>();

function tryRegisterProtocolHandler(): void {
  try {
    (navigator as unknown as {
      registerProtocolHandler?: (scheme: string, url: string) => void;
    }).registerProtocolHandler?.('web+onyx', '/o/%s');
  } catch {
    /* ignore — Safari and others refuse non-https or unknown schemes */
  }
}

function readLaunchUrls(): string[] {
  const path = window.location.pathname;
  if (path.startsWith('/o/')) {
    return [path.slice(3)];
  }
  return [];
}

if (typeof window !== 'undefined') {
  tryRegisterProtocolHandler();
}
// Launch URLs are delivered via getCurrent() (called from App's deep-link setup),
// not broadcast at module load — listeners register too late to receive an eager
// broadcast. The listener sets exist for future in-app dispatch (e.g. router hooks).

export const deepLink: DeepLink = {
  async onOpenUrl(cb) {
    openUrlListeners.add(cb);
    return () => {
      openUrlListeners.delete(cb);
    };
  },
  async getCurrent() {
    const urls = readLaunchUrls();
    return urls.length > 0 ? urls : null;
  },
  async getLaunchArgs() {
    return [];
  },
  async onReceived(cb) {
    receivedListeners.add(cb);
    return () => {
      receivedListeners.delete(cb);
    };
  },
};
