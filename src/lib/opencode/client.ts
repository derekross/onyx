/**
 * OpenCode Client Wrapper
 * 
 * Provides a simplified interface to the OpenCode SDK for the chat UI.
 */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/client';

// Server configuration
const DEFAULT_PORT = 4096;
const DEFAULT_HOST = 'http://127.0.0.1';

let client: OpencodeClient | null = null;
let serverUrl: string | null = null;

/**
 * Initialize the OpenCode client
 */
export function initClient(port: number = DEFAULT_PORT): OpencodeClient {
  serverUrl = `${DEFAULT_HOST}:${port}`;
  client = createOpencodeClient({
    baseUrl: serverUrl,
  });
  return client;
}

/**
 * Get the current client instance
 */
export function getClient(): OpencodeClient | null {
  return client;
}

/**
 * Promise with timeout wrapper
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), timeoutMs)
    ),
  ]);
}

/**
 * Check if the OpenCode server is running
 */
export async function isServerRunning(timeoutMs: number = 3000): Promise<boolean> {
  if (!client) {
    initClient();
  }
  
  try {
    const response = await withTimeout(client!.config.get(), timeoutMs);
    return response.response.ok;
  } catch {
    return false;
  }
}

/**
 * Get the server URL
 */
export function getServerUrl(): string | null {
  return serverUrl;
}

/**
 * Message part types from OpenCode
 */
export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: unknown;
}

/**
 * Tool state for active tools (with detailed status)
 */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolPart {
  type: 'tool';
  id: string;
  callId: string;
  toolName: string;
  status: ToolStatus;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type MessagePart = TextPart | ToolCallPart | ToolResultPart | ToolPart;

/**
 * Active tool info (for real-time display)
 */
export interface ActiveTool {
  id: string;
  callId: string;
  toolName: string;
  status: ToolStatus;
  title?: string;
  startTime: number;
}

/**
 * Chat message structure for the UI
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  timestamp: number;
  isStreaming?: boolean;
}

/**
 * Session info
 */
export interface SessionInfo {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Create a new chat session
 */
export async function createSession(title?: string): Promise<SessionInfo> {
  if (!client) {
    initClient();
  }
  
  const response = await client!.session.create({
    body: { title },
  });
  
  if (!response.data) {
    throw new Error('Failed to create session');
  }
  
  return {
    id: response.data.id,
    title: response.data.title,
    createdAt: response.data.time?.created ? new Date(response.data.time.created).getTime() : Date.now(),
    updatedAt: response.data.time?.updated ? new Date(response.data.time.updated).getTime() : Date.now(),
  };
}

/**
 * List all sessions
 */
export async function listSessions(): Promise<SessionInfo[]> {
  if (!client) {
    initClient();
  }
  
  const response = await client!.session.list();
  
  if (!response.data) {
    return [];
  }
  
  return response.data.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.time?.created ? new Date(s.time.created).getTime() : Date.now(),
    updatedAt: s.time?.updated ? new Date(s.time.updated).getTime() : Date.now(),
  }));
}

/**
 * Get messages for a session
 */
export async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  if (!client) {
    initClient();
  }
  
  const response = await client!.session.messages({
    path: { id: sessionId },
  });
  
  if (!response.data) {
    return [];
  }
  
  // The SDK returns messages with info wrapper
  const messages = response.data as unknown as Array<{
    info?: { id: string; role: string; time?: { created?: string } };
    parts?: unknown[];
  }>;
  
  return messages.map((msg) => ({
    id: msg.info?.id || crypto.randomUUID(),
    role: (msg.info?.role || 'assistant') as 'user' | 'assistant',
    parts: (msg.parts || []).map(parsePart),
    timestamp: msg.info?.time?.created ? new Date(msg.info.time.created).getTime() : Date.now(),
  }));
}

/**
 * Parse a message part from the API response
 */
function parsePart(part: unknown): MessagePart {
  const p = part as Record<string, unknown>;
  
  if (p.type === 'text') {
    return { type: 'text', text: p.text as string };
  }
  
  if (p.type === 'tool-call') {
    return {
      type: 'tool-call',
      toolCallId: p.toolCallId as string,
      toolName: p.toolName as string,
      args: p.args as Record<string, unknown>,
    };
  }
  
  if (p.type === 'tool-result') {
    return {
      type: 'tool-result',
      toolCallId: p.toolCallId as string,
      toolName: p.toolName as string,
      result: p.result,
    };
  }
  
  // Handle tool parts with state (from EventMessagePartUpdated)
  if (p.type === 'tool') {
    const state = p.state as Record<string, unknown> | undefined;
    const status = (state?.status as ToolStatus) || 'pending';
    return {
      type: 'tool',
      id: p.id as string,
      callId: p.callID as string,
      toolName: p.tool as string,
      status,
      title: state?.title as string | undefined,
      error: state?.error as string | undefined,
      metadata: p.metadata as Record<string, unknown> | undefined,
    };
  }
  
  // Default to text
  return { type: 'text', text: String(p.text || p.content || '') };
}

/**
 * Send a prompt to a session (non-streaming)
 */
export async function sendPrompt(
  sessionId: string,
  text: string
): Promise<ChatMessage> {
  if (!client) {
    initClient();
  }
  
  const response = await client!.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text }],
    },
  });
  
  if (!response.data) {
    throw new Error('Failed to send prompt');
  }
  
  const msg = response.data as { info?: { id?: string }; parts?: unknown[] };
  return {
    id: msg.info?.id || crypto.randomUUID(),
    role: 'assistant',
    parts: (msg.parts || []).map(parsePart),
    timestamp: Date.now(),
  };
}

/**
 * Send a prompt asynchronously (for streaming)
 * Returns immediately, subscribe to events for updates
 */
export async function sendPromptAsync(
  sessionId: string,
  text: string,
  model?: string
): Promise<void> {
  if (!client) {
    initClient();
  }
  
  // Parse model string if provided
  const modelConfig = model ? parseModelString(model) : undefined;
  
  await client!.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text }],
      ...(modelConfig && { model: modelConfig }),
    },
  });
}

/**
 * Subscribe to server-sent events for real-time updates
 */
export async function subscribeToEvents(
  onEvent: (event: { type: string; properties: Record<string, unknown> }) => void,
  onError?: (error: Error) => void
): Promise<() => void> {
  if (!client) {
    initClient();
  }
  
  try {
    const eventStream = await client!.event.subscribe();
    
    // Process events asynchronously
    (async () => {
      try {
        for await (const event of eventStream.stream) {
          onEvent(event as { type: string; properties: Record<string, unknown> });
        }
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    
    // Return cleanup function
    return () => {
      // The stream will close when iteration stops
    };
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return () => {};
  }
}

/**
 * Abort the current operation in a session
 */
export async function abortSession(sessionId: string): Promise<void> {
  if (!client) {
    initClient();
  }
  
  await client!.session.abort({
    path: { id: sessionId },
  });
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<void> {
  if (!client) {
    initClient();
  }
  
  await client!.session.delete({
    path: { id: sessionId },
  });
}

/**
 * Provider info
 */
export interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

/**
 * Model info
 */
export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
}

/**
 * Get the current model setting (from localStorage)
 */
export function getCurrentModel(): string | null {
  return localStorage.getItem('opencode_model');
}

/**
 * Set the current model (saves to localStorage)
 */
export function setCurrentModel(model: string): void {
  localStorage.setItem('opencode_model', model);
}

/**
 * Parse a model string like "provider/model" into parts
 */
export function parseModelString(model: string): { providerID: string; modelID: string } | null {
  const parts = model.split('/');
  if (parts.length < 2) return null;
  return {
    providerID: parts[0],
    modelID: parts.slice(1).join('/'), // Handle model IDs with slashes
  };
}

// Cache for providers list
let providersCache: ProviderInfo[] | null = null;
let providersCacheTime: number = 0;
const PROVIDERS_CACHE_TTL = 60000; // 1 minute cache

/**
 * Get list of available providers and their models (with caching)
 */
export async function getProviders(timeoutMs: number = 5000, forceRefresh: boolean = false): Promise<ProviderInfo[]> {
  // Return cached data if still valid
  if (!forceRefresh && providersCache && Date.now() - providersCacheTime < PROVIDERS_CACHE_TTL) {
    return providersCache;
  }
  
  if (!client) {
    initClient();
  }
  
  try {
    const response = await withTimeout(client!.provider.list(), timeoutMs);
    const data = response.data as { 
      all?: Array<{
        id: string;
        name: string;
        models?: Record<string, { id: string; name: string }>;
      }>;
      connected?: string[];
    } | undefined;
    
    if (!data?.all) {
      return providersCache || [];
    }
    
    // Get connected providers (ones that have API keys set up)
    const connected = new Set(data.connected || []);
    
    // Map to our format, only include connected providers with models
    const providers = data.all
      .filter(p => connected.has(p.id) && p.models && Object.keys(p.models).length > 0)
      .map(p => ({
        id: p.id,
        name: p.name || p.id,
        models: Object.values(p.models || {}).map(m => ({
          id: m.id,
          name: m.name || m.id,
          providerId: p.id,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    // Update cache
    providersCache = providers;
    providersCacheTime = Date.now();
    
    return providers;
  } catch (err) {
    console.error('Failed to get providers:', err);
    // Return stale cache if available
    return providersCache || [];
  }
}

/**
 * Clear the providers cache (call when settings change)
 */
export function clearProvidersCache(): void {
  providersCache = null;
  providersCacheTime = 0;
}
