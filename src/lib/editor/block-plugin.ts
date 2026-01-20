/**
 * Milkdown Block Plugin
 *
 * Extracts block IDs from the document for reference and navigation.
 * Block IDs are text that ends with ^block-id pattern.
 *
 * Examples:
 * - "Some text ^my-block" - block ID is "my-block"
 * - "- List item ^list1" - block ID is "list1"
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';

export interface BlockInfo {
  id: string;         // The block ID (without ^)
  text: string;       // Preview text of the block (first ~50 chars)
  pos: number;        // Document position for navigation
}

export const blockPluginKey = new PluginKey<BlockInfo[]>('blockExtract');

// Regex to match block IDs at the end of a line
// Format: ^alphanumeric-chars at end of text
const BLOCK_ID_REGEX = /\^([a-zA-Z0-9][-a-zA-Z0-9]*)\s*$/;

/**
 * Check if a block ID match is inside a wikilink
 * Returns true if the ^blockid is part of [[^blockid]] or [[Note^blockid]]
 */
function isInsideWikilink(text: string, matchIndex: number): boolean {
  // Look backwards from the match for [[ without a closing ]]
  const textBefore = text.slice(0, matchIndex);
  const lastOpenBracket = textBefore.lastIndexOf('[[');
  if (lastOpenBracket === -1) return false;

  // Check if there's a ]] between [[ and the match
  const textBetween = textBefore.slice(lastOpenBracket);
  return !textBetween.includes(']]');
}

/**
 * Extract block IDs from the document
 */
function extractBlocksFromDoc(doc: any): BlockInfo[] {
  const blocks: BlockInfo[] = [];

  doc.descendants((node: any, pos: number) => {
    // Skip code blocks - block IDs in code should be ignored
    if (node.type.name === 'code_block' || node.type.name === 'fence') {
      return false; // Don't descend into code blocks
    }

    // Only check paragraph/list item nodes for their full text content
    // This gives us context to detect wikilinks properly
    if (node.type.name === 'paragraph' || node.type.name === 'list_item') {
      const textContent = node.textContent || '';
      const match = BLOCK_ID_REGEX.exec(textContent);

      if (match) {
        // Skip if this is inside a wikilink reference
        if (isInsideWikilink(textContent, match.index)) {
          return;
        }

        const blockId = match[1];
        // Avoid duplicates - check if we already have this block
        const exists = blocks.some(b => b.id === blockId);
        if (!exists) {
          const previewText = textContent.slice(0, match.index).trim();
          blocks.push({
            id: blockId,
            text: previewText.slice(0, 50) + (previewText.length > 50 ? '...' : ''),
            pos: pos,
          });
        }
      }
    }
  });

  return blocks;
}

/**
 * ProseMirror plugin for block ID extraction
 */
export const blockPlugin = $prose(() => {
  return new Plugin({
    key: blockPluginKey,
    state: {
      init(_, { doc }) {
        return extractBlocksFromDoc(doc);
      },
      apply(tr, oldState) {
        if (tr.docChanged) {
          return extractBlocksFromDoc(tr.doc);
        }
        return oldState;
      },
    },
  });
});
