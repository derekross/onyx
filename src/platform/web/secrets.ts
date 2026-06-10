// WebCrypto-sealed secret store.
//
// Lifecycle:
//   1. User sets a master passphrase via unlock(). PBKDF2 derives a 256-bit
//      AES-GCM key from passphrase + per-install salt.
//   2. Secrets are stored encrypted (12-byte IV per entry) in IDB store 'secrets'.
//   3. Reads decrypt on access; writes encrypt before persist.
//   4. isLocked() reports whether the key has been derived for this session.
//
// First-time setup: the first write with no salt persists a new salt to 'meta'.

import type { SecretStore } from '../types';
import { getDB } from './idb';

// OWASP guidance for PBKDF2-HMAC-SHA256 (2023+): >= 600k iterations.
const PBKDF2_ITERS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SALT_KEY = 'master_salt';

let derivedKey: CryptoKey | null = null;

function bytesToBase64(buf: Uint8Array): string {
  let str = '';
  for (let i = 0; i < buf.length; i++) str += String.fromCharCode(buf[i]);
  return btoa(str);
}

function base64ToBytes(b64: string): Uint8Array {
  const str = atob(b64);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

async function getOrCreateSalt(): Promise<Uint8Array> {
  const db = await getDB();
  const existing = (await db.get('meta', SALT_KEY)) as string | undefined;
  if (existing) return base64ToBytes(existing);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  await db.put('meta', bytesToBase64(salt), SALT_KEY);
  return salt;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

interface SealedRecord {
  iv: string;       // base64
  ciphertext: string; // base64
}

async function seal(plaintext: string): Promise<SealedRecord> {
  if (!derivedKey) throw new Error('Secret store is locked');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    derivedKey,
    new TextEncoder().encode(plaintext),
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
  };
}

async function unseal(record: SealedRecord): Promise<string> {
  if (!derivedKey) throw new Error('Secret store is locked');
  const iv = base64ToBytes(record.iv);
  const ct = base64ToBytes(record.ciphertext);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    derivedKey,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

export const secrets: SecretStore = {
  async get(key) {
    const db = await getDB();
    const record = (await db.get('secrets', key)) as SealedRecord | undefined;
    if (!record) return null;
    if (!derivedKey) throw new Error('Secret store is locked');
    try {
      return await unseal(record);
    } catch {
      throw new Error('Failed to decrypt secret (wrong passphrase?)');
    }
  },
  async set(key, value) {
    if (!derivedKey) throw new Error('Secret store is locked');
    const sealed = await seal(value);
    const db = await getDB();
    await db.put('secrets', sealed, key);
  },
  async delete(key) {
    const db = await getDB();
    await db.delete('secrets', key);
  },
  async unlock(passphrase) {
    const salt = await getOrCreateSalt();
    derivedKey = await deriveKey(passphrase, salt);
  },
  isLocked() {
    return derivedKey === null;
  },
};
