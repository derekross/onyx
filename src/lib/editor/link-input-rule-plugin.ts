/**
 * Link Behavior Plugin
 *
 * Three features:
 * 1. Input Rule: Converts typed [text](url) into a proper link mark in
 *    real-time. When the user types the closing ")" of a markdown link,
 *    this plugin detects the pattern and replaces the raw text with a
 *    linked text node. Cursor lands AFTER the link so it doesn't
 *    immediately trigger expansion.
 *
 * 2. Click Handler: Opens external links on Ctrl/Cmd+click (like Obsidian).
 *
 * 3. Link Reveal: When the cursor enters a rendered link, the link mark
 *    is expanded into raw [text](url) text so both text and URL are
 *    editable. When cursor leaves, it collapses back into a link mark.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet, EditorView } from '@milkdown/prose/view';
import { InputRule, inputRules } from '@milkdown/prose/inputrules';

export const linkInputRulePluginKey = new PluginKey('linkInputRule');
const linkClickPluginKey = new PluginKey('linkClick');
const linkRevealPluginKey = new PluginKey('linkReveal');

// Matches [text](url) at the end of input (for the input rule).
const LINK_INPUT_REGEX = /\[([^\[\]]+)\]\(([^)]+)\)$/;

// Matches [text](url) anywhere (for collapsing expanded links).
const LINK_FULL_REGEX = /\[([^\[\]]+)\]\(([^)]+)\)/;

/**
 * Input rule: converts typed [text](url) to a link mark.
 * Places cursor AFTER the link to avoid triggering immediate expansion.
 */
const linkRule = new InputRule(LINK_INPUT_REGEX, (state, match, start, end) => {
  const linkMark = state.schema.marks.link;
  if (!linkMark) return null;

  const [, text, url] = match;
  if (!text || !url) return null;

  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;

  const mark = linkMark.create({ href: trimmedUrl, title: null });
  const textNode = state.schema.text(text, [mark]);
  // Add a zero-width space after the link so the cursor lands outside the mark
  const spacer = state.schema.text(' ');
  const tr = state.tr.replaceWith(start, end, [textNode, spacer]);
  // Place cursor after the space (outside the link mark)
  tr.setSelection(TextSelection.create(tr.doc, start + text.length + 1));
  return tr;
});

/** Open a URL in the system browser */
function openExternal(url: string) {
  try {
    import('@tauri-apps/plugin-opener').then(({ openUrl }) => {
      openUrl(url);
    }).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** The input rule plugin */
export const linkInputRulePlugin = $prose(() => {
  return inputRules({ rules: [linkRule] }) as unknown as Plugin;
});

/** The click handler plugin: opens links on Ctrl/Cmd+click */
export const linkClickPlugin = $prose(() => {
  return new Plugin({
    key: linkClickPluginKey,
    props: {
      handleClick(_view: EditorView, _pos: number, event: MouseEvent) {
        if (!event.ctrlKey && !event.metaKey) return false;

        const target = event.target as HTMLElement;
        const anchor = target.closest('a');
        if (!anchor) return false;

        const href = anchor.getAttribute('href');
        if (!href) return false;

        if (/^(https?:|mailto:)/.test(href)) {
          event.preventDefault();
          openExternal(href);
          return true;
        }

        return false;
      },
    },
  });
});

// --- Link Reveal Plugin ---

/** Info about a link mark range in the document */
interface LinkRange {
  from: number;
  to: number;
  href: string;
  text: string;
}

/** Info about an expanded (raw text) link in the document */
interface ExpandedLink {
  from: number;
  to: number;
}

/**
 * Find all link mark ranges in the document.
 */
function findLinkRanges(doc: any, linkMarkType: any): LinkRange[] {
  const ranges: LinkRange[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type === linkMarkType) {
        const from = pos;
        const to = pos + node.nodeSize;
        const href = mark.attrs.href || '';
        const text = node.text || '';

        const last = ranges[ranges.length - 1];
        if (last && last.to === from && last.href === href) {
          last.to = to;
          last.text += text;
        } else {
          ranges.push({ from, to, href, text });
        }
      }
    }
  });
  return ranges;
}

/** Find which link range the cursor is inside */
function findCursorLink(ranges: LinkRange[], cursorPos: number): LinkRange | null {
  for (const r of ranges) {
    if (cursorPos >= r.from && cursorPos <= r.to) return r;
  }
  return null;
}

interface LinkRevealState {
  expanded: ExpandedLink | null;
  decorations: DecorationSet;
}

function buildExpandedDecorations(doc: any, expanded: ExpandedLink | null): DecorationSet {
  if (!expanded) return DecorationSet.empty;
  try {
    const deco = Decoration.inline(expanded.from, expanded.to, {
      class: 'link-expanded',
    });
    return DecorationSet.create(doc, [deco]);
  } catch {
    return DecorationSet.empty;
  }
}

/** Link reveal plugin */
export const linkRevealPlugin = $prose(() => {
  let linkMarkType: any = null;

  // Robust guard: tracks whether we are in the middle of an expand/collapse.
  // Using a counter so nested calls (shouldn't happen but safety) work.
  let suppressCount = 0;

  // After an expand, we need to suppress exactly one update cycle
  // to prevent the view.update from seeing a stale state.
  let justExpanded = false;
  let justCollapsed = false;

  return new Plugin({
    key: linkRevealPluginKey,

    state: {
      init(_, { schema }): LinkRevealState {
        linkMarkType = schema.marks.link;
        return { expanded: null, decorations: DecorationSet.empty };
      },

      apply(tr, oldState: LinkRevealState, _oldEditorState, newEditorState): LinkRevealState {
        if (!linkMarkType) return oldState;

        // Check for explicit state updates from expand/collapse
        const meta = tr.getMeta(linkRevealPluginKey);
        if (meta !== undefined) {
          const expanded = meta.expanded as ExpandedLink | null;
          return {
            expanded,
            decorations: buildExpandedDecorations(newEditorState.doc, expanded),
          };
        }

        // Map expanded positions through document changes
        let expanded = oldState.expanded;
        if (expanded && tr.docChanged) {
          const newFrom = tr.mapping.map(expanded.from, 1);
          const newTo = tr.mapping.map(expanded.to, -1);
          if (newFrom < newTo) {
            expanded = { from: newFrom, to: newTo };
          } else {
            expanded = null;
          }
        }

        if (expanded !== oldState.expanded || tr.docChanged) {
          return {
            expanded,
            decorations: buildExpandedDecorations(newEditorState.doc, expanded),
          };
        }

        return oldState;
      },
    },

    props: {
      decorations(state) {
        const pluginState = this.getState(state) as LinkRevealState | undefined;
        return pluginState?.decorations || DecorationSet.empty;
      },
    },

    view() {
      return {
        update(view: EditorView) {
          if (!linkMarkType || suppressCount > 0) return;

          // Skip the update cycle right after expand/collapse to let state settle
          if (justExpanded) {
            justExpanded = false;
            return;
          }
          if (justCollapsed) {
            justCollapsed = false;
            return;
          }

          const state = view.state;
          const pluginState = linkRevealPluginKey.getState(state) as LinkRevealState | undefined;
          if (!pluginState) return;

          const { head } = state.selection;
          const expanded = pluginState.expanded;

          if (expanded) {
            // We have an expanded link — check if cursor left it
            if (head < expanded.from || head > expanded.to) {
              collapseLink(view, expanded);
            }
            return;
          }

          // No expanded link — check if cursor entered a link mark
          const linkRanges = findLinkRanges(state.doc, linkMarkType);
          const activeLink = findCursorLink(linkRanges, head);
          if (activeLink) {
            expandLink(view, activeLink, head);
          }
        },
      };
    },
  });

  function expandLink(view: EditorView, link: LinkRange, cursorPos: number) {
    suppressCount++;
    justExpanded = true;
    try {
      const { state } = view;
      const rawText = `[${link.text}](${link.href})`;
      const textNode = state.schema.text(rawText);

      let tr = state.tr.replaceWith(link.from, link.to, textNode);

      // Also strip any link mark from the newly inserted text
      // (ProseMirror may inherit marks from surrounding context)
      tr = tr.removeMark(link.from, link.from + rawText.length, linkMarkType);

      // Cursor position: offset into link text + 1 for the opening `[`
      const offsetInLinkText = cursorPos - link.from;
      const newCursorPos = Math.min(
        link.from + 1 + offsetInLinkText,
        link.from + rawText.length
      );
      tr = tr.setSelection(TextSelection.create(tr.doc, newCursorPos));

      const expanded: ExpandedLink = {
        from: link.from,
        to: link.from + rawText.length,
      };
      tr = tr.setMeta(linkRevealPluginKey, { expanded });
      // Prevent the markdown listener from re-serializing during this edit
      tr = tr.setMeta('addToHistory', true);

      view.dispatch(tr);
    } finally {
      suppressCount--;
    }
  }

  function collapseLink(view: EditorView, expanded: ExpandedLink) {
    suppressCount++;
    justCollapsed = true;
    try {
      const { state } = view;

      // Clamp positions to doc boundaries
      const from = Math.max(0, expanded.from);
      const to = Math.min(expanded.to, state.doc.content.size);
      if (from >= to) {
        // Range is invalid, just clear the state
        const tr = state.tr.setMeta(linkRevealPluginKey, { expanded: null });
        view.dispatch(tr);
        return;
      }

      const currentText = state.doc.textBetween(from, to);
      const match = LINK_FULL_REGEX.exec(currentText);

      let tr = state.tr;

      if (match && match[1] && match[2]?.trim()) {
        const linkText = match[1];
        const linkUrl = match[2].trim();

        const mark = linkMarkType.create({ href: linkUrl, title: null });
        const textNode = state.schema.text(linkText, [mark]);

        const matchStart = from + match.index;
        const matchEnd = matchStart + match[0].length;
        tr = tr.replaceWith(matchStart, matchEnd, textNode);
      }
      // If no match, the user broke the syntax — leave as plain text

      tr = tr.setMeta(linkRevealPluginKey, { expanded: null });

      // Map the current cursor position through the collapse replacement.
      // The replaceWith shrank the document (e.g., `[link](url)` → `link`),
      // so positions after the replacement shifted upward. We must map
      // state.selection.head through tr.mapping to get the correct position.
      const mappedCursor = tr.mapping.map(state.selection.head);
      const safeCursor = Math.min(mappedCursor, tr.doc.content.size);
      try {
        tr = tr.setSelection(TextSelection.create(tr.doc, safeCursor));
      } catch {
        tr = tr.setSelection(TextSelection.create(tr.doc, 0));
      }

      view.dispatch(tr);
    } finally {
      suppressCount--;
    }
  }
});
