/**
 * NIP-19 / NIP-21 entity parsing for embedded Nostr references.
 *
 * Decodes `nostr:` URIs (NIP-21) into a normalized pointer so the editor can
 * decide how to render them: kind-1 notes and long-form articles as block
 * cards, profiles as inline mention chips.
 */

import { nip19 } from 'nostr-tools';

/**
 * Matches a NIP-21 `nostr:` URI for the entity types we render. The data part
 * uses the bech32 charset (per NIP-19). `g` flag — callers MUST reset
 * `lastIndex` before reusing it on a new string.
 */
export const NOSTR_DETECT_REGEX =
  /nostr:((?:npub1|nprofile1|note1|nevent1|naddr1)[023456789acdefghjklmnpqrstuvwxyz]+)/g;

export type NostrEntityKind = 'note' | 'article' | 'mention';

export interface NotePointer {
  kind: 'note';
  /** hex event id */
  id: string;
  relays: string[];
  author?: string;
}

export interface ArticlePointer {
  kind: 'article';
  /** the addressable event kind embedded in the naddr (e.g. 30023) */
  eventKind: number;
  pubkey: string;
  identifier: string;
  relays: string[];
}

export interface MentionPointer {
  kind: 'mention';
  /** hex pubkey */
  pubkey: string;
  relays: string[];
}

export type NostrPointer = NotePointer | ArticlePointer | MentionPointer;

export interface ParsedNostrEntity {
  /** the bech32 entity without the `nostr:` prefix */
  bech32: string;
  pointer: NostrPointer;
}

/**
 * Parse a bech32 entity (with or without the `nostr:` prefix) into a
 * normalized pointer. Returns null for unsupported or malformed input.
 */
export function parseNostrEntity(input: string): ParsedNostrEntity | null {
  const bech32 = input.startsWith('nostr:') ? input.slice('nostr:'.length) : input;

  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(bech32);
  } catch {
    return null;
  }

  switch (decoded.type) {
    case 'note':
      return { bech32, pointer: { kind: 'note', id: decoded.data, relays: [] } };
    case 'nevent':
      return {
        bech32,
        pointer: {
          kind: 'note',
          id: decoded.data.id,
          relays: decoded.data.relays ?? [],
          author: decoded.data.author,
        },
      };
    case 'npub':
      return { bech32, pointer: { kind: 'mention', pubkey: decoded.data, relays: [] } };
    case 'nprofile':
      return {
        bech32,
        pointer: { kind: 'mention', pubkey: decoded.data.pubkey, relays: decoded.data.relays ?? [] },
      };
    case 'naddr':
      return {
        bech32,
        pointer: {
          kind: 'article',
          eventKind: decoded.data.kind,
          pubkey: decoded.data.pubkey,
          identifier: decoded.data.identifier,
          relays: decoded.data.relays ?? [],
        },
      };
    default:
      return null;
  }
}

/** Truncate a long bech32 string for compact display, e.g. npub1abc…wxyz. */
export function truncateBech32(bech32: string, head = 12, tail = 6): string {
  if (bech32.length <= head + tail + 1) return bech32;
  return `${bech32.slice(0, head)}…${bech32.slice(-tail)}`;
}
