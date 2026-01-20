/**
 * Asset Index Service for Embed Resolution
 *
 * Builds and maintains a cached index of all embeddable assets in the vault
 * for fast resolution of ![[embed]] targets.
 */

// Supported file extensions by type
export const IMAGE_EXTENSIONS = ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'];
export const AUDIO_EXTENSIONS = ['flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm', '3gp'];
export const VIDEO_EXTENSIONS = ['mkv', 'mov', 'mp4', 'ogv', 'webm'];
export const PDF_EXTENSIONS = ['pdf'];

export type EmbedFileType = 'image' | 'audio' | 'video' | 'pdf' | 'note' | 'unknown';

export interface AssetEntry {
  name: string;
  path: string;
  extension: string;
  relative_path: string;
}

export interface AssetIndex {
  // Map of filename (without extension) -> full paths (may have multiple for same name)
  byName: Map<string, string[]>;
  // Map of relative path -> full path
  byRelativePath: Map<string, string>;
  // Set of all full paths for quick existence checks
  allPaths: Set<string>;
}

/**
 * Normalize an asset name for matching
 * - Lowercase for case-insensitive matching
 * - Strip extension
 */
export function normalizeAssetName(name: string): string {
  // Remove extension
  const lastDot = name.lastIndexOf('.');
  const baseName = lastDot > 0 ? name.substring(0, lastDot) : name;
  return baseName.toLowerCase();
}

/**
 * Determine the embed file type from target string
 */
export function getFileType(target: string): EmbedFileType {
  const lastDot = target.lastIndexOf('.');
  if (lastDot === -1) {
    // No extension - treat as note
    return 'note';
  }

  const ext = target.substring(lastDot + 1).toLowerCase();

  // Check for .md extension - treat as note
  if (ext === 'md') {
    return 'note';
  }

  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';

  return 'unknown';
}

/**
 * Get the parent folder of a path
 */
function getParentFolder(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
}

/**
 * Build the asset index from a list of asset entries
 */
export function buildAssetIndex(assets: AssetEntry[], _vaultPath: string): AssetIndex {
  const index: AssetIndex = {
    byName: new Map(),
    byRelativePath: new Map(),
    allPaths: new Set(),
  };

  for (const asset of assets) {
    // Add to allPaths
    index.allPaths.add(asset.path);

    // Add to byRelativePath (with and without extension)
    index.byRelativePath.set(asset.relative_path, asset.path);
    const relativeNoExt = asset.relative_path.substring(
      0,
      asset.relative_path.lastIndexOf('.')
    );
    if (relativeNoExt) {
      index.byRelativePath.set(relativeNoExt, asset.path);
    }

    // Add to byName
    const normalizedName = normalizeAssetName(asset.name);
    const existing = index.byName.get(normalizedName) || [];
    if (!existing.includes(asset.path)) {
      existing.push(asset.path);
      index.byName.set(normalizedName, existing);
    }
  }

  return index;
}

export interface ResolvedAsset {
  path: string | null;
  exists: boolean;
  fileType: EmbedFileType;
}

/**
 * Resolve an embed target to a file path
 *
 * Resolution priority:
 * 1. Exact relative path match (if target contains '/')
 * 2. Same folder as current file
 * 3. Any matching asset name (case-insensitive)
 * 4. If multiple matches, prefer shortest path
 *
 * For notes (no extension or .md), uses the note index instead.
 */
export function resolveAsset(
  target: string,
  currentFilePath: string,
  assetIndex: AssetIndex | null,
  vaultPath: string
): ResolvedAsset {
  const fileType = getFileType(target);

  // If it's a note type, we don't resolve here - the embed view will handle it
  if (fileType === 'note') {
    return { path: null, exists: false, fileType };
  }

  // 1. If target contains '/', treat as relative path
  if (target.includes('/')) {
    // Try exact path match from asset index first
    if (assetIndex) {
      const fullPath = assetIndex.byRelativePath.get(target);
      if (fullPath) {
        return { path: fullPath, exists: true, fileType };
      }
    }

    // If not in index (e.g., just uploaded), construct path directly
    // This handles the case where a file was just added and index hasn't refreshed
    if (vaultPath) {
      const directPath = vaultPath.replace(/\\/g, '/') + '/' + target;
      // Return as existing - the image onerror will handle if it's actually missing
      return { path: directPath, exists: true, fileType };
    }

    // Path doesn't exist
    return { path: null, exists: false, fileType };
  }

  if (!assetIndex) {
    return { path: null, exists: false, fileType };
  }

  // 2. Look up by normalized name
  const normalizedName = normalizeAssetName(target);
  const matches = assetIndex.byName.get(normalizedName);

  if (!matches || matches.length === 0) {
    return { path: null, exists: false, fileType };
  }

  // If only one match, use it
  if (matches.length === 1) {
    return { path: matches[0], exists: true, fileType };
  }

  // Multiple matches - apply resolution priority

  // 2a. Prefer asset in same folder as current file
  const currentFolder = getParentFolder(currentFilePath);
  const sameFolderMatch = matches.find(p => getParentFolder(p) === currentFolder);
  if (sameFolderMatch) {
    return { path: sameFolderMatch, exists: true, fileType };
  }

  // 2b. Otherwise prefer shortest path (closest to vault root)
  const sortedByLength = [...matches].sort((a, b) => a.length - b.length);
  return { path: sortedByLength[0], exists: true, fileType };
}
