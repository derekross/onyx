import type { AIProviderProxy } from '../types';

// Phase 4 wires this up to direct fetch + a CORS worker fallback. For Phase 2,
// AI providers are gated off by capabilities and these stubs reject loudly so
// any caller forgetting to gate gets a clear message.

function notImplemented(method: string): never {
  throw new Error(
    `AI provider proxy "${method}" is not available on web yet (Phase 4).`,
  );
}

export const ai: AIProviderProxy = {
  async customProviderRequest() {
    return notImplemented('customProviderRequest');
  },
  async customProviderStream() {
    return notImplemented('customProviderStream');
  },
  async customProviderListModels() {
    return notImplemented('customProviderListModels');
  },
  async onCustomProviderChunk() {
    return notImplemented('onCustomProviderChunk');
  },
  async openClawRequest() {
    return notImplemented('openClawRequest');
  },
  async openClawStream() {
    return notImplemented('openClawStream');
  },
  async onOpenClawChunk() {
    return notImplemented('onOpenClawChunk');
  },
  async openClawGatewayRequest() {
    return notImplemented('openClawGatewayRequest');
  },
};
