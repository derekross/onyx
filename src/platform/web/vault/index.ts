import type { AssetEntry, FileEntry, FileStats, VaultFS } from '../../types';
import {
  getVaultRoot,
  relativeTo,
  resolveDirectory,
  resolveFile,
  splitSegments,
  tryResolveDirectory,
  tryResolveFile,
} from './opfs';
import {
  notifyChange,
  onFilesChanged as listenFilesChanged,
  onFileModified as listenFileModified,
  startWatcher,
  stopWatcher,
} from './watcher';

let currentVault: string | null = null;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const ASSET_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif',
  'pdf', 'docx', 'xlsx', 'pptx',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov',
]);

async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  basePath: string,
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  // FileSystemDirectoryHandle has an async iterator via .values()
  for await (const handle of (dir as unknown as {
    values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  }).values()) {
    const path = basePath ? `${basePath}/${handle.name}` : handle.name;
    if (handle.kind === 'directory') {
      const children = await walkDirectory(handle as FileSystemDirectoryHandle, path);
      entries.push({ name: handle.name, path, isDirectory: true, children });
    } else {
      entries.push({ name: handle.name, path, isDirectory: false });
    }
  }
  // Sort: directories first, then alphabetical within each group
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function readFileBytes(vault: string, path: string): Promise<Uint8Array> {
  const handle = await resolveFile(vault, path, false);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFileBytes(vault: string, path: string, data: Uint8Array): Promise<void> {
  const handle = await resolveFile(vault, path, true);
  // FileSystemFileHandle.createWritable() exists on Chromium/Safari; OPFS supports it.
  const writable = await (handle as unknown as {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }).createWritable();
  // Copy into a fresh ArrayBuffer to satisfy the TS lib's BufferSource constraint
  // (which excludes SharedArrayBuffer-backed views).
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  await writable.write(buf);
  await writable.close();
}

export const vault: VaultFS = {
  async list(vaultPath) {
    const root = await getVaultRoot(vaultPath);
    const tree = await walkDirectory(root, vaultPath);
    return tree;
  },

  async listAssets(vaultPath) {
    const root = await getVaultRoot(vaultPath);
    const out: AssetEntry[] = [];
    const visit = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const handle of (dir as unknown as {
        values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
      }).values()) {
        const relative = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (handle.kind === 'directory') {
          await visit(handle as FileSystemDirectoryHandle, relative);
        } else {
          const ext = handle.name.split('.').pop()?.toLowerCase() ?? '';
          if (ASSET_EXTS.has(ext)) {
            out.push({
              name: handle.name,
              path: `${vaultPath}/${relative}`,
              extension: ext,
              relative_path: relative,
            });
          }
        }
      }
    };
    await visit(root, '');
    return out;
  },

  async read(path, vaultPath) {
    const bytes = await readFileBytes(vaultPath, path);
    return decoder.decode(bytes);
  },

  async readBinary(path, vaultPath) {
    return readFileBytes(vaultPath, path);
  },

  async write(path, content, vaultPath) {
    await writeFileBytes(vaultPath, path, encoder.encode(content));
    notifyChange([path]);
  },

  async writeBinary(path, data, vaultPath) {
    await writeFileBytes(vaultPath, path, data);
    notifyChange([path]);
  },

  async createFile(path, vaultPath) {
    await writeFileBytes(vaultPath, path, new Uint8Array(0));
    notifyChange([path]);
  },

  async createFolder(path, vaultPath) {
    await resolveDirectory(vaultPath, path, true);
    notifyChange([path]);
  },

  async rename(oldPath, newPath, vaultPath) {
    // OPFS has no rename primitive. Copy then delete.
    const src = await tryResolveFile(vaultPath, oldPath);
    if (src) {
      const bytes = new Uint8Array(await (await src.getFile()).arrayBuffer());
      await writeFileBytes(vaultPath, newPath, bytes);
      const segs = splitSegments(oldPath);
      const parent = segs.slice(0, -1).join('/');
      const parentDir = parent
        ? await resolveDirectory(vaultPath, `${vaultPath}/${relativeTo(vaultPath, parent).join('/')}`, false)
        : await getVaultRoot(vaultPath);
      await parentDir.removeEntry(segs[segs.length - 1]);
      notifyChange([oldPath, newPath]);
      return;
    }
    // Directory rename: walk children, write to new locations, then remove the old tree.
    const dir = await tryResolveDirectory(vaultPath, oldPath);
    if (!dir) throw new Error(`No such file or directory: ${oldPath}`);
    const oldRel = relativeTo(vaultPath, oldPath).join('/');
    const newRel = relativeTo(vaultPath, newPath).join('/');
    const copy = async (
      d: FileSystemDirectoryHandle,
      relUnderOld: string,
    ): Promise<void> => {
      for await (const handle of (d as unknown as {
        values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
      }).values()) {
        const childRel = relUnderOld ? `${relUnderOld}/${handle.name}` : handle.name;
        const newChildAbs = `${vaultPath}/${newRel}/${childRel}`;
        if (handle.kind === 'directory') {
          await resolveDirectory(vaultPath, newChildAbs, true);
          await copy(handle as FileSystemDirectoryHandle, childRel);
        } else {
          const f = await (handle as FileSystemFileHandle).getFile();
          await writeFileBytes(vaultPath, newChildAbs, new Uint8Array(await f.arrayBuffer()));
        }
      }
    };
    await resolveDirectory(vaultPath, newPath, true);
    await copy(dir, '');
    // Remove old tree
    const parentSegs = splitSegments(oldRel).slice(0, -1);
    const parentDir = parentSegs.length
      ? await resolveDirectory(vaultPath, `${vaultPath}/${parentSegs.join('/')}`, false)
      : await getVaultRoot(vaultPath);
    const lastSeg = splitSegments(oldRel).slice(-1)[0];
    if (lastSeg) {
      await parentDir.removeEntry(lastSeg, { recursive: true } as FileSystemRemoveOptions);
    }
    notifyChange([oldPath, newPath]);
  },

  async remove(path, vaultPath) {
    const segs = splitSegments(relativeTo(vaultPath, path).join('/'));
    if (segs.length === 0) throw new Error('Refusing to remove vault root');
    const lastSeg = segs[segs.length - 1];
    const parentSegs = segs.slice(0, -1);
    const parentDir = parentSegs.length
      ? await resolveDirectory(vaultPath, `${vaultPath}/${parentSegs.join('/')}`, false)
      : await getVaultRoot(vaultPath);
    await parentDir.removeEntry(lastSeg, { recursive: true } as FileSystemRemoveOptions);
    notifyChange([path]);
  },

  async copy(source, dest, vaultPath) {
    const file = await tryResolveFile(vaultPath, source);
    if (file) {
      const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
      await writeFileBytes(vaultPath, dest, bytes);
      notifyChange([dest]);
      return;
    }
    throw new Error(`Copy of directories not implemented for web yet (source: ${source})`);
  },

  async exists(path) {
    const v = currentVault;
    if (!v) return false;
    return (
      (await tryResolveFile(v, path)) !== null ||
      (await tryResolveDirectory(v, path)) !== null
    );
  },

  async modifiedTime(path) {
    const v = currentVault;
    if (!v) return 0;
    const file = await tryResolveFile(v, path);
    if (!file) return 0;
    const f = await file.getFile();
    return Math.floor(f.lastModified / 1000);
  },

  async stats(path): Promise<FileStats> {
    const v = currentVault;
    if (!v) return { size: 0, created: 0, modified: 0 };
    const file = await tryResolveFile(v, path);
    if (!file) return { size: 0, created: 0, modified: 0 };
    const f = await file.getFile();
    return {
      size: f.size,
      created: Math.floor(f.lastModified / 1000),
      modified: Math.floor(f.lastModified / 1000),
    };
  },

  async setVaultScope(vaultPath) {
    currentVault = vaultPath;
    (window as unknown as { __onyxVault?: string }).__onyxVault = vaultPath;
  },

  async startWatching(vaultPath) {
    currentVault = vaultPath;
    (window as unknown as { __onyxVault?: string }).__onyxVault = vaultPath;
    await startWatcher(vaultPath);
  },

  async stopWatching() {
    await stopWatcher();
  },

  async onFilesChanged(cb) {
    return listenFilesChanged(cb);
  },

  async onFileModified(cb) {
    return listenFileModified(cb);
  },
};
