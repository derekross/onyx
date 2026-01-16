import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

// Match ==text== but not ===text=== (code fence markers)
// Negative lookbehind/lookahead to avoid matching inside longer sequences
const HIGHLIGHT_REGEX = /(?<!=)==(?!=)([^=\n]+)==(?!=)/g;

export const highlightPluginKey = new PluginKey('highlight');

// Find all highlights in the document and create decorations
function findHighlights(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || '';
      let match;

      // Reset regex state
      HIGHLIGHT_REGEX.lastIndex = 0;

      while ((match = HIGHLIGHT_REGEX.exec(text)) !== null) {
        const fullStart = pos + match.index;
        const fullEnd = fullStart + match[0].length;
        const contentStart = fullStart + 2; // After ==
        const contentEnd = fullEnd - 2;     // Before ==

        // Hide opening ==
        decorations.push(Decoration.inline(fullStart, contentStart, {
          class: 'highlight-delimiter',
        }));

        // Style content with yellow background
        decorations.push(Decoration.inline(contentStart, contentEnd, {
          class: 'obsidian-highlight',
        }));

        // Hide closing ==
        decorations.push(Decoration.inline(contentEnd, fullEnd, {
          class: 'highlight-delimiter',
        }));
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

// Create the ProseMirror plugin for highlights
export const highlightPlugin = $prose(() => {
  return new Plugin({
    key: highlightPluginKey,

    state: {
      init(_, { doc }) {
        return findHighlights(doc);
      },
      apply(tr, oldState) {
        // Only recalculate if the document changed
        if (tr.docChanged) {
          return findHighlights(tr.doc);
        }
        return oldState.map(tr.mapping, tr.doc);
      },
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
});
