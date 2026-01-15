/**
 * Nostr Login Service
 *
 * Handles multiple login methods:
 * - Generate new keypair
 * - Import nsec/hex private key
 * - NIP-46 Nostr Connect (bunker)
 */

import { nip19, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { NRelay1 } from '@nostrify/nostrify';
import type { NostrIdentity } from './types';

// NIP-46 event kind
export const KIND_NIP46_REQUEST = 24133;
export const KIND_NIP65_RELAY_LIST = 10002;
export const KIND_BLOSSOM_SERVER_LIST = 10063;

/**
 * Login type
 */
export type LoginType = 'nsec' | 'bunker' | 'extension';

/**
 * Login data stored in localStorage
 */
export interface StoredLogin {
  id: string;
  type: LoginType;
  pubkey: string;
  createdAt: number;
  // For nsec logins
  nsec?: string;
  // For bunker logins
  bunkerData?: {
    bunkerPubkey: string;
    clientNsec: string;
    relays: string[];
    secret: string;
  };
}

/**
 * Nostr Connect parameters
 */
export interface NostrConnectParams {
  clientSecretKey: Uint8Array;
  clientPubkey: string;
  secret: string;
  relays: string[];
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
 * Generate Nostr Connect parameters for QR code
 */
export function generateNostrConnectParams(relays: string[]): NostrConnectParams {
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const secret = bytesToHex(randomBytes(4)); // 8 char hex secret

  return {
    clientSecretKey,
    clientPubkey,
    secret,
    relays,
  };
}

/**
 * Build nostrconnect:// URI for QR code
 */
export function buildNostrConnectUri(
  params: NostrConnectParams,
  appName: string = 'Onyx',
  callbackUrl?: string
): string {
  const uri = new URL(`nostrconnect://${params.clientPubkey}`);

  params.relays.forEach(relay => {
    uri.searchParams.append('relay', relay);
  });

  uri.searchParams.set('secret', params.secret);
  uri.searchParams.set('name', appName);

  if (callbackUrl) {
    uri.searchParams.set('callback', callbackUrl);
  }

  return uri.toString();
}

/**
 * Connect to relays and wait for NIP-46 response
 */
export async function waitForNostrConnect(
  params: NostrConnectParams,
  timeoutMs: number = 120000
): Promise<StoredLogin> {
  const clientSk = params.clientSecretKey;
  const clientPubkey = params.clientPubkey;

  return new Promise((resolve, reject) => {
    const relayConnections: NRelay1[] = [];
    let resolved = false;

    const cleanup = () => {
      relayConnections.forEach(relay => {
        try {
          relay.close();
        } catch (e) {
          // Ignore close errors
        }
      });
    };

    // Set timeout
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('Connection timeout. Please try again.'));
      }
    }, timeoutMs);

    // Connect to all relays and subscribe
    params.relays.forEach(async (relayUrl) => {
      try {
        const relay = new NRelay1(relayUrl);
        relayConnections.push(relay);

        // Subscribe to NIP-46 responses
        const sub = relay.req([
          {
            kinds: [KIND_NIP46_REQUEST],
            '#p': [clientPubkey],
            since: Math.floor(Date.now() / 1000) - 10,
          },
        ]);

        for await (const msg of sub) {
          if (resolved) break;

          if (msg[0] === 'EVENT') {
            const event = msg[2];

            try {
              // Decrypt the response using NIP-44
              const conversationKey = nip44.v2.utils.getConversationKey(
                clientSk,
                event.pubkey
              );
              const decrypted = nip44.v2.decrypt(event.content, conversationKey);
              const response = JSON.parse(decrypted);

              // Check if this is an "ack" or matches our secret
              if (response.result === params.secret || response.result === 'ack') {
                resolved = true;
                clearTimeout(timeoutId);
                cleanup();

                // The event.pubkey is the bunker pubkey
                // We need to get the actual user pubkey from the response
                // In NIP-46, the bunker signs the initial connection
                const bunkerPubkey = event.pubkey;

                // For now, use bunkerPubkey as user pubkey
                // In a proper implementation, we'd do a follow-up request
                const userPubkey = response.result === 'ack'
                  ? bunkerPubkey
                  : bunkerPubkey;

                const login: StoredLogin = {
                  id: generateLoginId(),
                  type: 'bunker',
                  pubkey: userPubkey,
                  createdAt: Math.floor(Date.now() / 1000),
                  bunkerData: {
                    bunkerPubkey,
                    clientNsec: nip19.nsecEncode(clientSk),
                    relays: params.relays,
                    secret: params.secret,
                  },
                };

                resolve(login);
                return;
              }
            } catch (e) {
              console.error('Failed to process NIP-46 response:', e);
            }
          }
        }
      } catch (e) {
        console.error(`Failed to connect to relay ${relayUrl}:`, e);
      }
    });
  });
}

/**
 * Fetch NIP-65 relay list for a user
 */
export async function fetchUserRelays(
  pubkey: string,
  relays: string[]
): Promise<RelayEntry[]> {
  const results: RelayEntry[] = [];

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

  return results;
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
 * Storage key for logins
 */
const STORAGE_KEY = 'onyx:logins';
const PROFILE_STORAGE_KEY = 'onyx:profile';

/**
 * Save login to localStorage
 */
export function saveLogin(login: StoredLogin): void {
  const logins = getLogins();
  // Add to beginning (most recent first)
  logins.unshift(login);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(logins));
}

/**
 * Get all logins from localStorage
 */
export function getLogins(): StoredLogin[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];

  try {
    return JSON.parse(stored);
  } catch (e) {
    return [];
  }
}

/**
 * Get the current (first) login
 */
export function getCurrentLogin(): StoredLogin | null {
  const logins = getLogins();
  return logins[0] || null;
}

/**
 * Remove a login by ID
 */
export function removeLogin(id: string): void {
  const logins = getLogins().filter(l => l.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(logins));
}

/**
 * Clear all logins
 */
export function clearLogins(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
}

/**
 * Save user profile to localStorage
 */
export function saveUserProfile(profile: UserProfile): void {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

/**
 * Get user profile from localStorage
 */
export function getSavedProfile(): UserProfile | null {
  const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (!stored) return null;

  try {
    return JSON.parse(stored);
  } catch (e) {
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
  } catch (e) {
    return null;
  }
}
