/**
 * Cryptographic utilities for NIP-XX encrypted file sync
 */

import { nip44, nip19, generateSecretKey, getPublicKey } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import type { NostrIdentity, FilePayload, VaultIndexPayload } from './types';

/**
 * Generate a new Nostr keypair
 */
export function generateKeyPair(): NostrIdentity {
  const privkeyBytes = generateSecretKey();
  const privkey = bytesToHex(privkeyBytes);
  const pubkey = getPublicKey(privkeyBytes);

  return {
    pubkey,
    privkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(privkeyBytes),
  };
}

/**
 * Import a private key from nsec or hex
 */
export function importPrivateKey(key: string): NostrIdentity {
  let privkeyBytes: Uint8Array;

  if (key.startsWith('nsec')) {
    const decoded = nip19.decode(key);
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec');
    }
    privkeyBytes = decoded.data;
  } else {
    // Assume hex
    privkeyBytes = hexToBytes(key);
  }

  const privkey = bytesToHex(privkeyBytes);
  const pubkey = getPublicKey(privkeyBytes);

  return {
    pubkey,
    privkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(privkeyBytes),
  };
}

/**
 * Get conversation key for self-encryption (NIP-44)
 */
export function getConversationKey(privkey: string, pubkey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(hexToBytes(privkey), pubkey);
}

/**
 * Encrypt data using NIP-44 (self-encryption)
 */
export function encrypt(plaintext: string, conversationKey: Uint8Array): string {
  return nip44.v2.encrypt(plaintext, conversationKey);
}

/**
 * Decrypt data using NIP-44
 */
export function decrypt(ciphertext: string, conversationKey: Uint8Array): string {
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

/**
 * Encrypt a file payload
 */
export function encryptFilePayload(
  payload: FilePayload,
  conversationKey: Uint8Array
): string {
  return encrypt(JSON.stringify(payload), conversationKey);
}

/**
 * Decrypt a file payload
 */
export function decryptFilePayload(
  ciphertext: string,
  conversationKey: Uint8Array
): FilePayload {
  const plaintext = decrypt(ciphertext, conversationKey);
  return JSON.parse(plaintext) as FilePayload;
}

/**
 * Encrypt a vault index payload
 */
export function encryptVaultPayload(
  payload: VaultIndexPayload,
  conversationKey: Uint8Array
): string {
  return encrypt(JSON.stringify(payload), conversationKey);
}

/**
 * Decrypt a vault index payload
 */
export function decryptVaultPayload(
  ciphertext: string,
  conversationKey: Uint8Array
): VaultIndexPayload {
  const plaintext = decrypt(ciphertext, conversationKey);
  return JSON.parse(plaintext) as VaultIndexPayload;
}

/**
 * Calculate SHA-256 checksum of content
 */
export function calculateChecksum(content: string): string {
  const bytes = new TextEncoder().encode(content);
  return bytesToHex(sha256(bytes));
}

/**
 * Encrypt binary data for Blossom upload using AES-256-GCM
 * Returns { encrypted, key, nonce }
 */
export function encryptBinary(data: Uint8Array): {
  encrypted: Uint8Array;
  key: string;
  nonce: string;
} {
  const key = randomBytes(32); // AES-256
  const nonce = randomBytes(12); // GCM nonce

  const cipher = gcm(key, nonce);
  const encrypted = cipher.encrypt(data);

  return {
    encrypted,
    key: bytesToHex(key),
    nonce: bytesToHex(nonce),
  };
}

/**
 * Decrypt binary data from Blossom
 */
export function decryptBinary(
  encrypted: Uint8Array,
  keyHex: string,
  nonceHex: string
): Uint8Array {
  const key = hexToBytes(keyHex);
  const nonce = hexToBytes(nonceHex);

  const cipher = gcm(key, nonce);
  return cipher.decrypt(encrypted);
}

/**
 * Calculate SHA-256 hash of binary data (for Blossom)
 */
export function hashBinary(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/**
 * Verify a checksum matches content
 */
export function verifyChecksum(content: string, expectedChecksum: string): boolean {
  return calculateChecksum(content) === expectedChecksum;
}
