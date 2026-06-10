import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AIProviderProxy } from '../types';

export const ai: AIProviderProxy = {
  customProviderRequest(url, apiKey, body) {
    return invoke<string>('custom_provider_request', { url, apiKey, body });
  },
  async customProviderStream(requestId, url, apiKey, body) {
    await invoke<void>('custom_provider_stream', { requestId, url, apiKey, body });
  },
  customProviderListModels(url, apiKey) {
    return invoke<string>('custom_provider_list_models', { url, apiKey });
  },
  async onCustomProviderChunk(requestId, cb) {
    const off = await listen<string>(`custom-provider-stream-${requestId}`, (event) =>
      cb(event.payload),
    );
    return () => off();
  },
  openClawRequest(url, token, body) {
    return invoke<string>('openclaw_request', { url, token, body });
  },
  async openClawStream(requestId, url, token, body) {
    await invoke<void>('openclaw_stream', { requestId, url, token, body });
  },
  async onOpenClawChunk(requestId, cb) {
    const off = await listen<string>(`openclaw-stream-${requestId}`, (event) =>
      cb(event.payload),
    );
    return () => off();
  },
  openClawGatewayRequest(wsUrl, token, method, params) {
    return invoke<string>('openclaw_gateway_request', { wsUrl, token, method, params });
  },
};
