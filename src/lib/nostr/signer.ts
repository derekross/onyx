/**
 * Nostr Signer Abstraction
 *
 * Provides a unified interface for signing Nostr events, supporting:
 * - Local signing with nsec (NSecSigner)
 */

import { NSecSigner } from '@nostrify/nostrify';
import type { NostrEvent, NostrSigner as BaseNostrSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';

/**
 * Signer type
 */
export type SignerType = 'local';

/**
 * Extended signer interface with type info
 */
export interface NostrSigner extends BaseNostrSigner {
  /** Get the signer type */
  getType(): SignerType;
  /** Close connections (no-op for local signer) */
  close?(): void;
  /** Get the secret key (only available for local signers) */
  getSecretKey?(): Uint8Array | null;
}

/**
 * Local signer wrapper
 */
class LocalSignerWrapper implements NostrSigner {
  private signer: NSecSigner;
  private secretKey: Uint8Array;

  constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
    this.signer = new NSecSigner(secretKey);
  }

  getPublicKey(): Promise<string> {
    return this.signer.getPublicKey();
  }

  signEvent(event: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    return this.signer.signEvent(event);
  }

  getType(): SignerType {
    return 'local';
  }

  getSecretKey(): Uint8Array {
    return new Uint8Array(this.secretKey);
  }

  get nip44() {
    return this.signer.nip44;
  }
}

/**
 * Login data structure
 */
export interface LoginData {
  type: 'nsec';
  pubkey: string;
  nsec?: string;
}

/**
 * Create a signer from login data
 */
export function createSignerFromLogin(login: LoginData): NostrSigner | null {
  if (login.type === 'nsec' && login.nsec) {
    try {
      const decoded = nip19.decode(login.nsec);
      if (decoded.type !== 'nsec') return null;
      return new LocalSignerWrapper(decoded.data);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Get signer from current login stored in keyring
 */
export async function getSignerFromStoredLogin(): Promise<NostrSigner | null> {
  // Import dynamically to avoid circular dependencies
  const { getCurrentLogin } = await import('./login');
  const login = await getCurrentLogin();
  if (!login) return null;
  return createSignerFromLogin(login);
}
