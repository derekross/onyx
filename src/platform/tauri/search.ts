import { invoke } from '@tauri-apps/api/core';
import type { Search, SearchResult } from '../types';

export const search: Search = {
  searchVault(vaultPath, query) {
    return invoke<SearchResult[]>('search_files', { path: vaultPath, query });
  },
};
