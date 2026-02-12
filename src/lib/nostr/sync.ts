/**
 * Sync Engine for NIP-XX Encrypted File Sync
 *
 * Handles synchronization of files between local storage and Nostr relays.
 * Supports both local signing (nsec) and remote signing (NIP-46 bunker).
 */

import { SimplePool, finalizeEvent, nip44, nip19, nip17, type Event } from 'nostr-tools';
import { v4 as uuidv4 } from 'uuid';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  KIND_FILE,
  KIND_VAULT_INDEX,
  KIND_SHARED_DOCUMENT,
  KIND_MUTE_LIST,
  KIND_APP_DATA,
  APP_DATA_IDENTIFIER,
  ENCRYPTION_METHOD,
  type NostrIdentity,
  type Vault,
  type VaultIndexPayload,
  type VaultFileEntry,
  type FilePayload,
  type SyncedFile,
  type SyncConfig,
  type RelayStatus,
  type SyncConflict,
  type SharedDocument,
  type SharedDocumentPayload,
  type SentShare,
  type ShareResult,
  type Attachment,
  type UserPreferences,
  DEFAULT_SYNC_CONFIG,
} from './types';
import {
  getConversationKey,
  calculateChecksum,
} from './crypto';
import type { NostrSigner } from './signer';

/**
 * Sync Engine class
 */
export class SyncEngine {
  private pool: SimplePool;
  private identity: NostrIdentity | null = null;
  private conversationKey: Uint8Array | null = null;
  private signer: NostrSigner | null = null;
  private pubkey: string | null = null;
  private config: SyncConfig;
  private relayStatuses: Map<string, RelayStatus> = new Map();
  private subscriptions: Map<string, { close: () => void }> = new Map();

  constructor(config: Partial<SyncConfig> = {}) {
    this.pool = new SimplePool();
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }

  /**
   * Set the identity (keys) for this sync engine (legacy method for local signing)
   */
  setIdentity(identity: NostrIdentity | null): void {
    this.identity = identity;
    if (identity) {
      this.conversationKey = getConversationKey(identity.privkey, identity.pubkey);
      this.pubkey = identity.pubkey;
    } else {
      this.conversationKey = null;
      this.pubkey = null;
    }
    // Clear signer when using identity directly
    this.signer = null;
  }

  /**
   * Set a signer for signing events (supports local and NIP-46 remote signing)
   */
  async setSigner(signer: NostrSigner | null, conversationKey?: Uint8Array): Promise<void> {
    this.signer = signer;
    if (signer) {
      this.pubkey = await signer.getPublicKey();
      // For NIP-46, we need to get the conversation key differently
      // The caller should provide it if available (for local signers)
      this.conversationKey = conversationKey || null;
    } else {
      this.pubkey = null;
      this.conversationKey = null;
    }
    // Clear legacy identity when using signer
    this.identity = null;
  }

  /**
   * Check if identity/signer is set
   */
  hasIdentity(): boolean {
    return this.identity !== null || this.signer !== null;
  }

  /**
   * Get the current identity (legacy)
   */
  getIdentity(): NostrIdentity | null {
    return this.identity;
  }

  /**
   * Get the current signer
   */
  getSigner(): NostrSigner | null {
    return this.signer;
  }

  /**
   * Get the current pubkey (works for both identity and signer)
   */
  getPubkey(): string | null {
    return this.pubkey;
  }

  /**
   * Update sync configuration
   */
  setConfig(config: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): SyncConfig {
    return { ...this.config };
  }

  /**
   * Get relay statuses
   */
  getRelayStatuses(): RelayStatus[] {
    return Array.from(this.relayStatuses.values());
  }

  /**
   * Ensure identity/signer is configured
   */
  private ensureIdentity(): void {
    if (!this.pubkey) {
      throw new Error('Identity not set. Call setIdentity() or setSigner() first.');
    }
  }

  /**
   * Sign an event using the configured signer or legacy identity
   */
  private async signEvent(unsignedEvent: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<Event> {
    if (this.signer) {
      // Use the signer (supports both local and NIP-46)
      return await this.signer.signEvent(unsignedEvent) as Event;
    } else if (this.identity) {
      // Legacy: use finalizeEvent with private key
      return finalizeEvent(unsignedEvent, hexToBytes(this.identity.privkey));
    } else {
      throw new Error('No signer or identity configured');
    }
  }

  /**
   * Encrypt content using NIP-44
   * For NIP-46, uses remote encryption; for local, uses conversation key
   */
  private async encryptContent(plaintext: string): Promise<string> {
    if (this.signer?.nip44 && this.pubkey) {
      // Use signer's NIP-44 (works for both local and remote)
      return await this.signer.nip44.encrypt(this.pubkey, plaintext);
    } else if (this.conversationKey) {
      // Legacy: use conversation key directly
      return nip44.v2.encrypt(plaintext, this.conversationKey);
    } else {
      throw new Error('No encryption method available');
    }
  }

  /**
   * Decrypt content using NIP-44
   * For NIP-46, uses remote decryption; for local, uses conversation key
   */
  private async decryptContent(ciphertext: string): Promise<string> {
    if (this.signer?.nip44 && this.pubkey) {
      // Use signer's NIP-44 (works for both local and remote)
      return await this.signer.nip44.decrypt(this.pubkey, ciphertext);
    } else if (this.conversationKey) {
      // Legacy: use conversation key directly
      return nip44.v2.decrypt(ciphertext, this.conversationKey);
    } else {
      throw new Error('No decryption method available');
    }
  }

  /**
   * Send a NIP-17 private direct message
   * Uses gift-wrapped sealed messages for privacy
   */
  private async sendPrivateDM(
    recipientPubkey: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get the secret key from the signer
      const secretKey = this.signer?.getSecretKey?.();
      if (!secretKey) {
        return { success: false, error: 'No secret key available for NIP-17 DM' };
      }

      // Create the gift-wrapped event using nostr-tools nip17
      const recipient = { publicKey: recipientPubkey };
      const giftWrap = nip17.wrapEvent(secretKey, recipient, message);

      // Publish to relays
      await this.publishEvent(giftWrap as Event);

      return { success: true };
    } catch (err) {
      console.error('[SyncEngine] Failed to send NIP-17 DM:', err);
      return { 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      };
    }
  }

  /**
   * Fetch all vault indices for the current user
   */
  async fetchVaults(): Promise<Vault[]> {
    this.ensureIdentity();

    const events = await this.pool.querySync(
      this.config.relays,
      {
        kinds: [KIND_VAULT_INDEX],
        authors: [this.pubkey!],
      }
    );

    // Deduplicate by d-tag, keeping the newest event for each
    const latestByD = new Map<string, typeof events[0]>();
    for (const event of events) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;
      
      const existing = latestByD.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        latestByD.set(dTag, event);
      }
    }

    const vaults: Vault[] = [];

    for (const event of latestByD.values()) {
      try {
        const decrypted = await this.decryptContent(event.content);
        const data = JSON.parse(decrypted) as VaultIndexPayload;
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];

        if (dTag) {
          vaults.push({
            eventId: event.id,
            d: dTag,
            data,
            lastSync: event.created_at,
          });
        }
      } catch (err) {
        console.error('Failed to decrypt vault:', err);
      }
    }

    // Sort by lastSync, newest first
    vaults.sort((a, b) => (b.lastSync || 0) - (a.lastSync || 0));

    return vaults;
  }

  /**
   * Create a new vault
   */
  async createVault(name: string, description?: string): Promise<Vault> {
    this.ensureIdentity();

    const d = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const payload: VaultIndexPayload = {
      name,
      description,
      created: now,
      files: [],
      deleted: [],
      settings: {
        defaultFolder: '/',
        attachmentFolder: '/attachments',
      },
    };

    const encryptedContent = await this.encryptContent(JSON.stringify(payload));

    const event = await this.signEvent({
      kind: KIND_VAULT_INDEX,
      created_at: now,
      tags: [
        ['d', d],
        ['encrypted', ENCRYPTION_METHOD],
      ],
      content: encryptedContent,
    });

    await this.publishEvent(event);

    return {
      eventId: event.id,
      d,
      data: payload,
      lastSync: now,
    };
  }

  /**
   * Update a vault index
   */
  async updateVaultIndex(vault: Vault): Promise<Vault> {
    this.ensureIdentity();

    const now = Math.floor(Date.now() / 1000);
    const encryptedContent = await this.encryptContent(JSON.stringify(vault.data));

    const event = await this.signEvent({
      kind: KIND_VAULT_INDEX,
      created_at: now,
      tags: [
        ['d', vault.d],
        ['encrypted', ENCRYPTION_METHOD],
      ],
      content: encryptedContent,
    });

    await this.publishEvent(event);

    return {
      ...vault,
      eventId: event.id,
      lastSync: now,
    };
  }

  /**
   * Fetch all files for a vault
   */
  async fetchVaultFiles(vault: Vault): Promise<SyncedFile[]> {
    this.ensureIdentity();

    const eventIds = vault.data.files.map(f => f.eventId);
    if (eventIds.length === 0) return [];

    const events = await this.pool.querySync(
      this.config.relays,
      {
        ids: eventIds,
      }
    );

    const files: SyncedFile[] = [];

    for (const event of events) {
      try {
        const decrypted = await this.decryptContent(event.content);
        const data = JSON.parse(decrypted) as FilePayload;
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];

        if (dTag) {
          files.push({
            eventId: event.id,
            d: dTag,
            data,
            createdAt: event.created_at,
          });
        }
      } catch (err) {
        console.error('Failed to decrypt file:', err);
      }
    }

    return files;
  }

  /**
   * Publish a file to relays
   */
  async publishFile(
    vault: Vault,
    path: string,
    content: string,
    existingFile?: SyncedFile
  ): Promise<{ file: SyncedFile; vault: Vault }> {
    this.ensureIdentity();

    const now = Math.floor(Date.now() / 1000);
    const checksum = calculateChecksum(content);
    const d = existingFile?.d ?? uuidv4();
    const version = existingFile ? existingFile.data.version + 1 : 1;

    const payload: FilePayload = {
      path,
      content,
      checksum,
      version,
      modified: now,
      previousEventId: existingFile?.eventId ?? null,
      contentType: 'text/markdown',
    };

    const encryptedContent = await this.encryptContent(JSON.stringify(payload));

    const event = await this.signEvent({
      kind: KIND_FILE,
      created_at: now,
      tags: [
        ['d', d],
        ['encrypted', ENCRYPTION_METHOD],
      ],
      content: encryptedContent,
    });

    await this.publishEvent(event);

    const syncedFile: SyncedFile = {
      eventId: event.id,
      d,
      data: payload,
      createdAt: now,
    };

    // Update vault index
    const fileEntry: VaultFileEntry = {
      eventId: event.id,
      d,
      path,
      checksum,
      version,
      modified: now,
    };

    // Remove existing entry if updating
    const updatedFiles = vault.data.files.filter(f => f.d !== d);
    updatedFiles.push(fileEntry);

    const updatedVault: Vault = {
      ...vault,
      data: {
        ...vault.data,
        files: updatedFiles,
      },
    };

    const savedVault = await this.updateVaultIndex(updatedVault);

    return { file: syncedFile, vault: savedVault };
  }

  /**
   * Move/rename a file in the vault index, preserving its d-tag identity.
   * Re-publishes the file event with the updated path and updates the vault index.
   */
  async moveFile(
    vault: Vault,
    oldPath: string,
    newPath: string,
    content: string
  ): Promise<{ file: SyncedFile; vault: Vault }> {
    this.ensureIdentity();

    const existingEntry = vault.data.files.find(f => f.path === oldPath);
    if (!existingEntry) {
      // File not found at old path - treat as a new file
      return this.publishFile(vault, newPath, content);
    }

    // Re-publish with the same d-tag but new path
    const now = Math.floor(Date.now() / 1000);
    const checksum = calculateChecksum(content);
    const version = existingEntry.version + 1;

    const payload: FilePayload = {
      path: newPath,
      content,
      checksum,
      version,
      modified: now,
      previousEventId: existingEntry.eventId,
      contentType: 'text/markdown',
    };

    const encryptedContent = await this.encryptContent(JSON.stringify(payload));

    const event = await this.signEvent({
      kind: KIND_FILE,
      created_at: now,
      tags: [
        ['d', existingEntry.d],
        ['encrypted', ENCRYPTION_METHOD],
      ],
      content: encryptedContent,
    });

    await this.publishEvent(event);

    const syncedFile: SyncedFile = {
      eventId: event.id,
      d: existingEntry.d,
      data: payload,
      createdAt: now,
    };

    // Update vault index: remove old entry, add new one with updated path
    const fileEntry: VaultFileEntry = {
      eventId: event.id,
      d: existingEntry.d,
      path: newPath,
      checksum,
      version,
      modified: now,
    };

    const updatedFiles = vault.data.files.filter(f => f.d !== existingEntry.d);
    updatedFiles.push(fileEntry);

    const updatedVault: Vault = {
      ...vault,
      data: {
        ...vault.data,
        files: updatedFiles,
      },
    };

    const savedVault = await this.updateVaultIndex(updatedVault);

    return { file: syncedFile, vault: savedVault };
  }

  /**
   * Delete a file (add tombstone)
   */
  async deleteFile(vault: Vault, path: string): Promise<Vault> {
    this.ensureIdentity();

    const now = Math.floor(Date.now() / 1000);
    const existingFile = vault.data.files.find(f => f.path === path);

    if (!existingFile) {
      throw new Error(`File not found in vault: ${path}`);
    }

    // Remove from files array
    const updatedFiles = vault.data.files.filter(f => f.path !== path);

    // Add to deleted array
    const deletedEntry = {
      path,
      deletedAt: now,
      lastEventId: existingFile.eventId,
    };

    const updatedDeleted = [...(vault.data.deleted || []), deletedEntry];

    const updatedVault: Vault = {
      ...vault,
      data: {
        ...vault.data,
        files: updatedFiles,
        deleted: updatedDeleted,
      },
    };

    return this.updateVaultIndex(updatedVault);
  }

  /**
   * Publish event to all configured relays
   */
  private async publishEvent(event: Event): Promise<void> {
    const results = await Promise.allSettled(
      this.config.relays.map(relay => this.pool.publish([relay], event))
    );

    const successes = results.filter(r => r.status === 'fulfilled').length;
    if (successes === 0) {
      throw new Error('Failed to publish to any relay');
    }

    console.log(`Published event ${event.id} to ${successes}/${this.config.relays.length} relays`);
  }

  /**
   * Subscribe to updates for a vault
   */
  subscribeToVault(
    vault: Vault,
    onUpdate: (event: Event) => void
  ): () => void {
    this.ensureIdentity();

    const subId = `vault-${vault.d}`;

    // Close existing subscription if any
    this.subscriptions.get(subId)?.close();

    const sub = this.pool.subscribeMany(
      this.config.relays,
      [
        {
          kinds: [KIND_FILE, KIND_VAULT_INDEX],
          authors: [this.pubkey!],
          since: Math.floor(Date.now() / 1000),
        },
      ] as any,
      {
        onevent: onUpdate,
        oneose: () => {
          console.log(`Subscription ${subId} caught up`);
        },
      }
    );

    this.subscriptions.set(subId, sub);

    return () => {
      sub.close();
      this.subscriptions.delete(subId);
    };
  }

  /**
   * Check for conflicts between local and remote
   */
  checkConflict(
    localContent: string,
    localVersion: number,
    remoteFile: SyncedFile
  ): SyncConflict | null {
    const localChecksum = calculateChecksum(localContent);

    // No conflict if checksums match
    if (localChecksum === remoteFile.data.checksum) {
      return null;
    }

    // No conflict if local is based on remote
    if (localVersion === remoteFile.data.version) {
      return null;
    }

    // Conflict detected
    return {
      path: remoteFile.data.path,
      local: {
        content: localContent,
        checksum: localChecksum,
        version: localVersion,
        modified: Math.floor(Date.now() / 1000),
      },
      remote: {
        eventId: remoteFile.eventId,
        content: remoteFile.data.content,
        checksum: remoteFile.data.checksum,
        version: remoteFile.data.version,
        modified: remoteFile.data.modified,
      },
    };
  }

  /**
   * Close all connections
   */
  close(): void {
    for (const sub of this.subscriptions.values()) {
      sub.close();
    }
    this.subscriptions.clear();
    this.pool.close(this.config.relays);
  }

  // ============================================
  // Document Sharing Methods (Kind 30802)
  // ============================================

  /**
   * Encrypt content to a recipient's pubkey (for sharing)
   */
  private async encryptToRecipient(plaintext: string, recipientPubkey: string): Promise<string> {
    if (this.signer?.nip44) {
      // Use signer's NIP-44 to encrypt to recipient
      return await this.signer.nip44.encrypt(recipientPubkey, plaintext);
    } else if (this.identity) {
      // Legacy: compute conversation key with recipient and encrypt
      const conversationKey = nip44.v2.utils.getConversationKey(
        hexToBytes(this.identity.privkey),
        recipientPubkey
      );
      return nip44.v2.encrypt(plaintext, conversationKey);
    } else {
      throw new Error('No encryption method available');
    }
  }

  /**
   * Decrypt content from a sender's pubkey (for receiving shared docs)
   */
  private async decryptFromSender(ciphertext: string, senderPubkey: string): Promise<string> {
    if (this.signer?.nip44) {
      // Use signer's NIP-44 to decrypt from sender
      return await this.signer.nip44.decrypt(senderPubkey, ciphertext);
    } else if (this.identity) {
      // Legacy: compute conversation key with sender and decrypt
      const conversationKey = nip44.v2.utils.getConversationKey(
        hexToBytes(this.identity.privkey),
        senderPubkey
      );
      return nip44.v2.decrypt(ciphertext, conversationKey);
    } else {
      throw new Error('No decryption method available');
    }
  }

  /**
   * Share a document with another user
   * 
   * @param recipientPubkey - Recipient's hex pubkey
   * @param title - Document title (stored in cleartext tag for notifications)
   * @param content - Document content
   * @param path - Original file path
   * @param attachments - Optional attachments
   * @param senderName - Optional sender display name
   * @returns ShareResult with event ID and DM status
   */
  async shareDocument(
    recipientPubkey: string,
    title: string,
    content: string,
    path: string,
    attachments?: Attachment[],
    senderName?: string
  ): Promise<ShareResult> {
    this.ensureIdentity();

    const now = Math.floor(Date.now() / 1000);
    const d = uuidv4();

    const payload: SharedDocumentPayload = {
      path,
      content,
      checksum: calculateChecksum(content),
      sharedBy: {
        pubkey: this.pubkey!,
        name: senderName,
      },
      sharedAt: now,
      attachments,
    };

    // Encrypt to recipient's pubkey
    const encryptedContent = await this.encryptToRecipient(
      JSON.stringify(payload),
      recipientPubkey
    );

    const event = await this.signEvent({
      kind: KIND_SHARED_DOCUMENT,
      created_at: now,
      tags: [
        ['d', d],
        ['p', recipientPubkey],
        ['encrypted', ENCRYPTION_METHOD],
        ['title', title],
        ['path', path], // Store path in tag so we can filter shares by file
      ],
      content: encryptedContent,
    });

    await this.publishEvent(event);

    // Send NIP-17 DM notification to recipient
    const dmMessage = senderName 
      ? `${senderName} shared a document with you: "${title}"`
      : `You received a shared document: "${title}"`;
    
    const dmResult = await this.sendPrivateDM(recipientPubkey, dmMessage);

    return {
      eventId: event.id,
      dmSent: dmResult.success,
      dmError: dmResult.error,
    };
  }

  /**
   * Fetch documents shared with the current user
   * Automatically filters out shares from muted users
   */
  async fetchSharedWithMe(): Promise<SharedDocument[]> {
    this.ensureIdentity();

    // Fetch mute list first to filter out blocked senders
    const { pubkeys: mutedPubkeys } = await this.fetchMuteList();
    const mutedSet = new Set(mutedPubkeys);

    const events = await this.pool.querySync(
      this.config.relays,
      {
        kinds: [KIND_SHARED_DOCUMENT],
        '#p': [this.pubkey!],
      }
    );

    const sharedDocs: SharedDocument[] = [];
    const readIds = this.getReadShareIds();

    for (const event of events) {
      // Skip events from muted users
      if (mutedSet.has(event.pubkey)) {
        continue;
      }

      try {
        // Decrypt from sender's pubkey
        const decrypted = await this.decryptFromSender(event.content, event.pubkey);
        const data = JSON.parse(decrypted) as SharedDocumentPayload;
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        const titleTag = event.tags.find(t => t[0] === 'title')?.[1];

        if (dTag) {
          sharedDocs.push({
            eventId: event.id,
            d: dTag,
            title: titleTag || this.extractTitleFromPath(data.path),
            senderPubkey: event.pubkey,
            createdAt: event.created_at,
            data,
            isRead: readIds.includes(event.id),
          });
        }
      } catch (err) {
        console.error('Failed to decrypt shared document:', err);
      }
    }

    // Sort by date, newest first
    sharedDocs.sort((a, b) => b.createdAt - a.createdAt);

    return sharedDocs;
  }

  /**
   * Fetch documents the current user has shared with others
   */
  async fetchSentShares(): Promise<SentShare[]> {
    this.ensureIdentity();

    const events = await this.pool.querySync(
      this.config.relays,
      {
        kinds: [KIND_SHARED_DOCUMENT],
        authors: [this.pubkey!],
      }
    );

    const sentShares: SentShare[] = [];

    for (const event of events) {
      try {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        const pTag = event.tags.find(t => t[0] === 'p')?.[1];
        const titleTag = event.tags.find(t => t[0] === 'title')?.[1];
        const pathTag = event.tags.find(t => t[0] === 'path')?.[1];

        if (dTag && pTag) {
          sentShares.push({
            eventId: event.id,
            d: dTag,
            title: titleTag || 'Untitled',
            recipientPubkey: pTag,
            sharedAt: event.created_at,
            path: pathTag || '',
          });
        }
      } catch (err) {
        console.error('Failed to parse sent share:', err);
      }
    }

    // Sort by date, newest first
    sentShares.sort((a, b) => b.sharedAt - a.sharedAt);

    return sentShares;
  }

  /**
   * Revoke a shared document (delete the event)
   */
  async revokeShare(eventId: string): Promise<void> {
    this.ensureIdentity();

    // NIP-09: Event Deletion
    const now = Math.floor(Date.now() / 1000);

    const deleteEvent = await this.signEvent({
      kind: 5, // NIP-09 deletion
      created_at: now,
      tags: [
        ['e', eventId],
        ['k', String(KIND_SHARED_DOCUMENT)],
      ],
      content: 'Revoked shared document',
    });

    await this.publishEvent(deleteEvent);
  }

  /**
   * Import a shared document into the user's vault
   * Creates a new kind 30800 event (self-encrypted copy)
   */
  async importSharedDocument(
    sharedDoc: SharedDocument,
    vault: Vault,
    targetPath?: string
  ): Promise<{ file: SyncedFile; vault: Vault }> {
    this.ensureIdentity();

    // SECURITY: Sanitize the filename to prevent path traversal attacks
    const safeFilename = this.sanitizeFilename(
      this.extractFilenameFromPath(sharedDoc.data.path)
    );
    
    // Determine the target path - always under /Shared/ for imported documents
    const path = targetPath 
      ? this.sanitizeImportPath(targetPath)
      : `Shared/${safeFilename}`;

    // Use the existing publishFile method which handles all the encryption
    return this.publishFile(vault, path, sharedDoc.data.content);
  }

  /**
   * SECURITY: Sanitize a filename to remove dangerous characters
   */
  private sanitizeFilename(filename: string): string {
    if (!filename || typeof filename !== 'string') {
      return 'untitled.md';
    }
    
    let safe = filename
      // Remove null bytes
      .replace(/\0/g, '')
      // Remove control characters
      .replace(/[\x00-\x1f\x7f]/g, '')
      // Remove Windows reserved characters
      .replace(/[<>:"|?*]/g, '_')
      // Remove path separators
      .replace(/[/\\]/g, '_')
      // Remove directory traversal
      .replace(/\.\./g, '_');
    
    // Ensure it has an extension
    if (!safe.includes('.')) {
      safe += '.md';
    }
    
    // Prevent hidden files
    if (safe.startsWith('.')) {
      safe = '_' + safe.slice(1);
    }
    
    return safe || 'untitled.md';
  }

  /**
   * SECURITY: Sanitize an import path to prevent directory traversal
   */
  private sanitizeImportPath(path: string): string {
    if (!path || typeof path !== 'string') {
      return 'Shared/untitled.md';
    }
    
    let safe = path
      // Normalize to forward slashes
      .replace(/\\/g, '/')
      // Remove null bytes
      .replace(/\0/g, '')
      // Remove control characters
      .replace(/[\x00-\x1f\x7f]/g, '');
    
    // Loop to remove traversal attempts until stable (prevents ....// bypass)
    let prev = '';
    while (prev !== safe) {
      prev = safe;
      safe = safe
        .replace(/\.\.\//g, '')
        .replace(/\.\.\\/g, '');
    }
    
    safe = safe
      // Remove leading slashes
      .replace(/^\/+/, '')
      // Remove drive letters
      .replace(/^[a-zA-Z]:/, '');
    
    // Ensure path is not empty
    if (!safe || safe === '.' || safe === '/') {
      return 'Shared/untitled.md';
    }
    
    return safe;
  }

  /**
   * Mark a shared document as read (local state)
   */
  markShareAsRead(eventId: string): void {
    const readIds = this.getReadShareIds();
    if (!readIds.includes(eventId)) {
      readIds.push(eventId);
      // Cap at 1000 entries to prevent unbounded localStorage growth
      const MAX_READ_IDS = 1000;
      const trimmed = readIds.length > MAX_READ_IDS
        ? readIds.slice(readIds.length - MAX_READ_IDS)
        : readIds;
      localStorage.setItem('read_share_ids', JSON.stringify(trimmed));
    }
  }

  /**
   * Get IDs of shared documents that have been read
   */
  private getReadShareIds(): string[] {
    try {
      return JSON.parse(localStorage.getItem('read_share_ids') || '[]');
    } catch {
      return [];
    }
  }

  /**
   * Extract filename from path
   */
  private extractFilenameFromPath(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || 'document.md';
  }

  /**
   * Extract title from path (filename without extension)
   */
  private extractTitleFromPath(path: string): string {
    const filename = this.extractFilenameFromPath(path);
    return filename.replace(/\.[^/.]+$/, '') || 'Untitled';
  }

  // ============================================
  // NIP-23 Long-form Content Publishing
  // ============================================

  /**
   * Publish a long-form article (NIP-23)
   * 
   * @param content - The markdown content of the article
   * @param title - Article title
   * @param summary - Brief summary/description
   * @param image - Optional hero image URL
   * @param tags - Array of topic tags (t tags)
   * @param isDraft - If true, publish as kind 30024 (draft), otherwise kind 30023 (published)
   * @returns Object with eventId and naddr
   */
  async publishArticle(
    content: string,
    title: string,
    summary: string,
    image: string,
    tags: string[],
    isDraft: boolean
  ): Promise<{ eventId: string; naddr: string }> {
    this.ensureIdentity();

    const now = Math.floor(Date.now() / 1000);
    // Use title slug as the d-tag identifier for the article
    const d = this.slugify(title) + '-' + now.toString(36);
    
    // NIP-23: kind 30023 for published articles, kind 30024 for drafts
    const kind = isDraft ? 30024 : 30023;

    // Build tags array
    const eventTags: string[][] = [
      ['d', d],
      ['title', title],
      ['summary', summary],
      ['published_at', String(now)],
    ];

    // Add hero image if provided
    if (image) {
      eventTags.push(['image', image]);
    }

    // Add topic tags
    for (const tag of tags) {
      eventTags.push(['t', tag.toLowerCase()]);
    }

    const event = await this.signEvent({
      kind,
      created_at: now,
      tags: eventTags,
      content, // NIP-23: content is plaintext markdown (not encrypted)
    });

    await this.publishEvent(event);

    // Generate naddr for the article with relay hints
    const naddr = this.encodeNaddr(kind, this.pubkey!, d, this.config.relays);

    return {
      eventId: event.id,
      naddr,
    };
  }

  /**
   * Convert a string to a URL-friendly slug
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove non-word chars except spaces and hyphens
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .substring(0, 50); // Limit length
  }

  /**
   * Encode a NIP-19 naddr for addressable events
   */
  public encodeNaddr(kind: number, pubkey: string, d: string, relays?: string[]): string {
    return nip19.naddrEncode({
      kind,
      pubkey,
      identifier: d,
      relays: relays?.slice(0, 3) || [], // Include up to 3 relay hints
    });
  }

  /**
   * Generate naddr for a synced file
   */
  public getFileNaddr(d: string): string | null {
    if (!this.pubkey) return null;
    return this.encodeNaddr(KIND_FILE, this.pubkey, d, this.config.relays);
  }

  // ============================================
  // User Preferences (NIP-78)
  // ============================================

  /**
   * Fetch user preferences from Nostr (bookmarks, saved searches)
   * Uses NIP-78 application-specific data (kind 30078)
   */
  async fetchPreferences(): Promise<UserPreferences | null> {
    this.ensureIdentity();

    const events = await this.pool.querySync(
      this.config.relays,
      {
        kinds: [KIND_APP_DATA],
        authors: [this.pubkey!],
        '#d': [APP_DATA_IDENTIFIER],
      }
    );

    if (events.length === 0) {
      return null;
    }

    // Get the most recent preferences (replaceable event by d-tag)
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];

    try {
      const decrypted = await this.decryptContent(latest.content);
      const prefs = JSON.parse(decrypted) as UserPreferences;
      return prefs;
    } catch (err) {
      console.error('[SyncEngine] Failed to decrypt preferences:', err);
      return null;
    }
  }

  /**
   * Save user preferences to Nostr
   * Encrypts to self and publishes as NIP-78 event
   */
  async savePreferences(prefs: UserPreferences): Promise<string> {
    this.ensureIdentity();

    const now = Math.floor(Date.now() / 1000);
    const payload: UserPreferences = {
      ...prefs,
      updatedAt: now,
    };

    const encryptedContent = await this.encryptContent(JSON.stringify(payload));

    const event = await this.signEvent({
      kind: KIND_APP_DATA,
      created_at: now,
      tags: [
        ['d', APP_DATA_IDENTIFIER],
        ['encrypted', ENCRYPTION_METHOD],
      ],
      content: encryptedContent,
    });

    await this.publishEvent(event);
    return event.id;
  }

  // ============================================
  // NIP-51 Mute List
  // ============================================

  /**
   * Fetch the current user's mute list (kind 10000)
   * Returns both public and private (encrypted) muted pubkeys
   */
  async fetchMuteList(): Promise<{ pubkeys: string[]; raw?: Event }> {
    this.ensureIdentity();

    const events = await this.pool.querySync(
      this.config.relays,
      {
        kinds: [KIND_MUTE_LIST],
        authors: [this.pubkey!],
      }
    );

    if (events.length === 0) {
      return { pubkeys: [] };
    }

    // Get the most recent mute list (replaceable event)
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    const pubkeys: string[] = [];

    // Extract public mutes from tags
    for (const tag of latest.tags) {
      if (tag[0] === 'p' && tag[1]) {
        pubkeys.push(tag[1]);
      }
    }

    // Decrypt private mutes from content (if any)
    if (latest.content && this.conversationKey) {
      try {
        const decrypted = nip44.decrypt(latest.content, this.conversationKey);
        const privateTags = JSON.parse(decrypted) as string[][];
        for (const tag of privateTags) {
          if (tag[0] === 'p' && tag[1] && !pubkeys.includes(tag[1])) {
            pubkeys.push(tag[1]);
          }
        }
      } catch (err) {
        console.warn('Failed to decrypt private mute list:', err);
      }
    }

    return { pubkeys, raw: latest };
  }

  /**
   * Add a pubkey to the mute list
   * @param pubkeyToMute - The pubkey to mute
   * @param isPrivate - If true, encrypt the mute (hidden from others)
   */
  async addToMuteList(pubkeyToMute: string, isPrivate: boolean = true): Promise<void> {
    this.ensureIdentity();

    // Fetch existing mute list
    const { pubkeys: existingPubkeys, raw: existingEvent } = await this.fetchMuteList();

    // Check if already muted
    if (existingPubkeys.includes(pubkeyToMute)) {
      return; // Already muted
    }

    // Parse existing public and private tags
    let publicTags: string[][] = [];
    let privateTags: string[][] = [];

    if (existingEvent) {
      // Keep existing public tags
      publicTags = existingEvent.tags.filter(t => t[0] === 'p');
      
      // Decrypt existing private tags
      if (existingEvent.content && this.conversationKey) {
        try {
          const decrypted = nip44.decrypt(existingEvent.content, this.conversationKey);
          privateTags = JSON.parse(decrypted) as string[][];
        } catch {
          privateTags = [];
        }
      }
    }

    // Add new mute
    const newTag = ['p', pubkeyToMute];
    if (isPrivate) {
      privateTags.push(newTag);
    } else {
      publicTags.push(newTag);
    }

    // Encrypt private tags
    let encryptedContent = '';
    if (privateTags.length > 0 && this.conversationKey) {
      encryptedContent = nip44.encrypt(JSON.stringify(privateTags), this.conversationKey);
    }

    // Publish updated mute list
    const event = await this.signEvent({
      kind: KIND_MUTE_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags: publicTags,
      content: encryptedContent,
    });

    await this.publishEvent(event);
  }

  /**
   * Remove a pubkey from the mute list
   */
  async removeFromMuteList(pubkeyToUnmute: string): Promise<void> {
    this.ensureIdentity();

    // Fetch existing mute list
    const { raw: existingEvent } = await this.fetchMuteList();

    if (!existingEvent) {
      return; // No mute list exists
    }

    // Parse existing public and private tags
    let publicTags = existingEvent.tags.filter(t => t[0] === 'p');
    let privateTags: string[][] = [];

    // Decrypt existing private tags
    if (existingEvent.content && this.conversationKey) {
      try {
        const decrypted = nip44.decrypt(existingEvent.content, this.conversationKey);
        privateTags = JSON.parse(decrypted) as string[][];
      } catch {
        privateTags = [];
      }
    }

    // Remove from both lists
    publicTags = publicTags.filter(t => t[1] !== pubkeyToUnmute);
    privateTags = privateTags.filter(t => t[1] !== pubkeyToUnmute);

    // Encrypt private tags
    let encryptedContent = '';
    if (privateTags.length > 0 && this.conversationKey) {
      encryptedContent = nip44.encrypt(JSON.stringify(privateTags), this.conversationKey);
    }

    // Publish updated mute list
    const event = await this.signEvent({
      kind: KIND_MUTE_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags: publicTags,
      content: encryptedContent,
    });

    await this.publishEvent(event);
  }

  /**
   * Check if a pubkey is muted (uses cached list for performance)
   */
  private mutedPubkeysCache: Set<string> | null = null;
  private mutedPubkeysCacheTime: number = 0;
  private readonly MUTE_CACHE_TTL = 60000; // 1 minute

  async isMuted(pubkey: string): Promise<boolean> {
    // Check cache
    const now = Date.now();
    if (this.mutedPubkeysCache && (now - this.mutedPubkeysCacheTime) < this.MUTE_CACHE_TTL) {
      return this.mutedPubkeysCache.has(pubkey);
    }

    // Refresh cache
    const { pubkeys } = await this.fetchMuteList();
    this.mutedPubkeysCache = new Set(pubkeys);
    this.mutedPubkeysCacheTime = now;

    return this.mutedPubkeysCache.has(pubkey);
  }

  /**
   * Invalidate mute list cache (call after adding/removing mutes)
   */
  invalidateMuteCache(): void {
    this.mutedPubkeysCache = null;
    this.mutedPubkeysCacheTime = 0;
  }
}

/**
 * Create a singleton sync engine instance
 */
let syncEngineInstance: SyncEngine | null = null;

export function getSyncEngine(): SyncEngine {
  if (!syncEngineInstance) {
    syncEngineInstance = new SyncEngine();
  }
  return syncEngineInstance;
}

export function resetSyncEngine(): void {
  syncEngineInstance?.close();
  syncEngineInstance = null;
}

/**
 * Debounced sync trigger for "on save" functionality
 * Waits 2 seconds after last call before triggering sync
 */
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let onSaveSyncCallback: (() => Promise<void>) | null = null;

export function setOnSaveSyncCallback(callback: () => Promise<void>): void {
  onSaveSyncCallback = callback;
}

export function triggerSyncOnSave(): void {
  // Check if on-save sync is enabled
  const syncEnabled = localStorage.getItem('sync_enabled') === 'true';
  const syncFrequency = localStorage.getItem('sync_frequency');

  if (!syncEnabled || syncFrequency !== 'onsave') {
    return;
  }

  // Debounce: wait 2 seconds after last save before syncing
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }

  syncDebounceTimer = setTimeout(() => {
    syncDebounceTimer = null;
    if (onSaveSyncCallback) {
      console.log('Triggering sync on save (debounced)');
      onSaveSyncCallback().catch(err => {
        console.error('Sync on save failed:', err);
      });
    }
  }, 2000);
}
