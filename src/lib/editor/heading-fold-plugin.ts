import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet, EditorView } from '@milkdown/prose/view';

export const headingFoldPluginKey = new PluginKey<HeadingFoldState>('headingFold');

// Meta key used to toggle fold state via transactions
const TOGGLE_FOLD_META = 'toggleHeadingFold';

interface HeadingFoldState {
  // Set of folded heading positions (document positions).
  // We track by heading text+level as a stable key since positions shift on edits.
  foldedHeadings: Set<string>;
  decorations: DecorationSet;
}

interface HeadingLocation {
  pos: number;
  endPos: number; // pos + node.nodeSize
  level: number;
  text: string;
  key: string; // stable key: `${level}:${text}`
}

/** Find all headings in the document with their positions. */
function findHeadings(doc: any): HeadingLocation[] {
  const headings: HeadingLocation[] = [];
  // Track occurrence count per level:text to disambiguate duplicate headings
  const occurrences = new Map<string, number>();

  doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'heading' && node.attrs.level) {
      const baseKey = `${node.attrs.level}:${node.textContent}`;
      const count = (occurrences.get(baseKey) || 0) + 1;
      occurrences.set(baseKey, count);

      headings.push({
        pos,
        endPos: pos + node.nodeSize,
        level: node.attrs.level,
        text: node.textContent,
        key: count > 1 ? `${baseKey}#${count}` : baseKey,
      });
    }
  });
  return headings;
}

/**
 * For a given heading at index `idx`, find the range of nodes that should be
 * hidden when folded. This is everything after the heading until the next
 * heading of equal or higher (lower number) level, or end of document.
 */
function getFoldRange(
  headings: HeadingLocation[],
  idx: number,
  doc: any
): { from: number; to: number } | null {
  const heading = headings[idx];
  const from = heading.endPos; // Start hiding after the heading node

  // Find next heading of equal or higher level
  let to = doc.content.size;
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i].level <= heading.level) {
      to = headings[i].pos;
      break;
    }
  }

  // Nothing to fold if there's no content between headings
  if (from >= to) return null;
  return { from, to };
}

/** Create all decorations: chevrons on every heading + hide decorations for folded content. */
function buildDecorations(
  doc: any,
  foldedHeadings: Set<string>
): DecorationSet {
  const headings = findHeadings(doc);
  const decorations: Decoration[] = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const isFolded = foldedHeadings.has(h.key);

    // Check if there's foldable content below this heading
    const foldRange = getFoldRange(headings, i, doc);
    const hasFoldableContent = foldRange !== null;

    // Add chevron widget decoration at the start of the heading
    if (hasFoldableContent) {
      const chevron = document.createElement('span');
      chevron.className = `heading-fold-chevron${isFolded ? ' folded' : ''}`;
      chevron.setAttribute('data-heading-key', h.key);
      chevron.setAttribute('aria-label', isFolded ? 'Expand section' : 'Collapse section');
      chevron.setAttribute('role', 'button');
      chevron.textContent = isFolded ? '\u25B6' : '\u25BC'; // ▶ or ▼
      chevron.contentEditable = 'false';

      // Place inside the heading node (pos + 1 enters the heading's content)
      // with side: -1 to appear before the text content.
      // Include fold state in the key so ProseMirror creates a new DOM element
      // when the state changes (otherwise it reuses the old element).
      decorations.push(
        Decoration.widget(h.pos + 1, chevron, {
          side: -1,
          key: `chevron-${h.key}-${isFolded ? 'f' : 'o'}`,
        })
      );
    }

    // If folded, hide all nodes in the fold range
    if (isFolded && foldRange) {
      // Walk through top-level nodes in the range and add node decorations to hide them
      doc.nodesBetween(foldRange.from, foldRange.to, (node: any, pos: number) => {
        // Only decorate top-level nodes (direct children of doc, depth === 0)
        if (pos >= foldRange.from && pos < foldRange.to) {
          const resolved = doc.resolve(pos);
          if (resolved.depth === 0) {
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: 'heading-folded-content',
              })
            );
            return false; // Don't descend into children
          }
        }
        return true;
      });
    }
  }

  return DecorationSet.create(doc, decorations);
}

export const headingFoldPlugin = $prose(() => {
  return new Plugin({
    key: headingFoldPluginKey,

    state: {
      init(_, { doc }): HeadingFoldState {
        const foldedHeadings = new Set<string>();
        return {
          foldedHeadings,
          decorations: buildDecorations(doc, foldedHeadings),
        };
      },

      apply(tr: Transaction, oldState: HeadingFoldState): HeadingFoldState {
        const toggleKey = tr.getMeta(TOGGLE_FOLD_META) as string | undefined;

        if (toggleKey) {
          // Toggle fold state for the heading
          const newFolded = new Set(oldState.foldedHeadings);
          if (newFolded.has(toggleKey)) {
            newFolded.delete(toggleKey);
          } else {
            newFolded.add(toggleKey);
          }
          return {
            foldedHeadings: newFolded,
            decorations: buildDecorations(tr.doc, newFolded),
          };
        }

        if (tr.docChanged) {
          // Rebuild decorations with current fold state
          return {
            foldedHeadings: oldState.foldedHeadings,
            decorations: buildDecorations(tr.doc, oldState.foldedHeadings),
          };
        }

        // No changes
        return oldState;
      },
    },

    props: {
      decorations(state) {
        const pluginState = this.getState(state);
        return pluginState?.decorations || DecorationSet.empty;
      },

      handleDOMEvents: {
        click(view: EditorView, event: Event) {
          const target = event.target as HTMLElement;
          if (target.classList.contains('heading-fold-chevron')) {
            event.preventDefault();
            event.stopPropagation();
            const key = target.getAttribute('data-heading-key');
            if (key) {
              const tr = view.state.tr.setMeta(TOGGLE_FOLD_META, key);
              view.dispatch(tr);
            }
            return true;
          }
          return false;
        },
      },
    },
  });
});
