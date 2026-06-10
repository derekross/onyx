import type { Assets } from '../types';
import { tryResolveFile } from './vault/opfs';

// Blob URL cache keyed by absolute vault path. Limited LRU to prevent leaks
// when the user opens many embedded images / PDFs.
const MAX_ENTRIES = 200;
const cache = new Map<string, string>();

function mimeFor(ext: string): string {
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'avif': return 'image/avif';
    case 'pdf': return 'application/pdf';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'ogg': return 'audio/ogg';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mov': return 'video/quicktime';
    default: return 'application/octet-stream';
  }
}

function getActiveVault(): string | null {
  // The vault adapter stores currentVault internally; for asset resolution we
  // read from window.__onyxVault, set on vault.setVaultScope. Avoids a circular
  // import.
  return (window as unknown as { __onyxVault?: string }).__onyxVault ?? null;
}

async function buildBlobUrl(absolutePath: string): Promise<string> {
  const vault = getActiveVault();
  if (!vault) throw new Error('No active vault for asset resolution');
  const handle = await tryResolveFile(vault, absolutePath);
  if (!handle) throw new Error(`Asset not found: ${absolutePath}`);
  const file = await handle.getFile();
  const ext = absolutePath.split('.').pop()?.toLowerCase() ?? '';
  const blob = new Blob([await file.arrayBuffer()], { type: mimeFor(ext) });
  return URL.createObjectURL(blob);
}

function touchLRU(key: string, url: string): void {
  // Re-insert to move to end
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldestUrl = cache.get(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    cache.delete(oldestKey);
  }
}

export const assets: Assets = {
  resolveAssetUrl(absolutePath) {
    const hit = cache.get(absolutePath);
    if (hit) {
      // Move to MRU
      cache.delete(absolutePath);
      cache.set(absolutePath, hit);
      return hit;
    }
    return buildBlobUrl(absolutePath).then((url) => {
      touchLRU(absolutePath, url);
      return url;
    });
  },
  revokeAssetUrl(url) {
    for (const [key, value] of cache.entries()) {
      if (value === url) {
        cache.delete(key);
        break;
      }
    }
    URL.revokeObjectURL(url);
  },
};
