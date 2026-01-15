/**
 * NIP-XX: Encrypted File Sync Types
 *
 * Type definitions for the encrypted file sync protocol.
 */

// Event Kinds
export const KIND_FILE = 30800;
export const KIND_VAULT_INDEX = 30801;

// Encryption method
export const ENCRYPTION_METHOD = 'nip44';

/**
 * Attachment stored on a Blossom server
 */
export interface Attachment {
  /** Original filename */
  name: string;
  /** SHA-256 hash of the encrypted blob (Blossom identifier) */
  blossom: string;
  /** Symmetric encryption key (hex) */
  key: string;
  /** Size in bytes of the original file */
  size: number;
  /** MIME type */
  contentType?: string;
}

/**
 * Decrypted content of a kind 30800 file event
 */
export interface FilePayload {
  /** Relative path within the vault */
  path: string;
  /** File content (UTF-8) */
  content: string;
  /** SHA-256 hash of content (hex) */
  checksum: string;
  /** Version number (monotonically increasing) */
  version: number;
  /** Unix timestamp of last modification */
  modified: number;
  /** Event ID of previous version (for history) */
  previousEventId?: string | null;
  /** MIME type (default: text/markdown) */
  contentType?: string;
  /** Application-specific metadata (e.g., frontmatter) */
  metadata?: Record<string, unknown>;
  /** Binary attachments */
  attachments?: Attachment[];
}

/**
 * File entry in vault index
 */
export interface VaultFileEntry {
  /** Event ID of the kind 30800 event */
  eventId: string;
  /** The d-tag of the file event */
  d: string;
  /** Relative path for quick lookup */
  path: string;
  /** SHA-256 of content */
  checksum: string;
  /** Current version number */
  version: number;
  /** Last modification timestamp */
  modified: number;
}

/**
 * Deleted file entry (tombstone)
 */
export interface DeletedFileEntry {
  /** Path of the deleted file */
  path: string;
  /** Unix timestamp of deletion */
  deletedAt: number;
  /** Event ID of last version before deletion */
  lastEventId?: string;
}

/**
 * Vault-specific settings
 */
export interface VaultSettings {
  /** Default folder for new notes */
  defaultFolder?: string;
  /** Folder for attachments */
  attachmentFolder?: string;
  /** Custom settings */
  [key: string]: unknown;
}

/**
 * Decrypted content of a kind 30801 vault index event
 */
export interface VaultIndexPayload {
  /** Human-readable vault name */
  name: string;
  /** Optional description */
  description?: string;
  /** Unix timestamp of vault creation */
  created: number;
  /** Files in this vault */
  files: VaultFileEntry[];
  /** Deleted files (tombstones) */
  deleted?: DeletedFileEntry[];
  /** Vault settings */
  settings?: VaultSettings;
}

/**
 * A vault with its decrypted metadata
 */
export interface Vault {
  /** Event ID of the vault index */
  eventId: string;
  /** The d-tag of the vault index event */
  d: string;
  /** Decrypted vault data */
  data: VaultIndexPayload;
  /** Last sync timestamp */
  lastSync?: number;
}

/**
 * A synced file with its decrypted content
 */
export interface SyncedFile {
  /** Event ID of the file event */
  eventId: string;
  /** The d-tag of the file event */
  d: string;
  /** Decrypted file data */
  data: FilePayload;
  /** Event creation timestamp */
  createdAt: number;
}

/**
 * Sync status for a vault
 */
export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'error'
  | 'offline';

/**
 * Conflict information
 */
export interface SyncConflict {
  /** Path of the conflicting file */
  path: string;
  /** Local version */
  local: {
    content: string;
    checksum: string;
    version: number;
    modified: number;
  };
  /** Remote version */
  remote: {
    eventId: string;
    content: string;
    checksum: string;
    version: number;
    modified: number;
  };
}

/**
 * Conflict resolution strategy
 */
export type ConflictResolution =
  | 'local'      // Keep local version
  | 'remote'     // Accept remote version
  | 'both'       // Keep both (rename one)
  | 'manual';    // Manual merge

/**
 * Relay connection status
 */
export interface RelayStatus {
  url: string;
  connected: boolean;
  lastError?: string;
}

/**
 * Nostr identity (keys)
 */
export interface NostrIdentity {
  /** Public key (hex) */
  pubkey: string;
  /** Private key (hex) - should be stored securely */
  privkey: string;
  /** npub (bech32) */
  npub: string;
  /** nsec (bech32) */
  nsec: string;
}

/**
 * Sync configuration
 */
export interface SyncConfig {
  /** Whether sync is enabled for this vault */
  enabled: boolean;
  /** Relay URLs */
  relays: string[];
  /** Blossom server URLs */
  blossomServers: string[];
  /** Sync frequency in seconds (0 = manual only) */
  syncFrequency: number;
  /** Conflict resolution strategy */
  conflictResolution: ConflictResolution;
}

/**
 * Default sync configuration
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  relays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ],
  blossomServers: [
    'https://blossom.oxtr.dev',
  ],
  syncFrequency: 0, // Manual by default
  conflictResolution: 'manual',
};
