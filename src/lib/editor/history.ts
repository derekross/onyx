import { $prose } from '@milkdown/utils';
import { history, undo, redo } from '@milkdown/prose/history';
import { keymap } from '@milkdown/prose/keymap';

// Undo/redo support for the Milkdown editor.
//
// @milkdown/preset-commonmark does not bundle prosemirror-history, so without
// these plugins Ctrl+Z / Cmd+Z does nothing in the live (WYSIWYG) editor.
// We wire up the history state plugin plus the standard keybindings using the
// prosemirror-history / prosemirror-keymap re-exports that ship with
// @milkdown/prose, so no extra dependency is required.
//
// Mod-z      -> undo
// Mod-y      -> redo (Windows/Linux convention)
// Shift-Mod-z -> redo (macOS convention)

export const historyPlugin = $prose(() => history());

export const historyKeymap = $prose(() =>
  keymap({
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
  })
);
