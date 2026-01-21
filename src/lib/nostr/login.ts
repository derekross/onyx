/**
 * Nostr Login Service
 *
 * Handles login via:
 * - Generate new keypair
 * - Import nsec/hex private key
 *
 * Secrets (nsec) are stored in the OS keyring via Tauri.
 * Only non-sensitive metadata is stored in localStorage.
 */

import { nip19, generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { NRelay1 } from '@nostrify/nostrify';
import { invoke } from '@tauri-apps/api/core';
import type { NostrIdentity } from './types';

// Keyring helper functions
async function keyringSet(key: string, value: string): Promise<void> {
  try {
    await invoke('keyring_set', { key, value });
  } catch (e) {
    console.error('Keyring set failed:', e);
    throw e;
  }
}

async function keyringGet(key: string): Promise<string | null> {
  try {
    const result = await invoke<string | null>('keyring_get', { key });
    return result;
  } catch (e) {
    console.error('Keyring get failed:', e);
    throw e;
  }
}

async function keyringDelete(key: string): Promise<void> {
  try {
    await invoke('keyring_delete', { key });
  } catch (e) {
    console.error('Keyring delete failed:', e);
    throw e;
  }
}

export const KIND_NIP65_RELAY_LIST = 10002;
export const KIND_BLOSSOM_SERVER_LIST = 10063;

/**
 * Login type
 */
export type LoginType = 'nsec';

/**
 * Login metadata stored in localStorage (no secrets)
 */
export interface StoredLoginMeta {
  id: string;
  type: LoginType;
  pubkey: string;
  createdAt: number;
}

/**
 * Full login data (metadata + secrets from keyring)
 */
export interface StoredLogin {
  id: string;
  type: LoginType;
  pubkey: string;
  createdAt: number;
  // For nsec logins - retrieved from keyring
  nsec?: string;
}

/**
 * Relay entry from NIP-65
 */
export interface RelayEntry {
  url: string;
  read: boolean;
  write: boolean;
}

/**
 * Generate a unique login ID
 */
function generateLoginId(): string {
  return bytesToHex(randomBytes(8));
}

/**
 * Generate a new Nostr keypair and create login
 */
export function generateNewLogin(): { identity: NostrIdentity; login: StoredLogin } {
  const sk = generateSecretKey();
  const privkey = bytesToHex(sk);
  const pubkey = getPublicKey(sk);

  const identity: NostrIdentity = {
    pubkey,
    privkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(sk),
  };

  const login: StoredLogin = {
    id: generateLoginId(),
    type: 'nsec',
    pubkey,
    createdAt: Math.floor(Date.now() / 1000),
    nsec: identity.nsec,
  };

  return { identity, login };
}

/**
 * Import a private key (nsec or hex) and create login
 */
export function importNsecLogin(key: string): { identity: NostrIdentity; login: StoredLogin } {
  let sk: Uint8Array;

  if (key.startsWith('nsec')) {
    const decoded = nip19.decode(key);
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec');
    }
    sk = decoded.data;
  } else {
    // Assume hex
    sk = hexToBytes(key);
  }

  const privkey = bytesToHex(sk);
  const pubkey = getPublicKey(sk);

  const identity: NostrIdentity = {
    pubkey,
    privkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(sk),
  };

  const login: StoredLogin = {
    id: generateLoginId(),
    type: 'nsec',
    pubkey,
    createdAt: Math.floor(Date.now() / 1000),
    nsec: identity.nsec,
  };

  return { identity, login };
}

/**
 * Fetch NIP-65 relay list for a user
 */
export async function fetchUserRelays(
  pubkey: string,
  relays: string[]
): Promise<RelayEntry[]> {
  for (const relayUrl of relays) {
    try {
      const relay = new NRelay1(relayUrl);

      const sub = relay.req([
        {
          kinds: [KIND_NIP65_RELAY_LIST],
          authors: [pubkey],
          limit: 1,
        },
      ]);

      const timeout = setTimeout(() => {
        relay.close();
      }, 5000);

      for await (const msg of sub) {
        if (msg[0] === 'EVENT') {
          const event = msg[2];
          clearTimeout(timeout);
          relay.close();

          // Parse relay tags
          const relayEntries = event.tags
            .filter(([name]: string[]) => name === 'r')
            .map(([_, url, marker]: string[]) => ({
              url,
              read: !marker || marker === 'read',
              write: !marker || marker === 'write',
            }));

          return relayEntries;
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeout);
          relay.close();
          break;
        }
      }
    } catch (e) {
      console.error(`Failed to fetch from ${relayUrl}:`, e);
    }
  }

  return [];
}

/**
 * Fetch blossom server list for a user (kind 10063)
 */
export async function fetchUserBlossomServers(
  pubkey: string,
  relays: string[]
): Promise<string[]> {
  for (const relayUrl of relays) {
    try {
      const relay = new NRelay1(relayUrl);

      const sub = relay.req([
        {
          kinds: [KIND_BLOSSOM_SERVER_LIST],
          authors: [pubkey],
          limit: 1,
        },
      ]);

      const timeout = setTimeout(() => {
        relay.close();
      }, 5000);

      for await (const msg of sub) {
        if (msg[0] === 'EVENT') {
          const event = msg[2];
          clearTimeout(timeout);
          relay.close();

          // Parse server tags
          const servers = event.tags
            .filter(([name]: string[]) => name === 'server')
            .map(([_, url]: string[]) => url);

          return servers;
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeout);
          relay.close();
          break;
        }
      }
    } catch (e) {
      console.error(`Failed to fetch blossom servers from ${relayUrl}:`, e);
    }
  }

  return [];
}

/**
 * User profile metadata (kind 0)
 */
export interface UserProfile {
  name?: string;
  displayName?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  banner?: string;
  lud16?: string;
}

/**
 * Fetch user profile (kind 0 metadata)
 */
export async function fetchUserProfile(
  pubkey: string,
  relays: string[]
): Promise<UserProfile | null> {
  for (const relayUrl of relays) {
    try {
      const relay = new NRelay1(relayUrl);

      const sub = relay.req([
        {
          kinds: [0],
          authors: [pubkey],
          limit: 1,
        },
      ]);

      const timeout = setTimeout(() => {
        relay.close();
      }, 5000);

      for await (const msg of sub) {
        if (msg[0] === 'EVENT') {
          const event = msg[2];
          clearTimeout(timeout);
          relay.close();

          try {
            const profile = JSON.parse(event.content) as UserProfile;
            return profile;
          } catch (e) {
            console.error('Failed to parse profile:', e);
            return null;
          }
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeout);
          relay.close();
          break;
        }
      }
    } catch (e) {
      console.error(`Failed to fetch profile from ${relayUrl}:`, e);
    }
  }

  return null;
}

/**
 * Keyring keys - all sensitive data stored securely in OS keyring
 */
const KEYRING_LOGIN_KEY = 'onyx:login';
const KEYRING_PROFILE_KEY = 'onyx:profile';

/**
 * Save login to keyring (entire login stored securely)
 */
export async function saveLogin(login: StoredLogin): Promise<void> {
  await keyringSet(KEYRING_LOGIN_KEY, JSON.stringify(login));
}

/**
 * Get login metadata (async, from keyring)
 */
export async function getLoginMetas(): Promise<StoredLoginMeta[]> {
  const login = await getCurrentLogin();
  if (!login) return [];

  const meta: StoredLoginMeta = {
    id: login.id,
    type: login.type,
    pubkey: login.pubkey,
    createdAt: login.createdAt,
  };

  return [meta];
}

/**
 * Get all logins from keyring (async)
 */
export async function getLogins(): Promise<StoredLogin[]> {
  const login = await getCurrentLogin();
  return login ? [login] : [];
}

/**
 * Get the current login from keyring (async)
 */
export async function getCurrentLogin(): Promise<StoredLogin | null> {
  try {
    const stored = await keyringGet(KEYRING_LOGIN_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as StoredLogin;
  } catch {
    return null;
  }
}

/**
 * Get the current login metadata - async version
 * Note: This is now async since we store everything in keyring
 */
export async function getCurrentLoginMeta(): Promise<StoredLoginMeta | null> {
  const login = await getCurrentLogin();
  if (!login) return null;

  const meta: StoredLoginMeta = {
    id: login.id,
    type: login.type,
    pubkey: login.pubkey,
    createdAt: login.createdAt,
  };

  return meta;
}

/**
 * Remove a login by ID from keyring
 */
export async function removeLogin(_id: string): Promise<void> {
  await keyringDelete(KEYRING_LOGIN_KEY);
}

/**
 * Clear all logins from keyring
 */
export async function clearLogins(): Promise<void> {
  await keyringDelete(KEYRING_LOGIN_KEY);
  await keyringDelete(KEYRING_PROFILE_KEY);
}

/**
 * Save user profile to keyring
 */
export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await keyringSet(KEYRING_PROFILE_KEY, JSON.stringify(profile));
}

/**
 * Get user profile from keyring
 */
export async function getSavedProfile(): Promise<UserProfile | null> {
  try {
    const stored = await keyringGet(KEYRING_PROFILE_KEY);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * Get NostrIdentity from a stored login (for nsec logins)
 */
export function getIdentityFromLogin(login: StoredLogin): NostrIdentity | null {
  if (login.type !== 'nsec' || !login.nsec) {
    return null;
  }

  try {
    const decoded = nip19.decode(login.nsec);
    if (decoded.type !== 'nsec') return null;

    const sk = decoded.data;
    const privkey = bytesToHex(sk);
    const pubkey = getPublicKey(sk);

    return {
      pubkey,
      privkey,
      npub: nip19.npubEncode(pubkey),
      nsec: login.nsec,
    };
  } catch {
    return null;
  }
}
