import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

// Match %%text%% - Obsidian-style comments
// Comments can contain any text except %%, and can span multiple words
const COMMENT_REGEX = /%%([^%]+)%%/g;

export const commentPluginKey = new PluginKey('comment');

// Find all comments in the document and create decorations
function findComments(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || '';
      let match;

      // Reset regex state
      COMMENT_REGEX.lastIndex = 0;

      while ((match = COMMENT_REGEX.exec(text)) !== null) {
        const fullStart = pos + match.index;
        const fullEnd = fullStart + match[0].length;
        const contentStart = fullStart + 2; // After %%
        const contentEnd = fullEnd - 2;     // Before %%

        // Hide opening %%
        decorations.push(Decoration.inline(fullStart, contentStart, {
          class: 'comment-delimiter',
        }));

        // Style content as comment (muted, italic)
        decorations.push(Decoration.inline(contentStart, contentEnd, {
          class: 'obsidian-comment',
        }));

        // Hide closing %%
        decorations.push(Decoration.inline(contentEnd, fullEnd, {
          class: 'comment-delimiter',
        }));
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

// Create the ProseMirror plugin for comments
export const commentPlugin = $prose(() => {
  return new Plugin({
    key: commentPluginKey,

    state: {
      init(_, { doc }) {
        return findComments(doc);
      },
      apply(tr, oldState) {
        // Only recalculate if the document changed
        if (tr.docChanged) {
          return findComments(tr.doc);
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
