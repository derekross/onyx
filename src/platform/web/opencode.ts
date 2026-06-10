import type { OpenCode } from '../types';

function notImplemented(method: string): never {
  throw new Error(
    `OpenCode.${method} is not available on web yet. ` +
      `Wire up the WebSocket backend (Phase 5) before enabling these features.`,
  );
}

export const opencode: OpenCode = {
  async isInstalled() {
    return null;
  },
  async getInstallPath() {
    return notImplemented('getInstallPath');
  },
  async install() {
    return notImplemented('install');
  },
  async getVersion() {
    return notImplemented('getVersion');
  },
  async registerPath(_path) {
    return notImplemented('registerPath');
  },
  async getRegisteredPath() {
    return null;
  },
  async startServer() {
    return notImplemented('startServer');
  },
  async stopServer() {
    return notImplemented('stopServer');
  },
  async isServerManaged() {
    return false;
  },
  async spawnPty() {
    return notImplemented('spawnPty');
  },
  async writePty() {
    return notImplemented('writePty');
  },
  async resizePty() {
    return notImplemented('resizePty');
  },
  async killPty() {
    return notImplemented('killPty');
  },
  async onPtyOutput() {
    return notImplemented('onPtyOutput');
  },
  async onPtyExit() {
    return notImplemented('onPtyExit');
  },
};
