/**
 * Milkdown Wikilink Plugin
 *
 * Adds support for Obsidian-style [[wikilink]] syntax using decorations.
 * Similar approach to hashtagPlugin.ts - the wikilinks are stored as plain text
 * and styled/clickable via ProseMirror decorations.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { NoteIndex, normalizeName } from './note-index';

// Regex to match wikilinks: [[target]] or [[target|alias]]
// Captures: full match, target, optional alias
const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Plugin key for external access
export const wikilinkPluginKey = new PluginKey('wikilink');

// Click handler type
export type WikilinkClickHandler = (target: string) => void;

// Module-level handlers (same pattern as hashtagPlugin.ts)
let onWikilinkClick: WikilinkClickHandler | null = null;
let currentNoteIndex: NoteIndex | null = null;

export const setWikilinkClickHandler = (handler: WikilinkClickHandler | null) => {
  onWikilinkClick = handler;
};

export const setWikilinkNoteIndex = (index: NoteIndex | null) => {
  currentNoteIndex = index;
};

// Find all wikilinks in the document and create decorations
function findWikilinks(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || '';
      let match;

      // Reset regex state
      WIKILINK_REGEX.lastIndex = 0;

      while ((match = WIKILINK_REGEX.exec(text)) !== null) {
        const start = pos + match.index;
        const end = start + match[0].length;
        const target = match[1].trim();
        const alias = match[2]?.trim();

        // Check if link target exists
        let exists = false;
        if (currentNoteIndex) {
          const normalizedTarget = normalizeName(target);
          exists = currentNoteIndex.allPaths.has(target) ||
                   currentNoteIndex.byName.has(normalizedTarget) ||
                   currentNoteIndex.byRelativePath.has(target) ||
                   currentNoteIndex.byRelativePath.has(target.replace(/\.md$/i, ''));
        }

        // Create a decoration with custom class and data attributes
        const decoration = Decoration.inline(start, end, {
          class: exists ? 'wikilink' : 'wikilink broken',
          'data-target': target,
          'data-alias': alias || '',
        });

        decorations.push(decoration);
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

// Create the ProseMirror plugin for wikilinks
export const wikilinkPlugin = $prose(() => {
  return new Plugin({
    key: wikilinkPluginKey,

    state: {
      init(_, { doc }) {
        return findWikilinks(doc);
      },
      apply(tr, oldState) {
        // Only recalculate if the document changed
        if (tr.docChanged) {
          return findWikilinks(tr.doc);
        }
        return oldState.map(tr.mapping, tr.doc);
      },
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },

      handleClick(view, pos, event) {
        const target = event.target as HTMLElement;

        // Check if clicked element is a wikilink
        if (target.classList.contains('wikilink')) {
          const linkTarget = target.getAttribute('data-target');
          if (linkTarget && onWikilinkClick) {
            event.preventDefault();
            onWikilinkClick(linkTarget);
            return true;
          }
        }

        return false;
      },
    },
  });
});
