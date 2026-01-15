import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

// Regex to match hashtags: # followed by word characters (letters, numbers, underscore, hyphen)
// Must not be preceded by a word character (to avoid matching anchors like #heading)
const HASHTAG_REGEX = /(?:^|[^\w])#([\w-]+)/g;

export const hashtagPluginKey = new PluginKey('hashtag');

export type HashtagClickHandler = (tag: string) => void;

// Store for the click handler - will be set from outside
let onHashtagClick: HashtagClickHandler | null = null;

export const setHashtagClickHandler = (handler: HashtagClickHandler | null) => {
  onHashtagClick = handler;
};

// Find all hashtags in the document and create decorations
function findHashtags(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || '';
      let match;

      // Reset regex state
      HASHTAG_REGEX.lastIndex = 0;

      while ((match = HASHTAG_REGEX.exec(text)) !== null) {
        // Calculate the actual start of the hashtag (after any leading character)
        const leadingChar = match[0].startsWith('#') ? 0 : 1;
        const start = pos + match.index + leadingChar;
        const end = start + match[1].length + 1; // +1 for the # symbol
        const tag = match[1];

        // Create a decoration with a custom class
        const decoration = Decoration.inline(start, end, {
          class: 'hashtag',
          'data-tag': tag,
        });

        decorations.push(decoration);
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

// Create the ProseMirror plugin for hashtags
export const hashtagPlugin = $prose(() => {
  return new Plugin({
    key: hashtagPluginKey,

    state: {
      init(_, { doc }) {
        return findHashtags(doc);
      },
      apply(tr, oldState) {
        // Only recalculate if the document changed
        if (tr.docChanged) {
          return findHashtags(tr.doc);
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

        // Check if clicked element is a hashtag
        if (target.classList.contains('hashtag')) {
          const tag = target.getAttribute('data-tag');
          if (tag && onHashtagClick) {
            event.preventDefault();
            onHashtagClick(tag);
            return true;
          }
        }

        return false;
      },
    },
  });
});
