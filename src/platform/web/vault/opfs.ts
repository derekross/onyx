// OPFS path-handle helpers.
//
// The "vault path" string from the Tauri world maps to a single OPFS root
// directory name (default 'onyx-vault'). Absolute paths in the rest of the app
// look like `<vault>/<relative>`; here we strip the vault prefix and walk the
// OPFS tree by segment.

export function splitSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

export function relativeTo(vault: string, absolute: string): string[] {
  const vs = splitSegments(vault);
  const ps = splitSegments(absolute);
  if (ps.length >= vs.length && vs.every((seg, i) => seg === ps[i])) {
    return ps.slice(vs.length);
  }
  return ps;
}

export async function getVaultRoot(vault: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const segs = splitSegments(vault);
  let dir = root;
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

export async function resolveDirectory(
  vault: string,
  absolute: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const rel = relativeTo(vault, absolute);
  let dir = await getVaultRoot(vault);
  for (const seg of rel) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

export async function resolveFile(
  vault: string,
  absolute: string,
  create = false,
): Promise<FileSystemFileHandle> {
  const rel = relativeTo(vault, absolute);
  if (rel.length === 0) throw new Error(`Invalid file path: ${absolute}`);
  const fileName = rel[rel.length - 1];
  let dir = await getVaultRoot(vault);
  for (const seg of rel.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir.getFileHandle(fileName, { create });
}

export async function tryResolveFile(
  vault: string,
  absolute: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await resolveFile(vault, absolute, false);
  } catch {
    return null;
  }
}

export async function tryResolveDirectory(
  vault: string,
  absolute: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await resolveDirectory(vault, absolute, false);
  } catch {
    return null;
  }
}
