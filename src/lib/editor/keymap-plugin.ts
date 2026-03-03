/**
 * Custom Keymap Plugin for the Milkdown/ProseMirror editor.
 *
 * Fixes and features:
 * 1. Enter inside/after wikilink: moves cursor past ]] before splitting
 * 2. Enter on empty list item: exits the list (lifts the item out)
 * 3. Enter on task list item: creates a new unchecked task item
 * 4. Shift+Enter: inserts a hard break (soft line break) for indented
 *    continuation blocks within list items (like Obsidian)
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { keymap } from '@milkdown/prose/keymap';

export const keymapPluginKey = new PluginKey('custom-keymap');

// Same regex used in wikilink-plugin.ts
const WIKILINK_REGEX = /(?<!!)\[\[([^\]#|^]*)?(?:#([^\]|^]+?))?(?:\^([^\]|]+))?(?:#\^([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Check if the cursor is positioned inside a wikilink (between [[ and ]]).
 * If so, returns the position just after the closing ]].
 * Returns null if cursor is not inside a wikilink.
 */
function getWikilinkEndIfCursorInside(state: any): number | null {
  const { selection, doc } = state;
  if (!selection.empty) return null;

  const pos = selection.from;

  // Get the text node the cursor is in
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;

  // Get the full text of the parent text block and the offset within it
  const parentOffset = $pos.parentOffset;
  const fullText = parent.textContent;

  // Find all wikilinks in this text block
  WIKILINK_REGEX.lastIndex = 0;
  let match;
  while ((match = WIKILINK_REGEX.exec(fullText)) !== null) {
    const linkStart = match.index;
    const linkEnd = linkStart + match[0].length;

    // Check if cursor is inside this wikilink (between [[ and ]])
    if (parentOffset > linkStart && parentOffset < linkEnd) {
      // Cursor is inside the wikilink. Return the absolute position of
      // the character just after the closing ]]
      const blockStart = $pos.start();
      return blockStart + linkEnd;
    }
  }

  return null;
}

/**
 * Find the list_item node at the current cursor position.
 * Returns { node, pos, depth } or null.
 */
function findListItemAtCursor(state: any): { node: any; pos: number; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'list_item') {
      return { node, pos: $from.before(d), depth: d };
    }
  }
  return null;
}

/**
 * Check if a list item is "empty" -- contains only whitespace or nothing.
 */
function isListItemEmpty(node: any): boolean {
  let textContent = '';
  node.descendants((child: any) => {
    if (child.isText) {
      textContent += child.text;
    }
  });
  return textContent.trim().length === 0;
}

/**
 * Check if the current list item is a task list item.
 */
function isTaskListItem(node: any): boolean {
  return node.attrs.checked !== undefined && node.attrs.checked !== null;
}

/**
 * Handle Enter key in the editor.
 */
function handleEnter(state: any, dispatch: any): boolean {
  if (!dispatch) return false;

  const { selection, schema } = state;
  if (!selection.empty) return false;

  // 1. If cursor is inside a wikilink, move it past ]] and then split
  const wikilinkEnd = getWikilinkEndIfCursorInside(state);
  if (wikilinkEnd !== null) {
    const { tr, doc } = state;
    // Move cursor to just after ]]
    const $newPos = doc.resolve(wikilinkEnd);
    tr.setSelection(TextSelection.near($newPos));
    // Now split the block at the new position
    const splitPos = tr.selection.from;
    tr.split(splitPos);
    dispatch(tr.scrollIntoView());
    return true;
  }

  // 2. Handle list item behavior
  const listItem = findListItemAtCursor(state);
  if (listItem) {
    const { node, pos, depth } = listItem;

    // 2a. Empty list item: Exit the list (lift the item out)
    if (isListItemEmpty(node)) {
      const { $from } = selection;
      const listDepth = depth - 1;
      if (listDepth >= 0) {
        const listNode = $from.node(listDepth);
        if (listNode.type.name === 'bullet_list' || listNode.type.name === 'ordered_list') {
          // If this is the only item in the list, replace the list with an empty paragraph
          if (listNode.childCount === 1) {
            const listPos = $from.before(listDepth);
            const { tr } = state;
            tr.replaceWith(listPos, listPos + listNode.nodeSize, schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.near(tr.doc.resolve(listPos + 1)));
            dispatch(tr.scrollIntoView());
            return true;
          }

          // If it's the last item, delete it and place cursor after the list
          const isLast = $from.index(listDepth) === listNode.childCount - 1;
          if (isLast) {
            const { tr } = state;
            tr.delete(pos, pos + node.nodeSize);
            // Insert a paragraph after the list
            const listPos = $from.before(listDepth);
            const updatedList = tr.doc.nodeAt(listPos);
            if (updatedList) {
              const listEnd = listPos + updatedList.nodeSize;
              tr.insert(listEnd, schema.nodes.paragraph.create());
              tr.setSelection(TextSelection.near(tr.doc.resolve(listEnd + 1)));
            }
            dispatch(tr.scrollIntoView());
            return true;
          }

          // Empty item in the middle -- delete it and place cursor at start of next item
          const { tr } = state;
          tr.delete(pos, pos + node.nodeSize);
          tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
          dispatch(tr.scrollIntoView());
          return true;
        }
      }
    }

    // 2b. Non-empty task list item at end of content: create new unchecked task
    if (isTaskListItem(node)) {
      const endOfItem = pos + node.nodeSize;
      const cursorAtEnd = selection.from >= endOfItem - 2;

      if (cursorAtEnd) {
        const { tr } = state;
        const newItem = schema.nodes.list_item.create(
          { checked: false, spread: false },
          schema.nodes.paragraph.create()
        );
        tr.insert(endOfItem, newItem);
        tr.setSelection(TextSelection.near(tr.doc.resolve(endOfItem + 2)));
        dispatch(tr.scrollIntoView());
        return true;
      }
      // Cursor in the middle of task text -- let default split handle it
      return false;
    }

    // 2c. Regular list items: let ProseMirror's default splitListItem handle it
    return false;
  }

  // 3. Everything else: let ProseMirror handle it
  return false;
}

/**
 * Handle Shift+Enter: insert a hard break (soft line break).
 * Creates an indented continuation block within list items,
 * matching Obsidian's Shift+Enter behavior.
 */
function handleShiftEnter(state: any, dispatch: any): boolean {
  if (!dispatch) return false;

  const { schema } = state;

  // Check if hard_break node type exists in the schema
  const hardBreak = schema.nodes.hard_break || schema.nodes.hardbreak;
  if (!hardBreak) return false;

  const { tr } = state;
  const { from, to } = state.selection;

  // Delete any selected content first
  if (from !== to) {
    tr.deleteSelection();
  }

  tr.replaceSelectionWith(hardBreak.create());
  dispatch(tr.scrollIntoView());
  return true;
}

export const keymapPlugin = $prose(() => {
  return keymap({
    'Enter': handleEnter,
    'Shift-Enter': handleShiftEnter,
  }) as unknown as Plugin;
});
