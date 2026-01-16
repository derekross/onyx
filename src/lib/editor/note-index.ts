/**
 * Note Index Service for Wikilink Resolution
 *
 * Builds and maintains a cached index of all notes in the vault for fast
 * wikilink resolution. Follows Obsidian-compatible matching behavior.
 */

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

export interface NoteIndex {
  // Map of normalized name -> full paths (may have multiple for same name in different folders)
  byName: Map<string, string[]>;
  // Map of relative path (from vault root) -> full path
  byRelativePath: Map<string, string>;
  // Set of all full paths for quick existence checks
  allPaths: Set<string>;
}

/**
 * Normalize a note name for matching (Obsidian-compatible)
 * - Lowercase for case-insensitive matching
 * - Strip .md extension
 * - Treat -, _, and space as equivalent
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.md$/i, '')        // Strip .md extension
    .replace(/[-_]/g, ' ')        // Treat -, _, space as equivalent
    .trim();
}

/**
 * Path separator regex - matches both / and \
 */
const PATH_SEP_REGEX = /[/\\]/;

/**
 * Get the relative path from vault root, handling both path separators
 */
function getRelativePath(filePath: string, vaultPath: string): string {
  // Check for both separator types
  if (filePath.startsWith(vaultPath + '/') || filePath.startsWith(vaultPath + '\\')) {
    return filePath.slice(vaultPath.length + 1);
  }
  return filePath;
}

/**
 * Get the parent folder of a path
 */
function getParentFolder(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
}

/**
 * Extract just the filename without extension from a path
 * Handles both Unix (/) and Windows (\) path separators
 */
function getBaseName(filePath: string): string {
  const parts = filePath.split(PATH_SEP_REGEX);
  const fileName = parts[parts.length - 1];
  return fileName.replace(/\.md$/i, '');
}

/**
 * Recursively collect all markdown files from a file tree
 */
function collectMarkdownFiles(entries: FileEntry[], collected: FileEntry[] = []): FileEntry[] {
  for (const entry of entries) {
    if (entry.isDirectory && entry.children) {
      collectMarkdownFiles(entry.children, collected);
    } else if (!entry.isDirectory && entry.name.endsWith('.md')) {
      collected.push(entry);
    }
  }
  return collected;
}

/**
 * Build the note index from a file tree
 * Called on vault load and can be called incrementally on file changes
 */
export function buildNoteIndex(files: FileEntry[], vaultPath: string): NoteIndex {
  const index: NoteIndex = {
    byName: new Map(),
    byRelativePath: new Map(),
    allPaths: new Set(),
  };

  // Collect all markdown files recursively
  const markdownFiles = collectMarkdownFiles(files);

  for (const file of markdownFiles) {
    addToIndex(index, file.path, vaultPath);
  }

  return index;
}

/**
 * Add a single file to the index (for incremental updates)
 */
export function addToIndex(index: NoteIndex, filePath: string, vaultPath: string): void {
  // Calculate relative path from vault root
  const relativePath = getRelativePath(filePath, vaultPath);

  const baseName = getBaseName(filePath);
  const normalizedName = normalizeName(baseName);

  // Add to allPaths
  index.allPaths.add(filePath);

  // Add to byRelativePath (without .md extension for easier lookup)
  const relativePathNoExt = relativePath.replace(/\.md$/i, '');
  index.byRelativePath.set(relativePathNoExt, filePath);
  index.byRelativePath.set(relativePath, filePath); // Also with extension

  // Add to byName (may have multiple paths for same name)
  const existing = index.byName.get(normalizedName) || [];
  if (!existing.includes(filePath)) {
    existing.push(filePath);
    index.byName.set(normalizedName, existing);
  }
}

/**
 * Remove a file from the index (for incremental updates)
 */
export function removeFromIndex(index: NoteIndex, filePath: string, vaultPath: string): void {
  const relativePath = getRelativePath(filePath, vaultPath);

  const baseName = getBaseName(filePath);
  const normalizedName = normalizeName(baseName);

  // Remove from allPaths
  index.allPaths.delete(filePath);

  // Remove from byRelativePath
  const relativePathNoExt = relativePath.replace(/\.md$/i, '');
  index.byRelativePath.delete(relativePathNoExt);
  index.byRelativePath.delete(relativePath);

  // Remove from byName
  const existing = index.byName.get(normalizedName);
  if (existing) {
    const filtered = existing.filter(p => p !== filePath);
    if (filtered.length === 0) {
      index.byName.delete(normalizedName);
    } else {
      index.byName.set(normalizedName, filtered);
    }
  }
}

/**
 * Update index for a file rename (remove old, add new)
 */
export function renameInIndex(
  index: NoteIndex,
  oldPath: string,
  newPath: string,
  vaultPath: string
): void {
  removeFromIndex(index, oldPath, vaultPath);
  addToIndex(index, newPath, vaultPath);
}

export interface ResolvedWikilink {
  path: string | null;
  exists: boolean;
}

/**
 * Resolve a wikilink target to a file path
 *
 * Resolution priority (Obsidian-compatible):
 * 1. Exact relative path match (if target contains '/')
 * 2. Same folder as current note (shortest path preference)
 * 3. Any note in vault with matching name (case-insensitive)
 * 4. If multiple matches, prefer shortest path
 *
 * @param target - The wikilink target (e.g., "Note Name" or "folder/note")
 * @param currentFilePath - Path to the file containing the wikilink
 * @param index - The note index
 * @param vaultPath - Root path of the vault
 */
export function resolveWikilink(
  target: string,
  currentFilePath: string,
  index: NoteIndex | null,
  vaultPath: string
): ResolvedWikilink {
  if (!index) {
    return { path: null, exists: false };
  }

  // Normalize the target (remove .md if present)
  const normalizedTarget = target.replace(/\.md$/i, '');

  // 1. If target contains '/', treat as relative path
  if (normalizedTarget.includes('/')) {
    // Try exact path match
    const fullPath = index.byRelativePath.get(normalizedTarget);
    if (fullPath) {
      return { path: fullPath, exists: true };
    }
    // Also try with .md extension
    const fullPathWithExt = index.byRelativePath.get(normalizedTarget + '.md');
    if (fullPathWithExt) {
      return { path: fullPathWithExt, exists: true };
    }
    // Path doesn't exist - return proposed path for creation
    return {
      path: `${vaultPath}/${normalizedTarget}.md`,
      exists: false
    };
  }

  // 2. Look up by normalized name
  const normalizedName = normalizeName(normalizedTarget);
  const matches = index.byName.get(normalizedName);

  if (!matches || matches.length === 0) {
    // No matches - return proposed path for creation
    // Default to vault root
    return {
      path: `${vaultPath}/${normalizedTarget}.md`,
      exists: false
    };
  }

  // If only one match, use it
  if (matches.length === 1) {
    return { path: matches[0], exists: true };
  }

  // Multiple matches - apply resolution priority

  // 2a. Prefer note in same folder as current file
  const currentFolder = getParentFolder(currentFilePath);
  const sameFolderMatch = matches.find(p =>
    getParentFolder(p) === currentFolder
  );
  if (sameFolderMatch) {
    return { path: sameFolderMatch, exists: true };
  }

  // 2b. Otherwise prefer shortest path (closest to vault root)
  const sortedByLength = [...matches].sort((a, b) => a.length - b.length);
  return { path: sortedByLength[0], exists: true };
}

// ============================================================================
// Graph Building for Graph View
// ============================================================================

export interface NoteLink {
  from: string;      // source note path
  to: string;        // target note path (resolved) or raw link if unresolved
  toRaw: string;     // original link text
  exists: boolean;   // does target note exist
}

export interface NoteNode {
  id: string;        // note path (unique identifier)
  name: string;      // display name (filename without extension)
  incomingCount: number;
  outgoingCount: number;
}

export interface NoteGraph {
  nodes: NoteNode[];
  links: NoteLink[];
}

// Regex to extract [[wikilinks]] from content - matches [[target]] or [[target|alias]]
// Also handles escaped brackets \[\[ which Milkdown may produce
const WIKILINK_REGEX = /\\?\[\\?\[([^\]|]+)(?:\|[^\]]+)?\\?\]\\?\]/g;

/**
 * Extract all wikilink targets from markdown content
 */
export function extractLinksFromContent(content: string): string[] {
  const links: string[] = [];
  let match;

  // Reset regex state
  WIKILINK_REGEX.lastIndex = 0;

  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    const target = match[1].trim();
    if (target && !links.includes(target)) {
      links.push(target);
    }
  }

  return links;
}

/**
 * Build a graph of all notes and their connections
 *
 * @param vaultPath - Root path of the vault
 * @param noteIndex - The built note index
 * @param readFile - Function to read file content (passed from caller to avoid Tauri dependency)
 */
export async function buildNoteGraph(
  vaultPath: string,
  noteIndex: NoteIndex,
  readFile: (path: string) => Promise<string>
): Promise<NoteGraph> {
  const nodes: Map<string, NoteNode> = new Map();
  const links: NoteLink[] = [];
  const incomingCounts: Map<string, number> = new Map();

  // Initialize all notes as nodes
  for (const path of noteIndex.allPaths) {
    const baseName = getBaseName(path);
    nodes.set(path, {
      id: path,
      name: baseName,
      incomingCount: 0,
      outgoingCount: 0,
    });
  }

  // Process each note to extract links
  for (const sourcePath of noteIndex.allPaths) {
    try {
      const content = await readFile(sourcePath);
      const linkTargets = extractLinksFromContent(content);

      // Update outgoing count
      const sourceNode = nodes.get(sourcePath);
      if (sourceNode) {
        sourceNode.outgoingCount = linkTargets.length;
      }

      // Resolve each link and create edges
      for (const target of linkTargets) {
        const resolved = resolveWikilink(target, sourcePath, noteIndex, vaultPath);

        const link: NoteLink = {
          from: sourcePath,
          to: resolved.path || target,
          toRaw: target,
          exists: resolved.exists,
        };
        links.push(link);

        // Track incoming links
        if (resolved.exists && resolved.path) {
          const currentCount = incomingCounts.get(resolved.path) || 0;
          incomingCounts.set(resolved.path, currentCount + 1);
        }
      }
    } catch (err) {
      // Skip files that can't be read
      console.warn(`Could not read file for graph: ${sourcePath}`, err);
    }
  }

  // Update incoming counts on nodes
  for (const [path, count] of incomingCounts) {
    const node = nodes.get(path);
    if (node) {
      node.incomingCount = count;
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    links,
  };
}

/**
 * Build a local graph showing only connections to/from a specific note
 *
 * @param centerPath - The path of the note to center on
 * @param fullGraph - The full note graph
 * @param depth - How many levels of connections to include (1 = direct only)
 */
export function buildLocalGraph(
  centerPath: string,
  fullGraph: NoteGraph,
  depth: number = 1
): NoteGraph {
  const includedPaths = new Set<string>([centerPath]);
  const includedLinks: NoteLink[] = [];

  // BFS to find nodes within depth
  let currentLevel = new Set<string>([centerPath]);

  for (let d = 0; d < depth; d++) {
    const nextLevel = new Set<string>();

    for (const link of fullGraph.links) {
      // Outgoing links from current level
      if (currentLevel.has(link.from)) {
        if (link.exists) {
          nextLevel.add(link.to);
          includedPaths.add(link.to);
        }
        includedLinks.push(link);
      }
      // Incoming links to current level
      if (currentLevel.has(link.to) && link.exists) {
        nextLevel.add(link.from);
        includedPaths.add(link.from);
        if (!includedLinks.includes(link)) {
          includedLinks.push(link);
        }
      }
    }

    currentLevel = nextLevel;
  }

  // Filter nodes to only included ones
  const filteredNodes = fullGraph.nodes.filter(n => includedPaths.has(n.id));

  return {
    nodes: filteredNodes,
    links: includedLinks,
  };
}
