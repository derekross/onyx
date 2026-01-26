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
 * Permission/Question from OpenCode
 */
export interface Permission {
  id: string;
  type: string;
  sessionId: string;
  messageId: string;
  callId?: string;
  title: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

/**
 * Question option for the question tool
 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * Parsed question from permission metadata
 */
export interface Question {
  permissionId: string;
  sessionId: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/**
 * Tool permission request (for file edits, bash commands, etc.)
 */
export interface ToolPermission {
  id: string;
  sessionId: string;
  type: string; // 'edit', 'bash', 'read', etc.
  title: string;
  description?: string;
  // For file operations
  filePath?: string;
  // For bash commands
  command?: string;
  // Suggested patterns to remember
  remember?: string[];
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
 * Respond to a tool permission (file edit, bash, etc.)
 * Response should be "once", "always", or "reject"
 */
export async function respondToToolPermission(
  sessionId: string,
  permissionId: string,
  response: 'once' | 'always' | 'reject'
): Promise<void> {
  if (!client) {
    initClient();
  }
  
  const url = `${serverUrl}/session/${sessionId}/permissions/${permissionId}`;
  
  console.log('[OpenCode] Responding to tool permission:', { sessionId, permissionId, response });
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      response: response,
    }),
  });
  
  if (!res.ok) {
    const text = await res.text();
    console.error('[OpenCode] Permission response failed:', res.status, text);
    throw new Error(`Failed to respond to permission: ${res.status} ${text}`);
  }
  
  console.log('[OpenCode] Permission response sent successfully');
}

/**
 * Respond to a question from the question tool
 * Response is an array of selected option labels
 */
export async function respondToPermission(
  sessionId: string,
  permissionId: string,
  response: string[]
): Promise<void> {
  if (!client) {
    initClient();
  }
  
  const url = `${serverUrl}/session/${sessionId}/permissions/${permissionId}`;
  
  console.log('[OpenCode] Responding to question:', { sessionId, permissionId, response });
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      response: response,
    }),
  });
  
  if (!res.ok) {
    const text = await res.text();
    console.error('[OpenCode] Question response failed:', res.status, text);
    throw new Error(`Failed to respond to question: ${res.status} ${text}`);
  }
  
  console.log('[OpenCode] Question response sent successfully');
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
 * Set the current model (saves to localStorage and dispatches event)
 */
export function setCurrentModel(model: string): void {
  localStorage.setItem('opencode_model', model);
  // Dispatch a custom event so other components can react to model changes
  window.dispatchEvent(new CustomEvent('opencode-model-changed', { detail: { model } }));
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

/**
 * Provider auth info for UI display
 */
export interface ProviderAuthInfo {
  id: string;
  name: string;
  authMethods: Array<{ type: 'oauth' | 'api'; label: string }>;
  isConnected: boolean;
  env: string[];
}

/**
 * Get provider authentication methods
 * Returns available auth methods for each provider
 * Note: This endpoint may not be available in all OpenCode versions
 */
export async function getProviderAuthMethods(timeoutMs: number = 5000): Promise<Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>> {
  if (!client) {
    initClient();
  }
  
  try {
    const response = await withTimeout(client!.provider.auth(), timeoutMs);
    // Check if response contains an error
    if (response.data && typeof response.data === 'object' && 'name' in response.data && (response.data as { name?: string }).name === 'APIError') {
      console.log('Provider auth endpoint returned error, falling back to env-based detection');
      return {};
    }
    return (response.data || {}) as Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>;
  } catch (err) {
    // This is expected if the endpoint doesn't exist in older versions
    console.log('Provider auth endpoint not available:', err);
    return {};
  }
}

/**
 * Get list of all providers with their auth status
 */
export async function getAllProvidersWithAuthStatus(timeoutMs: number = 5000): Promise<ProviderAuthInfo[]> {
  if (!client) {
    initClient();
  }
  
  try {
    // Get providers list first
    const providersResponse = await withTimeout(client!.provider.list(), timeoutMs);
    
    const data = providersResponse.data as {
      all?: Array<{
        id: string;
        name: string;
        env: string[];
        models?: Record<string, unknown>;
      }>;
      connected?: string[];
    } | undefined;
    
    if (!data?.all) {
      return [];
    }
    
    // Try to get auth methods, but don't fail if endpoint doesn't exist
    let authMethods: Record<string, Array<{ type: 'oauth' | 'api'; label: string }>> = {};
    try {
      authMethods = await getProviderAuthMethods(timeoutMs);
    } catch {
      // Ignore - we'll fall back to env-based detection
    }
    
    const connected = new Set(data.connected || []);
    
    return data.all
      // Show providers that have env vars (API key support) OR have auth methods from the endpoint
      .filter(p => (p.env && p.env.length > 0) || authMethods[p.id]?.length > 0)
      .map(p => {
        // Build auth methods: use endpoint data if available, otherwise create API method from env vars
        let methods = authMethods[p.id] || [];
        
        // If no methods from endpoint but has env vars, add API key method
        if (methods.length === 0 && p.env && p.env.length > 0) {
          methods = [{ type: 'api' as const, label: 'API Key' }];
        }
        
        return {
          id: p.id,
          name: p.name || p.id,
          authMethods: methods,
          isConnected: connected.has(p.id),
          env: p.env || [],
        };
      })
      .sort((a, b) => {
        // Sort connected providers first, then by name
        if (a.isConnected !== b.isConnected) {
          return a.isConnected ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  } catch (err) {
    console.error('Failed to get providers with auth status:', err);
    return [];
  }
}

/**
 * Set an API key for a provider
 */
export async function setProviderApiKey(providerId: string, apiKey: string): Promise<boolean> {
  if (!client) {
    initClient();
  }
  
  try {
    const response = await client!.auth.set({
      path: { id: providerId },
      body: { type: 'api', key: apiKey },
    });
    
    // Clear the providers cache after setting a new key
    clearProvidersCache();
    
    return response.data === true;
  } catch (err) {
    console.error('Failed to set provider API key:', err);
    throw err;
  }
}

/**
 * Remove/clear API key for a provider (set empty key)
 * Note: OpenCode doesn't have a dedicated remove endpoint, so we set an empty key
 * or use OAuth removal if it's an OAuth provider
 */
export async function removeProviderAuth(providerId: string): Promise<boolean> {
  if (!client) {
    initClient();
  }
  
  try {
    // Setting an empty API key effectively removes the credential
    const response = await client!.auth.set({
      path: { id: providerId },
      body: { type: 'api', key: '' },
    });
    
    // Clear the providers cache after removing
    clearProvidersCache();
    
    return response.data === true;
  } catch (err) {
    console.error('Failed to remove provider auth:', err);
    throw err;
  }
}

/**
 * Start OAuth flow for a provider
 * Returns the authorization URL to open in browser
 */
export async function startProviderOAuth(providerId: string, methodIndex: number = 0): Promise<{ url: string; method: 'auto' | 'code'; instructions: string } | null> {
  if (!client) {
    initClient();
  }
  
  try {
    const response = await client!.provider.oauth.authorize({
      path: { id: providerId },
      body: { method: methodIndex },
    });
    
    if (response.data) {
      return response.data as { url: string; method: 'auto' | 'code'; instructions: string };
    }
    return null;
  } catch (err) {
    console.error('Failed to start OAuth flow:', err);
    throw err;
  }
}

/**
 * Complete OAuth flow with authorization code
 */
export async function completeProviderOAuth(providerId: string, code: string, methodIndex: number = 0): Promise<boolean> {
  if (!client) {
    initClient();
  }
  
  try {
    const response = await client!.provider.oauth.callback({
      path: { id: providerId },
      body: { method: methodIndex, code },
    });
    
    // Clear the providers cache after completing OAuth
    clearProvidersCache();
    
    return response.data === true;
  } catch (err) {
    console.error('Failed to complete OAuth flow:', err);
    throw err;
  }
}
