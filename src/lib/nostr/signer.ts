/**
 * Nostr Signer Abstraction
 *
 * Provides a unified interface for signing Nostr events, supporting:
 * - Local signing with nsec (NSecSigner)
 * - Remote signing via NIP-46 bunker (NConnectSigner)
 */

import { NConnectSigner, NSecSigner, NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent, NostrSigner as BaseNostrSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';

/**
 * Signer type
 */
export type SignerType = 'local' | 'nip46';

/**
 * Extended signer interface with type info
 */
export interface NostrSigner extends BaseNostrSigner {
  /** Get the signer type */
  getType(): SignerType;
  /** Close connections (for NIP-46) */
  close?(): void;
}

/**
 * Local signer wrapper
 */
class LocalSignerWrapper implements NostrSigner {
  private signer: NSecSigner;

  constructor(secretKey: Uint8Array) {
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

  get nip44() {
    return this.signer.nip44;
  }
}

/**
 * WebSocket connection wrapper for NIP-46
 */
class NIP46WebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private messageHandlers: Set<(msg: any[]) => void> = new Set();
  private connectPromise: Promise<void> | null = null;
  private isConnected = false;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.isConnected = true;
          this.connectPromise = null;
          console.log('[NIP-46] WebSocket connected:', this.url);
          resolve();
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.connectPromise = null;
        };

        this.ws.onerror = (e) => {
          this.isConnected = false;
          this.connectPromise = null;
          reject(e);
        };

        this.ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg[0] === 'EVENT') {
              const event = msg[2];
              console.log('[NIP-46] Received EVENT:', {
                id: event.id?.slice(0, 8),
                kind: event.kind,
                pubkey: event.pubkey?.slice(0, 8),
                pTag: event.tags?.find((t: string[]) => t[0] === 'p')?.[1]?.slice(0, 8),
                contentPreview: event.content?.slice(0, 50),
              });
            } else {
              console.log('[NIP-46] Received message:', msg[0], msg[1]);
            }
            for (const handler of this.messageHandlers) {
              handler(msg);
            }
          } catch {
            // Ignore parse errors
          }
        };

        // Timeout after 10 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            this.ws?.close();
            reject(new Error(`Connection timeout: ${this.url}`));
          }
        }, 10000);
      } catch (err) {
        this.connectPromise = null;
        reject(err);
      }
    });

    return this.connectPromise;
  }

  send(msg: any[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  addMessageHandler(handler: (msg: any[]) => void): void {
    this.messageHandlers.add(handler);
  }

  removeMessageHandler(handler: (msg: any[]) => void): void {
    this.messageHandlers.delete(handler);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.isConnected = false;
    this.messageHandlers.clear();
  }
}

/**
 * Relay group adapter for NConnectSigner using native WebSockets
 */
class RelayGroupAdapter {
  private sockets: Map<string, NIP46WebSocket> = new Map();
  private urls: string[];
  private eoseReceived: boolean = false;
  private eosePromise: Promise<void> | null = null;
  private eoseResolve: (() => void) | null = null;

  constructor(urls: string[]) {
    this.urls = urls;
  }

  private async ensureConnected(): Promise<void> {
    const connectPromises = this.urls.map(async (url) => {
      if (!this.sockets.has(url)) {
        this.sockets.set(url, new NIP46WebSocket(url));
      }
      try {
        await this.sockets.get(url)!.connect();
      } catch {
        // Ignore connection errors for individual relays
      }
    });

    await Promise.allSettled(connectPromises);
  }

  /**
   * Subscribe to events matching filters
   */
  req(filters: any[], options?: { signal?: AbortSignal }): AsyncIterable<[string, string, any]> {
    const self = this;

    // Reset EOSE state for new subscription
    this.eoseReceived = false;
    this.eosePromise = new Promise((resolve) => {
      this.eoseResolve = resolve;
    });

    return {
      async *[Symbol.asyncIterator]() {
        await self.ensureConnected();

        const subId = Math.random().toString(36).substring(2, 15);
        const eventQueue: [string, string, any][] = [];
        const waiters: ((value: [string, string, any] | null) => void)[] = [];
        let closed = false;

        const messageHandler = (msg: any[]) => {
          if (closed) return;

          const [type, sid, payload] = msg;

          if (type === 'EVENT' && sid === subId) {
            const tuple: [string, string, any] = ['EVENT', subId, payload];
            if (waiters.length > 0) {
              waiters.shift()!(tuple);
            } else {
              eventQueue.push(tuple);
            }
          } else if (type === 'EOSE' && sid === subId) {
            if (!self.eoseReceived) {
              self.eoseReceived = true;
              if (self.eoseResolve) {
                self.eoseResolve();
              }
            }
            const tuple: [string, string, any] = ['EOSE', subId, null];
            if (waiters.length > 0) {
              waiters.shift()!(tuple);
            } else {
              eventQueue.push(tuple);
            }
          }
        };

        // Add handler to all sockets
        for (const socket of self.sockets.values()) {
          socket.addMessageHandler(messageHandler);
        }

        // Add 'since' filter but be generous with timing (60 seconds) 
        // to account for clock drift between client and bunker
        const now = Math.floor(Date.now() / 1000);
        const filtersWithSince = filters.map((f: any) => ({
          ...f,
          since: now - 60,
        }));

        // Send REQ to all connected sockets
        const reqMsg = ['REQ', subId, ...filtersWithSince];
        for (const socket of self.sockets.values()) {
          socket.send(reqMsg);
        }
        
        console.log('[NIP-46] Subscribed (subId=' + subId + ') with filters:', JSON.stringify(filtersWithSince));

        // Cleanup function
        const cleanup = () => {
          closed = true;
          for (const socket of self.sockets.values()) {
            socket.removeMessageHandler(messageHandler);
            socket.send(['CLOSE', subId]);
          }
          while (waiters.length > 0) {
            waiters.shift()!(null);
          }
        };

        if (options?.signal) {
          options.signal.addEventListener('abort', cleanup);
        }

        // Yield events
        try {
          while (!closed) {
            if (eventQueue.length > 0) {
              yield eventQueue.shift()!;
            } else {
              const msg = await new Promise<[string, string, any] | null>((resolve) => {
                waiters.push(resolve);
              });
              if (msg === null || closed) break;
              yield msg;
            }
          }
        } finally {
          cleanup();
        }
      }
    };
  }

  /**
   * Publish an event to all relays
   * Waits for subscription to be ready (EOSE) before publishing to avoid race condition
   */
  async event(event: NostrEvent): Promise<void> {
    await this.ensureConnected();

    // Wait for at least one EOSE before publishing (with timeout)
    if (this.eosePromise) {
      await Promise.race([
        this.eosePromise,
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }

    const eventMsg = ['EVENT', event];
    let successes = 0;

    console.log('[NIP-46] Sending event kind:', event.kind, 'to', this.sockets.size, 'relays');

    for (const socket of this.sockets.values()) {
      try {
        socket.send(eventMsg);
        successes++;
      } catch {
        // Ignore send errors
      }
    }

    console.log('[NIP-46] Published to', successes, 'relays');

    if (successes === 0) {
      throw new Error('Failed to publish to any relay');
    }
  }

  /**
   * Close all connections
   */
  close(): void {
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
  }
}

/**
 * Simple relay adapter using NRelay1 from Nostrify
 * This is more reliable than our custom WebSocket handling
 */
class SimpleNRelay1Adapter {
  private relay: NRelay1;
  private url: string;

  constructor(url: string) {
    this.url = url;
    this.relay = new NRelay1(url);
    console.log('[NIP-46] Created NRelay1 adapter for:', url);
  }

  req(filters: any[], options?: { signal?: AbortSignal }): AsyncIterable<[string, string, any]> {
    console.log('[NIP-46] NRelay1 subscribing with filters:', JSON.stringify(filters));
    return this.relay.req(filters, options);
  }

  async event(event: NostrEvent, options?: { signal?: AbortSignal }): Promise<void> {
    console.log('[NIP-46] NRelay1 publishing event kind:', event.kind);
    await this.relay.event(event, options);
    console.log('[NIP-46] NRelay1 event published successfully');
  }

  close(): void {
    console.log('[NIP-46] Closing NRelay1:', this.url);
    this.relay.close();
  }
}

/**
 * NIP-46 remote signer wrapper
 */
class NIP46SignerWrapper implements NostrSigner {
  private signer: NConnectSigner;
  private relay: SimpleNRelay1Adapter;
  private userPubkey: string;
  private secret?: string;
  private connected: boolean = false;
  private connecting: Promise<void> | null = null;

  constructor(
    bunkerPubkey: string,
    clientSecretKey: Uint8Array,
    relays: string[],
    userPubkey: string,
    secret?: string
  ) {
    this.userPubkey = userPubkey;
    this.secret = secret;
    
    // Use the first relay (should be wss://relay.nsec.app for bunker communication)
    const primaryRelay = relays[0] || 'wss://relay.nsec.app';
    console.log('[NIP-46] Using primary relay:', primaryRelay);
    this.relay = new SimpleNRelay1Adapter(primaryRelay);
    
    const clientSigner = new NSecSigner(clientSecretKey);

    this.signer = new NConnectSigner({
      relay: this.relay as any,
      pubkey: bunkerPubkey,
      signer: clientSigner,
      timeout: 120_000, // 2 minutes to allow time for user approval
    });
  }

  /**
   * Ensure we've authenticated with the bunker
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected) return;

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = (async () => {
      try {
        await this.signer.connect(this.secret);
        this.connected = true;
      } catch {
        // Continue anyway - some bunkers might not require connect
        this.connected = true;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async getPublicKey(): Promise<string> {
    return this.userPubkey;
  }

  async signEvent(event: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    await this.ensureConnected();
    return this.signer.signEvent(event);
  }

  /**
   * Test bunker connectivity with a ping
   */
  async ping(): Promise<string> {
    await this.ensureConnected();
    console.log('[NIP-46] Sending ping to bunker...');
    try {
      const result = await this.signer.ping();
      console.log('[NIP-46] Ping response:', result);
      return result;
    } catch (e) {
      console.error('[NIP-46] Ping failed:', e);
      throw e;
    }
  }

  getType(): SignerType {
    return 'nip46';
  }

  close(): void {
    this.relay.close();
  }

  get nip44() {
    const self = this;
    const originalNip44 = this.signer.nip44;

    return {
      async encrypt(pubkey: string, plaintext: string): Promise<string> {
        await self.ensureConnected();

        // Timeout for unresponsive bunkers
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(
              'Bunker did not respond to nip44_encrypt request. ' +
              'Your bunker may not support this operation or may require manual approval.'
            ));
          }, 30000);
        });

        return Promise.race([
          originalNip44.encrypt(pubkey, plaintext),
          timeoutPromise,
        ]);
      },

      async decrypt(pubkey: string, ciphertext: string): Promise<string> {
        await self.ensureConnected();

        // Timeout for unresponsive bunkers
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(
              'Bunker did not respond to nip44_decrypt request. ' +
              'Your bunker may not support this operation or may require manual approval. ' +
              'Please check your bunker app for pending approvals.'
            ));
          }, 30000);
        });

        return Promise.race([
          originalNip44.decrypt(pubkey, ciphertext),
          timeoutPromise,
        ]);
      },
    };
  }
}

/**
 * Login data structure from localStorage
 */
export interface LoginData {
  type: 'nsec' | 'bunker' | 'extension';
  pubkey: string;
  nsec?: string;
  bunkerData?: {
    bunkerPubkey: string;
    clientNsec: string;
    relays: string[];
    secret?: string;
  };
}

/**
 * Known dead relays to filter out
 */
const DEAD_RELAYS = [
  'wss://relay.nostr.band',
];

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

  if (login.type === 'bunker' && login.bunkerData) {
    try {
      const clientDecoded = nip19.decode(login.bunkerData.clientNsec);
      if (clientDecoded.type !== 'nsec') return null;

      // Filter out known dead relays and ensure we have the bunker relay
      const bunkerRelay = 'wss://relay.nsec.app';
      let relays = login.bunkerData.relays.filter(
        url => !DEAD_RELAYS.includes(url)
      );
      
      // Always include the dedicated bunker relay for reliable NIP-46 communication
      if (!relays.includes(bunkerRelay)) {
        relays = [bunkerRelay, ...relays];
      }

      if (relays.length === 0) {
        return null;
      }

      return new NIP46SignerWrapper(
        login.bunkerData.bunkerPubkey,
        clientDecoded.data,
        relays,
        login.pubkey,
        login.bunkerData.secret
      );
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Get signer from current login stored in localStorage
 */
export function getSignerFromStoredLogin(): NostrSigner | null {
  const loginStr = localStorage.getItem('nostr_login');
  if (!loginStr) return null;

  try {
    const login: LoginData = JSON.parse(loginStr);
    return createSignerFromLogin(login);
  } catch {
    return null;
  }
}
