import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AssetEntry, FileEntry, FileStats, VaultFS } from '../types';

export const vault: VaultFS = {
  list(vaultPath) {
    return invoke<FileEntry[]>('list_files', { path: vaultPath });
  },
  listAssets(vaultPath) {
    return invoke<AssetEntry[]>('list_assets', { path: vaultPath });
  },
  read(path, vaultPath) {
    return invoke<string>('read_file', { path, vaultPath });
  },
  async readBinary(path, vaultPath) {
    // The backend returns a raw tauri::ipc::Response, so this arrives as an
    // ArrayBuffer instead of a JSON-serialized number array.
    const data = await invoke<ArrayBuffer>('read_binary_file', { path, vaultPath });
    return new Uint8Array(data);
  },
  write(path, content, vaultPath) {
    return invoke<void>('write_file', { path, content, vaultPath });
  },
  writeBinary(path, data, vaultPath) {
    return invoke<void>('write_binary_file', {
      path,
      data: Array.from(data),
      vaultPath,
    });
  },
  createFile(path, vaultPath) {
    return invoke<void>('create_file', { path, vaultPath });
  },
  createFolder(path, vaultPath) {
    return invoke<void>('create_folder', { path, vaultPath });
  },
  rename(oldPath, newPath, vaultPath) {
    return invoke<void>('rename_file', { oldPath, newPath, vaultPath });
  },
  remove(path, vaultPath) {
    return invoke<void>('delete_file', { path, vaultPath });
  },
  copy(source, dest, vaultPath) {
    return invoke<void>('copy_file', { source, dest, vaultPath });
  },
  exists(path) {
    return invoke<boolean>('file_exists', { path });
  },
  modifiedTime(path) {
    return invoke<number>('get_file_modified_time', { path });
  },
  stats(path) {
    return invoke<FileStats>('get_file_stats', { path });
  },
  setVaultScope(vaultPath) {
    return invoke<void>('set_vault_scope', { vaultPath });
  },
  startWatching(vaultPath) {
    return invoke<void>('start_watching', { path: vaultPath });
  },
  stopWatching() {
    return invoke<void>('stop_watching');
  },
  async onFilesChanged(cb) {
    const off = await listen('files-changed', () => cb());
    return () => off();
  },
  async onFileModified(cb) {
    const off = await listen<string[]>('file-modified', (event) => cb(event.payload));
    return () => off();
  },
};
