import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { OpenCode, OpenCodeInstallProgress } from '../types';

export const opencode: OpenCode = {
  isInstalled() {
    return invoke<string | null>('check_opencode_installed');
  },
  getInstallPath() {
    return invoke<string>('get_opencode_install_path');
  },
  async install(onProgress) {
    let off: (() => void) | undefined;
    if (onProgress) {
      const handle = await listen<OpenCodeInstallProgress>(
        'opencode-install-progress',
        (event) => onProgress(event.payload),
      );
      off = () => handle();
    }
    try {
      return await invoke<string>('install_opencode');
    } finally {
      off?.();
    }
  },
  getVersion() {
    return invoke<string>('get_opencode_version');
  },
  registerPath(path) {
    return invoke<string>('register_opencode_path', { path });
  },
  async getRegisteredPath() {
    const v = await invoke<string | null>('get_registered_opencode_path');
    return v ?? null;
  },
  async startServer({ command, cwd, port }) {
    await invoke<void>('start_opencode_server', { command, cwd, port });
  },
  async stopServer() {
    await invoke<void>('stop_opencode_server');
  },
  isServerManaged() {
    return invoke<boolean>('is_opencode_server_managed');
  },
  spawnPty({ command, cwd, cols, rows }) {
    return invoke<string>('spawn_pty', { command, cwd, cols, rows });
  },
  async writePty(sessionId, data) {
    await invoke<void>('write_pty', { sessionId, data });
  },
  async resizePty(sessionId, cols, rows) {
    await invoke<void>('resize_pty', { sessionId, cols, rows });
  },
  async killPty(sessionId) {
    await invoke<void>('kill_pty', { sessionId });
  },
  async onPtyOutput(sessionId, cb) {
    const off = await listen<string>(`pty-output-${sessionId}`, (event) => cb(event.payload));
    return () => off();
  },
  async onPtyExit(sessionId, cb) {
    const off = await listen(`pty-exit-${sessionId}`, () => cb());
    return () => off();
  },
};
