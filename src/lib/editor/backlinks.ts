/**
 * Backlinks Extraction Module
 *
 * Provides functionality to find all notes linking to a given note,
 * including both explicit wikilinks and unlinked mentions.
 * Also tracks heading and block references in wikilinks.
 */

import { NoteGraph } from './note-index';

export interface BacklinkInfo {
  sourcePath: string;      // Path to the file containing the mention
  sourceName: string;      // Display name of the source file
  context: string;         // Line/paragraph containing the mention
  lineNumber: number;      // Line number for navigation
  isLinked: boolean;       // true = [[link]], false = plain text mention
  mentionStart: number;    // Character position where mention starts in context
  mentionEnd: number;      // Character position where mention ends in context
  heading?: string;        // Optional heading reference (after #)
  blockId?: string;        // Optional block ID reference (after ^)
}

export interface BacklinksData {
  linked: BacklinkInfo[];    // Explicit wikilink mentions
  unlinked: BacklinkInfo[];  // Plain text mentions of note title
}

/**
 * Extract filename without extension from path
 * Handles both Unix (/) and Windows (\) path separators
 */
function getBaseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return (parts[parts.length - 1] || 'Untitled').replace(/\.md$/i, '');
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize path for comparison (handle Windows vs Unix paths)
 */
function normalizePath(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/');
}

/**
 * Check if a line contains a wikilink to the target (handles escaped brackets)
 */
function lineContainsWikilinkTo(line: string, targetName: string): boolean {
  // Use regex to match wikilinks with optional escaping, heading, block ID, and alias
  // Matches: [[target]], [[target|alias]], [[target#heading]], [[target^block]],
  // [[target#heading|alias]], [[target^block|alias]], etc.
  const escapedTarget = escapeRegex(targetName);
  const wikilinkPattern = new RegExp(
    `\\\\?\\[\\\\?\\[${escapedTarget}(?:#[^\\]|^]*)?(?:\\^[^\\]|]*)?(?:#\\^[^\\]|]*)?(\\|[^\\]]*)?\\\\?\\]\\\\?\\]`,
    'i'
  );
  return wikilinkPattern.test(line);
}

interface LinkContext {
  context: string;
  lineNumber: number;
  mentionStart: number;
  mentionEnd: number;
  heading?: string;
  blockId?: string;
}

/**
 * Find the line containing a wikilink with position info and anchor references
 */
function findLinkContext(content: string, linkTarget: string): LinkContext {
  const lines = content.split('\n');

  // Build regex to match [[target]], [[target#heading]], [[target^block]], [[target|alias]], and escaped versions
  // Also captures heading (after #) and block ID (after ^ or #^)
  // Case-insensitive matching
  const escapedTarget = escapeRegex(linkTarget);
  const wikilinkRegex = new RegExp(
    `(\\\\?\\[\\\\?\\[)(${escapedTarget})(?:#([^\\]|^]+?))?(?:\\^([^\\]|]+))?(?:#\\^([^\\]|]+))?(\\|[^\\]]*)?\\\\?\\]\\\\?\\]`,
    'i'
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = wikilinkRegex.exec(line);

    if (match) {
      const trimmed = line.trim();
      const trimOffset = line.indexOf(trimmed);
      // match[1] is the opening brackets, match[2] is the target
      // match[3] is the heading (after #)
      // match[4] is the block ID (after ^)
      // match[5] is the block ID (after #^)
      const fullMatchStart = match.index;
      const targetStartInMatch = match[1].length;
      const mentionStart = fullMatchStart - trimOffset + targetStartInMatch;
      const mentionEnd = mentionStart + linkTarget.length;

      const heading = match[3]?.trim() || undefined;
      // Block ID can come from either ^blockid or #^blockid syntax
      const blockId = match[4]?.trim() || match[5]?.trim() || undefined;

      return {
        context: trimmed,
        lineNumber: i + 1,
        mentionStart: Math.max(0, mentionStart),
        mentionEnd: Math.min(trimmed.length, mentionEnd),
        heading,
        blockId
      };
    }
  }

  return { context: '', lineNumber: 1, mentionStart: 0, mentionEnd: 0 };
}

/**
 * Extract backlinks for a given note
 *
 * @param targetPath - Full path to the target note
 * @param targetName - Display name of the target note (for unlinked mentions)
 * @param graph - The note graph containing link information
 * @param fileContents - Map of file paths to their content
 */
export function getBacklinksForNote(
  targetPath: string,
  targetName: string,
  graph: NoteGraph,
  fileContents: Map<string, string>
): BacklinksData {
  const linked: BacklinkInfo[] = [];
  const unlinked: BacklinkInfo[] = [];
  const linkedSourceLines = new Map<string, Set<number>>(); // Track which lines have linked mentions

  // Normalize target path for comparison
  const normalizedTargetPath = normalizePath(targetPath);

  // Find linked mentions from graph
  for (const link of graph.links) {
    const normalizedLinkTo = normalizePath(link.to);
    const normalizedLinkFrom = normalizePath(link.from);

    if (normalizedLinkTo === normalizedTargetPath && normalizedLinkFrom !== normalizedTargetPath) {
      const sourceNode = graph.nodes.find(n => normalizePath(n.id) === normalizedLinkFrom);
      const content = fileContents.get(link.from) || '';
      const { context, lineNumber, mentionStart, mentionEnd, heading, blockId } = findLinkContext(content, link.toRaw);

      linked.push({
        sourcePath: link.from,
        sourceName: sourceNode?.name || getBaseName(link.from),
        context,
        lineNumber,
        isLinked: true,
        mentionStart,
        mentionEnd,
        heading,
        blockId
      });

      // Track this source+line as having a linked mention
      if (!linkedSourceLines.has(link.from)) {
        linkedSourceLines.set(link.from, new Set());
      }
      linkedSourceLines.get(link.from)!.add(lineNumber);
    }
  }

  // Find unlinked mentions (plain text containing note title)
  if (targetName.length >= 2) { // Only search for names with at least 2 characters
    const lowerTarget = targetName.toLowerCase();

    for (const [path, content] of fileContents) {
      const normalizedPath = normalizePath(path);
      if (normalizedPath === normalizedTargetPath) continue; // Skip self

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        // Simple case-insensitive search for the target name
        const lowerLine = line.toLowerCase();
        const idx = lowerLine.indexOf(lowerTarget);

        if (idx !== -1) {
          // Skip if this line contains a wikilink to the target
          if (lineContainsWikilinkTo(line, targetName)) {
            continue;
          }
          const sourceNode = graph.nodes.find(n => normalizePath(n.id) === normalizedPath);
          const trimmed = line.trim();
          const trimOffset = line.indexOf(trimmed);
          const mentionStart = idx - trimOffset;
          const mentionEnd = mentionStart + targetName.length;

          unlinked.push({
            sourcePath: path,
            sourceName: sourceNode?.name || getBaseName(path),
            context: trimmed,
            lineNumber,
            isLinked: false,
            mentionStart: Math.max(0, mentionStart),
            mentionEnd: Math.min(trimmed.length, mentionEnd)
          });
        }
      }
    }
  }

  return { linked, unlinked };
}
