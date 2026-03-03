/**
 * Milkdown Wikilink Plugin
 *
 * Adds support for Obsidian-style [[wikilink]] syntax using decorations.
 * Uses multiple decorations to hide brackets and style the link text.
 *
 * Supports:
 * - [[note]] - Link to note
 * - [[note|alias]] - Link with alias
 * - [[note#heading]] - Link to heading in note
 * - [[note^blockid]] - Link to block in note
 * - [[#heading]] - Link to heading in current note
 * - [[^blockid]] - Link to block in current note
 * - [[note#^blockid]] - Alternative block reference syntax
 *
 * Cursor awareness: When the cursor is inside a wikilink, the [[ and ]]
 * brackets are revealed so the user can edit the full link syntax.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet, EditorView } from '@milkdown/prose/view';
import { NoteIndex, normalizeName } from './note-index';
import { headingPluginKey } from './heading-plugin';
import { blockPluginKey } from './block-plugin';

// Regex to match wikilinks with optional heading/block references
// Uses negative lookbehind (?<!!) to exclude embeds ![[...]]
// Captures: target, heading (after #), blockId (after ^ or #^), alias (after |)
// Examples:
// - [[Note]] → target="Note"
// - [[Note#Heading]] → target="Note", heading="Heading"
// - [[Note^blockid]] → target="Note", blockId="blockid"
// - [[Note#^blockid]] → target="Note", blockId="blockid" (# before ^ is optional)
// - [[#Heading]] → target="", heading="Heading" (same-note)
// - [[^blockid]] → target="", blockId="blockid" (same-note)
// - [[Note#Heading|alias]] → target="Note", heading="Heading", alias="alias"
const WIKILINK_REGEX = /(?<!!)\[\[([^\]#|^]*)?(?:#([^\]|^]+?))?(?:\^([^\]|]+))?(?:#\^([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

// Plugin key for external access
export const wikilinkPluginKey = new PluginKey('wikilink');

// Click handler type - includes optional heading and block ID
export type WikilinkClickHandler = (
  target: string,
  heading?: string | null,
  blockId?: string | null
) => void;

// Module-level handlers (same pattern as hashtagPlugin.ts)
let onWikilinkClick: WikilinkClickHandler | null = null;
let currentNoteIndex: NoteIndex | null = null;

export const setWikilinkClickHandler = (handler: WikilinkClickHandler | null) => {
  onWikilinkClick = handler;
};

export const setWikilinkNoteIndex = (index: NoteIndex | null) => {
  currentNoteIndex = index;
};

/**
 * Navigate to a heading or block within the current document
 * Uses selection-based scrolling which is more reliable than DOM-based
 */
function navigateToAnchor(view: EditorView, heading: string | null, blockId: string | null): boolean {
  if (heading) {
    const headings = headingPluginKey.getState(view.state) || [];
    const targetHeading = headings.find(h => h.text === heading);
    if (targetHeading) {
      try {
        // Use selection-based scrolling - more reliable
        const { tr } = view.state;
        const $pos = view.state.doc.resolve(targetHeading.pos);
        view.dispatch(tr.setSelection(TextSelection.near($pos)).scrollIntoView());
        return true;
      } catch (e) {
        console.error('Failed to scroll to heading:', e);
      }
    }
  }

  if (blockId) {
    const blocks = blockPluginKey.getState(view.state) || [];
    const targetBlock = blocks.find(b => b.id === blockId);

    if (targetBlock) {
      try {
        // Use selection-based scrolling - more reliable
        const { tr } = view.state;
        const $pos = view.state.doc.resolve(targetBlock.pos);
        view.dispatch(tr.setSelection(TextSelection.near($pos)).scrollIntoView());
        return true;
      } catch (e) {
        console.error('Failed to scroll to block:', e);
      }
    }
  }

  return false;
}

/** Wikilink range info for cursor awareness */
interface WikilinkRange {
  fullStart: number;
  fullEnd: number;
}

/**
 * Find all wikilinks in the document and create decorations.
 * When cursorPos is inside a wikilink, that wikilink's brackets are
 * shown (not hidden) so the user can edit the full syntax.
 */
function findWikilinks(doc: any, cursorPos: number | null): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || '';
      let match;

      // Reset regex state
      WIKILINK_REGEX.lastIndex = 0;

      while ((match = WIKILINK_REGEX.exec(text)) !== null) {
        const fullStart = pos + match.index;
        const fullEnd = fullStart + match[0].length;
        // Regex captures: [1]=target, [2]=heading, [3]=blockId (^), [4]=blockId (#^), [5]=alias
        const target = (match[1] || '').trim();
        const heading = match[2]?.trim() || null;
        // Block ID can come from either ^blockid or #^blockid syntax
        const blockId = match[3]?.trim() || match[4]?.trim() || null;
        const alias = match[5]?.trim() || null;

        // Calculate positions for brackets and content
        const openBracketStart = fullStart;
        const openBracketEnd = fullStart + 2; // [[

        // Content is everything between [[ and ]]
        const contentStart = openBracketEnd;
        const contentEnd = fullEnd - 2; // before ]]

        const closeBracketStart = fullEnd - 2;
        const closeBracketEnd = fullEnd; // ]]

        // Check if link target exists (only if target is specified)
        // Same-note references (#heading or ^blockid) are always valid
        let exists = false;
        if (!target) {
          // Same-note reference - always valid
          exists = true;
        } else if (currentNoteIndex) {
          const normalizedTarget = normalizeName(target);
          exists = currentNoteIndex.allPaths.has(target) ||
                   currentNoteIndex.byName.has(normalizedTarget) ||
                   currentNoteIndex.byRelativePath.has(target) ||
                   currentNoteIndex.byRelativePath.has(target.replace(/\.md$/i, ''));
        }

        // Check if cursor is inside this wikilink (between [[ and ]])
        const cursorInside = cursorPos !== null &&
          cursorPos >= openBracketStart && cursorPos <= closeBracketEnd;

        if (cursorInside) {
          // Cursor is inside: show brackets with a subtle style
          decorations.push(Decoration.inline(openBracketStart, openBracketEnd, {
            class: 'wikilink-bracket-visible',
          }));

          // Show the full raw content (target|alias, #heading, etc.) with editing style
          decorations.push(Decoration.inline(contentStart, contentEnd, {
            class: (exists ? 'wikilink' : 'wikilink broken') + ' wikilink-editing',
            'data-target': target,
            'data-heading': heading || '',
            'data-block': blockId || '',
            'data-alias': alias || '',
          }));

          decorations.push(Decoration.inline(closeBracketStart, closeBracketEnd, {
            class: 'wikilink-bracket-visible',
          }));
        } else {
          // Cursor is outside: hide brackets, show styled link
          decorations.push(Decoration.inline(openBracketStart, openBracketEnd, {
            class: 'wikilink-bracket',
          }));

          decorations.push(Decoration.inline(contentStart, contentEnd, {
            class: exists ? 'wikilink' : 'wikilink broken',
            'data-target': target,
            'data-heading': heading || '',
            'data-block': blockId || '',
            'data-alias': alias || '',
          }));

          decorations.push(Decoration.inline(closeBracketStart, closeBracketEnd, {
            class: 'wikilink-bracket',
          }));
        }
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Find all wikilink ranges in the document (for efficient cursor-in-wikilink checks).
 */
function findWikilinkRanges(doc: any): WikilinkRange[] {
  const ranges: WikilinkRange[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || '';
      WIKILINK_REGEX.lastIndex = 0;
      let match;
      while ((match = WIKILINK_REGEX.exec(text)) !== null) {
        const fullStart = pos + match.index;
        const fullEnd = fullStart + match[0].length;
        ranges.push({ fullStart, fullEnd });
      }
    }
  });
  return ranges;
}

/** Find which wikilink range the cursor is inside, or null */
function findCursorWikilink(ranges: WikilinkRange[], cursorPos: number): WikilinkRange | null {
  for (const r of ranges) {
    if (cursorPos >= r.fullStart && cursorPos <= r.fullEnd) return r;
  }
  return null;
}

interface WikilinkPluginState {
  decorations: DecorationSet;
  ranges: WikilinkRange[];
  // The wikilink range the cursor is currently inside (null if outside all)
  activeWikilink: WikilinkRange | null;
}

// Create the ProseMirror plugin for wikilinks
export const wikilinkPlugin = $prose(() => {
  return new Plugin({
    key: wikilinkPluginKey,

    state: {
      init(_, { doc }): WikilinkPluginState {
        const ranges = findWikilinkRanges(doc);
        return {
          decorations: findWikilinks(doc, null),
          ranges,
          activeWikilink: null,
        };
      },
      apply(tr, oldState: WikilinkPluginState): WikilinkPluginState {
        if (tr.docChanged) {
          // Document changed: rebuild everything
          const cursorPos = tr.selection?.head ?? null;
          const ranges = findWikilinkRanges(tr.doc);
          const active = cursorPos !== null ? findCursorWikilink(ranges, cursorPos) : null;
          return {
            decorations: findWikilinks(tr.doc, cursorPos),
            ranges,
            activeWikilink: active,
          };
        }

        // Selection changed without doc change
        const cursorPos = tr.selection?.head ?? null;
        const active = cursorPos !== null ? findCursorWikilink(oldState.ranges, cursorPos) : null;

        // Only rebuild decorations if the active wikilink changed
        const oldActive = oldState.activeWikilink;
        const sameWikilink = active && oldActive &&
          active.fullStart === oldActive.fullStart && active.fullEnd === oldActive.fullEnd;

        if (!sameWikilink && (active !== null || oldActive !== null)) {
          return {
            decorations: findWikilinks(tr.doc, cursorPos),
            ranges: oldState.ranges,
            activeWikilink: active,
          };
        }

        return oldState;
      },
    },

    props: {
      decorations(state) {
        const pluginState = this.getState(state) as WikilinkPluginState | undefined;
        return pluginState?.decorations || DecorationSet.empty;
      },

      // When the user types the closing ]] of a wikilink, automatically
      // insert a space after it so the cursor escapes the decoration
      // and subsequent typing is outside the wikilink.
      handleTextInput(view, from, to, text) {
        // Check if the user just typed ']' and the character before is also ']'
        // and the two characters before that complete a wikilink pattern
        if (text === ']') {
          const { state } = view;
          const pos = from;
          // Need at least 3 chars before: something + ] (we're adding the second ])
          if (pos >= 3) {
            const before = state.doc.textBetween(pos - 1, pos);
            if (before === ']') {
              // Check if this completes a wikilink by looking for [[ before
              // Search backwards for [[
              const start = Math.max(0, pos - 200);
              const textBefore = state.doc.textBetween(start, pos);
              const lastOpen = textBefore.lastIndexOf('[[');
              if (lastOpen >= 0) {
                // This ] completes a ]] that closes a wikilink.
                // Insert the ] and a space, then place cursor after the space.
                const tr = state.tr.insertText('] ', from, to);
                view.dispatch(tr);
                return true;
              }
            }
          }
        }
        return false;
      },

      handleClick(view, _pos, event) {
        const target = event.target as HTMLElement;

        // Check if clicked element is a wikilink
        if (target.classList.contains('wikilink')) {
          const linkTarget = target.getAttribute('data-target') || '';
          const heading = target.getAttribute('data-heading') || null;
          const blockId = target.getAttribute('data-block') || null;

          event.preventDefault();

          // Same-note reference (empty target) - handle directly
          if (!linkTarget && (heading || blockId)) {
            navigateToAnchor(view, heading, blockId);
            return true;
          }

          // Cross-note reference - delegate to handler
          if (onWikilinkClick) {
            onWikilinkClick(linkTarget, heading, blockId);
            return true;
          }
        }

        return false;
      },
    },
  });
});
