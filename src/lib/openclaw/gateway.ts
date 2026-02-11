/**
 * OpenClaw Gateway client
 * Communicates with the OpenClaw Gateway WebSocket via Rust proxy.
 * All WS communication goes through Tauri's Rust backend to bypass CSP restrictions.
 */

import { invoke } from '@tauri-apps/api/core';

// --- Types ---

export interface SkillStatus {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv: string | null;
  emoji: string | null;
  homepage: string | null;
  always: boolean;
  disabled: boolean;
  eligible: boolean;
  requirements: { bins: string[]; env: string[]; config: string[] };
  missing: { bins: string[]; env: string[]; config: string[] };
  configChecks: Array<{ path: string; value: unknown; satisfied: boolean }>;
  install: Array<{ id: string; kind: string; label: string; bins: string[] }>;
}

export interface SkillsStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatus[];
}

export interface SkillInstallResult {
  ok: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface SkillUpdateResult {
  ok: boolean;
  skillKey: string;
  config: Record<string, unknown> | null;
}

// --- Helper to derive WS URL from HTTP URL ---

function httpToWsUrl(httpUrl: string): string {
  // http://192.168.1.5:18789 -> ws://192.168.1.5:18789
  // https://example.com:18789 -> wss://example.com:18789
  return httpUrl
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://')
    .replace(/\/+$/, '');
}

// --- Get config from localStorage ---

function getConfig(): { wsUrl: string; token: string } | null {
  const httpUrl = localStorage.getItem('openclaw_url');
  const token = localStorage.getItem('openclaw_token');
  if (!httpUrl || !token) return null;
  return { wsUrl: httpToWsUrl(httpUrl), token };
}

// --- Gateway API ---

/**
 * Send a request to the OpenClaw Gateway via the Rust WS proxy.
 * Handles full lifecycle: connect, handshake, request, response, disconnect.
 */
async function gatewayRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const config = getConfig();
  if (!config) throw new Error('OpenClaw is not configured');

  const result = await invoke<string>('openclaw_gateway_request', {
    wsUrl: config.wsUrl,
    token: config.token,
    method,
    params: JSON.stringify(params),
  });

  return JSON.parse(result) as T;
}

/**
 * Get the full status of all skills on the OpenClaw server.
 */
export async function getSkillsStatus(agentId?: string): Promise<SkillsStatusReport> {
  return gatewayRequest<SkillsStatusReport>('skills.status', agentId ? { agentId } : {});
}

/**
 * Get the list of all binary names required by skills.
 */
export async function getSkillsBins(): Promise<string[]> {
  const result = await gatewayRequest<{ bins: string[] }>('skills.bins', {});
  return result.bins;
}

/**
 * Install a skill's binary dependency on the server.
 */
export async function installSkill(
  name: string,
  installId: string,
  timeoutMs: number = 300000
): Promise<SkillInstallResult> {
  return gatewayRequest<SkillInstallResult>('skills.install', {
    name,
    installId,
    timeoutMs,
  });
}

/**
 * Update a skill's configuration (enable/disable, set API key, env vars).
 */
export async function updateSkill(opts: {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}): Promise<SkillUpdateResult> {
  return gatewayRequest<SkillUpdateResult>('skills.update', opts);
}

/**
 * Check if the OpenClaw Gateway is reachable and responsive.
 */
export async function testGatewayConnection(): Promise<boolean> {
  try {
    await getSkillsStatus();
    return true;
  } catch {
    return false;
  }
}
