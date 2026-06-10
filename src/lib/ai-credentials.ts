/**
 * AI credential storage
 *
 * Stores AI provider secrets (OpenClaw gateway token, custom provider API key)
 * in the platform secret store (OS keyring on desktop, passphrase-sealed store
 * on web) instead of plaintext localStorage.
 *
 * Migration: legacy plaintext copies in localStorage are moved into the secret
 * store on first read and removed from localStorage. If the secret store is
 * locked or unavailable, reads fall back to the legacy localStorage value
 * (without deleting it) so existing setups keep working.
 *
 * Non-secret settings (URLs, model names, enabled flags) stay in localStorage.
 */

import { platform } from '@platform';

interface Credential {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

function createCredential(secretKey: string, legacyKey: string): Credential {
  // In-memory cache. `loaded` is only set once the secret store has been
  // successfully consulted (or a set/clear established the current value),
  // so a locked store is retried on later reads.
  let cache: string | null = null;
  let loaded = false;

  // Serializes secret-store writes so rapid successive set() calls
  // (e.g. per-keystroke saves from Settings) cannot land out of order.
  let writeChain: Promise<void> = Promise.resolve();

  async function get(): Promise<string | null> {
    if (loaded) return cache;

    try {
      let value = await platform.secrets.get(secretKey);

      // One-time migration of the legacy plaintext localStorage copy.
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        if (value === null || value === '') {
          await platform.secrets.set(secretKey, legacy);
          value = legacy;
        }
        // Secret store now holds the credential; drop the plaintext copy.
        localStorage.removeItem(legacyKey);
      }

      cache = value;
      loaded = true;
      return value;
    } catch (e) {
      // Secret store locked/unavailable: fall back to the legacy value and
      // keep it in localStorage so nothing breaks. Do not cache, so the
      // secret store (and migration) is retried once it unlocks.
      console.warn(`Secret store unavailable for ${secretKey}, using legacy fallback:`, e);
      return localStorage.getItem(legacyKey);
    }
  }

  async function set(value: string): Promise<void> {
    cache = value;
    loaded = true;
    writeChain = writeChain.then(async () => {
      try {
        await platform.secrets.set(secretKey, value);
        // Successful secret write: always remove the plaintext copy.
        localStorage.removeItem(legacyKey);
      } catch (e) {
        // Secret store locked/unavailable: fall back to localStorage so the
        // credential is not lost.
        console.warn(`Secret store write failed for ${secretKey}, falling back to localStorage:`, e);
        localStorage.setItem(legacyKey, value);
      }
    });
    return writeChain;
  }

  async function clear(): Promise<void> {
    cache = null;
    loaded = true;
    localStorage.removeItem(legacyKey);
    writeChain = writeChain.then(async () => {
      try {
        await platform.secrets.delete(secretKey);
      } catch (e) {
        // Best-effort: store may be locked or the key may not exist.
        console.warn(`Secret store delete failed for ${secretKey}:`, e);
      }
    });
    return writeChain;
  }

  return { get, set, clear };
}

// Secret-store keys use the same 'onyx:' namespace as src/lib/nostr/login.ts.
// The second argument is the legacy plaintext localStorage key being migrated.
const openClawToken = createCredential('onyx:openclaw_token', 'openclaw_token');
const customProviderApiKey = createCredential(
  'onyx:custom_provider_api_key',
  'custom_provider_api_key',
);

// --- OpenClaw gateway token ---

export async function getOpenClawToken(): Promise<string | null> {
  return openClawToken.get();
}

export async function setOpenClawToken(value: string): Promise<void> {
  return openClawToken.set(value);
}

export async function clearOpenClawToken(): Promise<void> {
  return openClawToken.clear();
}

// --- Custom provider API key ---

export async function getCustomProviderApiKey(): Promise<string | null> {
  return customProviderApiKey.get();
}

export async function setCustomProviderApiKey(value: string): Promise<void> {
  return customProviderApiKey.set(value);
}

export async function clearCustomProviderApiKey(): Promise<void> {
  return customProviderApiKey.clear();
}
