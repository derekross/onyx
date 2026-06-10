import type { Shell } from '../types';

export const shell: Shell = {
  async openInDefaultApp(path) {
    // Browser cannot invoke an OS app. Fallback: trigger a download.
    const a = document.createElement('a');
    a.href = path;
    a.download = path.split('/').pop() ?? 'file';
    a.rel = 'noopener';
    a.click();
  },
  async showInFolder(_path) {
    // No browser equivalent. No-op.
  },
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
