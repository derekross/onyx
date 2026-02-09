/**
 * NIP-05 Resolution and Recipient Input Parsing
 * 
 * Handles resolving NIP-05 identifiers (user@domain.com) to pubkeys,
 * and parsing various recipient input formats (npub, hex, NIP-05).
 */

import { nip19 } from 'nostr-tools';

/**
 * Result of NIP-05 resolution
 */
export interface Nip05Result {
  pubkey: string;
  relays?: string[];
}

/**
 * Resolve a NIP-05 identifier to a pubkey
 * 
 * @param identifier - NIP-05 identifier (e.g., "alice@primal.net" or "_@domain.com")
 * @returns The hex pubkey if found, null otherwise
 */
export async function resolveNip05(identifier: string): Promise<Nip05Result | null> {
  try {
    // Parse the identifier
    const parts = identifier.toLowerCase().trim().split('@');
    if (parts.length !== 2) {
      return null;
    }

    const [name, domain] = parts;
    if (!name || !domain) {
      return null;
    }

    // Fetch the .well-known/nostr.json file with timeout
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.warn(`NIP-05 resolution failed for ${identifier}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    // Get the pubkey for this name
    const pubkey = data.names?.[name] || data.names?.[name.toLowerCase()];
    if (!pubkey || typeof pubkey !== 'string') {
      return null;
    }

    // Validate it looks like a hex pubkey
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      return null;
    }

    // Get optional relays
    const relays = data.relays?.[pubkey];

    return {
      pubkey: pubkey.toLowerCase(),
      relays: Array.isArray(relays) ? relays : undefined,
    };
  } catch (error) {
    console.error(`NIP-05 resolution error for ${identifier}:`, error);
    return null;
  }
}

/**
 * Check if a string is a valid hex pubkey
 */
export function isValidHexPubkey(str: string): boolean {
  return /^[0-9a-f]{64}$/i.test(str);
}

/**
 * Check if a string looks like a NIP-05 identifier
 */
export function isNip05Identifier(str: string): boolean {
  const parts = str.split('@');
  if (parts.length !== 2) return false;
  const [, domain] = parts;
  // Name can be empty for _@domain.com style
  if (!domain) return false;
  // Basic domain validation
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain);
}

/**
 * Check if a string is a valid npub
 */
export function isValidNpub(str: string): boolean {
  if (!str.startsWith('npub1')) return false;
  try {
    const decoded = nip19.decode(str);
    return decoded.type === 'npub';
  } catch {
    return false;
  }
}

/**
 * Parse various recipient input formats and return a hex pubkey
 * 
 * Supports:
 * - npub1... (bech32 encoded pubkey)
 * - Hex pubkey (64 character hex string)
 * - NIP-05 identifier (user@domain.com)
 * 
 * @param input - The recipient input string
 * @returns The hex pubkey if valid/resolvable, null otherwise
 */
export async function parseRecipientInput(input: string): Promise<{
  pubkey: string | null;
  type: 'npub' | 'hex' | 'nip05' | 'invalid';
  relays?: string[];
  error?: string;
}> {
  const trimmed = input.trim();
  
  if (!trimmed) {
    return { pubkey: null, type: 'invalid', error: 'Empty input' };
  }

  // Try npub first
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') {
        return { pubkey: decoded.data as string, type: 'npub' };
      }
    } catch (e) {
      return { pubkey: null, type: 'invalid', error: 'Invalid npub format' };
    }
  }

  // Try hex pubkey
  if (isValidHexPubkey(trimmed)) {
    return { pubkey: trimmed.toLowerCase(), type: 'hex' };
  }

  // Try NIP-05
  if (isNip05Identifier(trimmed)) {
    const result = await resolveNip05(trimmed);
    if (result) {
      return { pubkey: result.pubkey, type: 'nip05', relays: result.relays };
    }
    return { pubkey: null, type: 'nip05', error: `Could not resolve ${trimmed}` };
  }

  return { pubkey: null, type: 'invalid', error: 'Invalid format. Use npub, hex pubkey, or user@domain.com' };
}

/**
 * Convert a hex pubkey to npub format
 */
export function pubkeyToNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

/**
 * Convert an npub to hex pubkey
 */
export function npubToPubkey(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === 'npub') {
      return decoded.data as string;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a pubkey for display (truncated)
 */
export function formatPubkey(pubkey: string, length: number = 8): string {
  const npub = pubkeyToNpub(pubkey);
  if (npub.length <= length * 2 + 3) return npub;
  return `${npub.slice(0, length)}...${npub.slice(-length)}`;
}
