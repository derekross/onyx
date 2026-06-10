import { invoke } from '@tauri-apps/api/core';
import type { SecretStore } from '../types';

export const secrets: SecretStore = {
  async get(key) {
    return invoke<string | null>('keyring_get', { key });
  },
  async set(key, value) {
    await invoke<void>('keyring_set', { key, value });
  },
  async delete(key) {
    await invoke<void>('keyring_delete', { key });
  },
};
