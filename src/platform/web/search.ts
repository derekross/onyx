import type { Search, SearchResult } from '../types';
import { getVaultRoot } from './vault/opfs';

const SEARCHABLE_EXTS = new Set([
  'md', 'mdx', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx',
  'html', 'css', 'csv',
]);

export const search: Search = {
  async searchVault(vaultPath, query) {
    if (!query.trim()) return [];
    const needle = query.toLowerCase();
    const results: SearchResult[] = [];

    const visit = async (
      dir: FileSystemDirectoryHandle,
      prefix: string,
    ): Promise<void> => {
      for await (const handle of (dir as unknown as {
        values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
      }).values()) {
        const relative = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (handle.kind === 'directory') {
          await visit(handle as FileSystemDirectoryHandle, relative);
          continue;
        }
        const ext = handle.name.split('.').pop()?.toLowerCase() ?? '';
        if (!SEARCHABLE_EXTS.has(ext)) continue;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          const text = await file.text();
          const lines = text.split('\n');
          const matches: SearchResult['matches'] = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              matches.push({ line: i + 1, content: lines[i] });
              if (matches.length >= 20) break;
            }
          }
          if (matches.length > 0) {
            results.push({
              name: handle.name,
              path: `${vaultPath}/${relative}`,
              matches,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
    };

    const root = await getVaultRoot(vaultPath);
    await visit(root, '');
    return results;
  },
};
