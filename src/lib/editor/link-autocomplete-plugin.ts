/**
 * Milkdown Link Autocomplete Plugin
 *
 * Provides autocomplete suggestions for heading and block references in wikilinks.
 * Triggered when typing [[Note# or [[# for headings, [[Note^ or [[^ for blocks.
 *
 * Uses @floating-ui/dom for precise popup positioning near the cursor.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { headingPluginKey, HeadingInfo } from './heading-plugin';
import { blockPluginKey, BlockInfo } from './block-plugin';

// Plugin key
export const linkAutocompletePluginKey = new PluginKey('linkAutocomplete');

// Types
interface AutocompleteItem {
  id: string;        // Heading text or block ID
  label: string;     // Display text
  detail?: string;   // Secondary text (e.g., H1, H2, block preview)
  type: 'heading' | 'block';
}

interface AutocompleteState {
  isOpen: boolean;
  triggerPos: number;        // Position where [[ started
  anchorPos: number;         // Position where # or ^ was typed
  targetNote: string;        // Note name before # or ^ (empty for same-note)
  mode: 'heading' | 'block' | null;
  query: string;             // Text typed after # or ^
  selectedIndex: number;
  items: AutocompleteItem[];
}

// Module-level state
let currentState: AutocompleteState = {
  isOpen: false,
  triggerPos: -1,
  anchorPos: -1,
  targetNote: '',
  mode: null,
  query: '',
  selectedIndex: 0,
  items: [],
};

let popupElement: HTMLDivElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

// Module-level context - set by Editor.tsx
let currentFileContents: Map<string, string> = new Map();

// Cache for parsed note content
const noteCache = new Map<string, { headings: HeadingInfo[]; blocks: BlockInfo[]; timestamp: number }>();
const CACHE_TTL = 60000; // 1 minute

/**
 * Set the context for autocomplete (vault path and file contents)
 */
export const setAutocompleteContext = (
  _vaultPath: string | null,
  _filePath: string | null,
  fileContents?: Map<string, string>
) => {
  if (fileContents) {
    currentFileContents = fileContents;
  }
};

/**
 * Parse markdown content for headings
 */
function parseHeadings(content: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  let linePos = 0;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    regex.lastIndex = 0;
    match = regex.exec(line);
    if (match) {
      headings.push({
        text: match[2].trim(),
        level: match[1].length,
        id: `heading-${linePos}`,
        pos: linePos,
      });
    }
    linePos += line.length + 1;
  }

  return headings;
}

/**
 * Parse markdown content for block IDs
 */
function parseBlocks(content: string): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  const regex = /^(.+)\s+\^([a-zA-Z0-9][-a-zA-Z0-9]*)\s*$/gm;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const previewText = match[1].trim();
    blocks.push({
      id: match[2],
      text: previewText.slice(0, 50) + (previewText.length > 50 ? '...' : ''),
      pos: match.index,
    });
  }

  return blocks;
}

/**
 * Get basename from a path (handles both / and \ separators)
 */
function getBaseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return (parts[parts.length - 1] || '').replace(/\.md$/i, '');
}

/**
 * Resolve note name to full path by searching fileContents
 */
function resolveNotePath(noteName: string): string | null {
  if (!noteName) return null;

  const lowerNoteName = noteName.toLowerCase();

  // Search through fileContents for a matching note name
  for (const path of currentFileContents.keys()) {
    const baseName = getBaseName(path).toLowerCase();
    if (baseName === lowerNoteName) {
      return path;
    }
  }

  return null;
}

/**
 * Get headings and blocks from a note file using fileContents map
 */
function getNoteContent(noteName: string): { headings: HeadingInfo[]; blocks: BlockInfo[] } {
  const notePath = resolveNotePath(noteName);
  if (!notePath) {
    return { headings: [], blocks: [] };
  }

  // Check cache
  const cached = noteCache.get(notePath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { headings: cached.headings, blocks: cached.blocks };
  }

  // Get content from fileContents map
  const content = currentFileContents.get(notePath);
  if (!content) {
    return { headings: [], blocks: [] };
  }

  const headings = parseHeadings(content);
  const blocks = parseBlocks(content);

  // Update cache
  noteCache.set(notePath, { headings, blocks, timestamp: Date.now() });

  return { headings, blocks };
}

/**
 * Create and position the popup element
 */
function createPopup(): HTMLDivElement {
  if (popupElement) return popupElement;

  popupElement = document.createElement('div');
  popupElement.className = 'link-autocomplete-popup';
  popupElement.style.display = 'none';
  popupElement.style.position = 'fixed';
  popupElement.style.zIndex = '1000';
  document.body.appendChild(popupElement);

  return popupElement;
}

/**
 * Update popup content and position
 */
async function updatePopup(view: EditorView) {
  if (!popupElement) createPopup();
  if (!popupElement) return;

  if (!currentState.isOpen || currentState.items.length === 0) {
    popupElement.style.display = 'none';
    return;
  }

  // Render items
  popupElement.innerHTML = currentState.items
    .map((item, index) => `
      <div class="link-autocomplete-option ${index === currentState.selectedIndex ? 'selected' : ''}" data-index="${index}">
        <span class="${item.type === 'heading' ? 'heading-level' : 'block-id'}">${item.type === 'heading' ? 'H' + (item.detail || '') : '^'}</span>
        <span class="autocomplete-label">${escapeHtml(item.label)}</span>
        ${item.type === 'block' && item.detail ? `<span class="block-preview">${escapeHtml(item.detail)}</span>` : ''}
      </div>
    `)
    .join('');

  // Add click handlers
  popupElement.querySelectorAll('.link-autocomplete-option').forEach((el) => {
    el.addEventListener('click', () => {
      const index = parseInt((el as HTMLElement).dataset.index || '0');
      currentState.selectedIndex = index;
      insertSelectedItem(view);
    });
  });

  popupElement.style.display = 'block';

  // Position using floating-ui
  try {
    const coords = view.coordsAtPos(currentState.anchorPos);
    const virtualEl = {
      getBoundingClientRect: () => ({
        x: coords.left,
        y: coords.top,
        top: coords.top,
        left: coords.left,
        bottom: coords.bottom,
        right: coords.left + 1,
        width: 1,
        height: coords.bottom - coords.top,
      }),
    };

    const { x, y } = await computePosition(virtualEl as any, popupElement, {
      placement: 'bottom-start',
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    });

    popupElement.style.left = `${x}px`;
    popupElement.style.top = `${y}px`;
  } catch (err) {
    console.error('Failed to position autocomplete popup:', err);
  }

  // Scroll selected item into view
  const selectedEl = popupElement.querySelector('.link-autocomplete-option.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Insert the selected item into the editor
 */
function insertSelectedItem(view: EditorView) {
  const item = currentState.items[currentState.selectedIndex];
  if (!item) return;

  const { state } = view;
  const { anchorPos } = currentState;

  // Find the end position (current cursor)
  const cursorPos = state.selection.from;

  // Build the new content: replace from anchor (where # or ^ was typed) to cursor
  // We need to replace the query part only, keeping the # or ^ prefix
  const textBefore = state.doc.textBetween(anchorPos, cursorPos);

  let replaceFrom = anchorPos;
  let replaceText: string;

  // If we're in block mode and typed #^, preserve that
  if (currentState.mode === 'block') {
    if (textBefore.startsWith('#^')) {
      replaceFrom = anchorPos;
      replaceText = `#^${item.id}`;
    } else if (textBefore.startsWith('^')) {
      replaceFrom = anchorPos;
      replaceText = `^${item.id}`;
    } else {
      replaceText = `^${item.id}`;
    }
  } else if (currentState.mode === 'heading') {
    if (textBefore.startsWith('#')) {
      replaceFrom = anchorPos;
      replaceText = `#${item.label}`;
    } else {
      replaceText = `#${item.label}`;
    }
  } else {
    // Fallback - shouldn't happen but ensures replaceText is always assigned
    replaceText = item.label;
  }

  // Create and dispatch the transaction
  const tr = state.tr.replaceWith(
    replaceFrom,
    cursorPos,
    state.schema.text(replaceText)
  );
  view.dispatch(tr);

  // Close the autocomplete
  closeAutocomplete();
}

/**
 * Close the autocomplete popup
 */
function closeAutocomplete() {
  currentState = {
    isOpen: false,
    triggerPos: -1,
    anchorPos: -1,
    targetNote: '',
    mode: null,
    query: '',
    selectedIndex: 0,
    items: [],
  };

  if (popupElement) {
    popupElement.style.display = 'none';
  }
}

/**
 * Set up keyboard navigation
 */
function setupKeyboardHandler(view: EditorView) {
  if (keydownHandler) {
    window.removeEventListener('keydown', keydownHandler, true);
  }

  keydownHandler = (e: KeyboardEvent) => {
    if (!currentState.isOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      currentState.selectedIndex = Math.min(
        currentState.selectedIndex + 1,
        currentState.items.length - 1
      );
      updatePopup(view);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      currentState.selectedIndex = Math.max(currentState.selectedIndex - 1, 0);
      updatePopup(view);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (currentState.items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        insertSelectedItem(view);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAutocomplete();
    }
  };

  window.addEventListener('keydown', keydownHandler, true);
}

/**
 * Check for autocomplete trigger in the editor
 */
async function checkForTrigger(view: EditorView) {
  const { state } = view;
  const { selection } = state;

  // Only trigger on cursor (no selection)
  if (!selection.empty) {
    closeAutocomplete();
    return;
  }

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);
  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, '\n', '\n');
  const textAfter = $pos.parent.textBetween($pos.parentOffset, $pos.parent.content.size, '\n', '\n');

  // Check if we're inside a completed wikilink (]] comes before any [[)
  const closingBracketPos = textAfter.indexOf(']]');
  const openingBracketPos = textAfter.indexOf('[[');
  if (closingBracketPos !== -1 && (openingBracketPos === -1 || closingBracketPos < openingBracketPos)) {
    // We're inside a completed wikilink - don't trigger autocomplete
    if (currentState.isOpen) {
      closeAutocomplete();
    }
    return;
  }

  // Look for unclosed [[ with # or ^
  // Pattern: [[target#query or [[#query for headings
  // Pattern: [[target^query or [[^query or [[target#^query for blocks
  const match = textBefore.match(/\[\[([^\]#^|]*)([#^])(\^)?([^\]|]*)$/);

  if (!match) {
    if (currentState.isOpen) {
      closeAutocomplete();
    }
    return;
  }

  const targetNote = match[1].trim();
  const trigger = match[2]; // # or ^
  const hasCaretAfterHash = match[3] === '^'; // #^ pattern
  const query = match[4];

  // Determine mode
  let mode: 'heading' | 'block';
  if (trigger === '^' || hasCaretAfterHash) {
    mode = 'block';
  } else {
    mode = 'heading';
  }

  // Calculate positions
  const matchStart = textBefore.lastIndexOf('[[');
  const triggerOffset = textBefore.indexOf(trigger, matchStart);
  const absoluteTriggerPos = pos - textBefore.length + matchStart;
  const absoluteAnchorPos = pos - textBefore.length + triggerOffset;

  // Update state
  currentState.isOpen = true;
  currentState.triggerPos = absoluteTriggerPos;
  currentState.anchorPos = absoluteAnchorPos;
  currentState.targetNote = targetNote;
  currentState.mode = mode;
  currentState.query = query.toLowerCase();

  // Get items based on context
  let items: AutocompleteItem[] = [];

  if (!targetNote) {
    // Same-note reference - use current document's headings/blocks
    if (mode === 'heading') {
      const headings = headingPluginKey.getState(view.state) || [];
      items = headings.map(h => ({
        id: h.text,
        label: h.text,
        detail: String(h.level),
        type: 'heading' as const,
      }));
    } else {
      const blocks = blockPluginKey.getState(view.state) || [];
      items = blocks.map(b => ({
        id: b.id,
        label: b.id,
        detail: b.text,
        type: 'block' as const,
      }));
    }
  } else {
    // Other note reference - get content from fileContents map
    const { headings, blocks } = getNoteContent(targetNote);
    if (mode === 'heading') {
      items = headings.map(h => ({
        id: h.text,
        label: h.text,
        detail: String(h.level),
        type: 'heading' as const,
      }));
    } else {
      items = blocks.map(b => ({
        id: b.id,
        label: b.id,
        detail: b.text,
        type: 'block' as const,
      }));
    }
  }

  // Filter by query
  if (currentState.query) {
    items = items.filter(item =>
      item.label.toLowerCase().includes(currentState.query) ||
      item.id.toLowerCase().includes(currentState.query)
    );
  }

  currentState.items = items;
  currentState.selectedIndex = 0;

  // Update popup
  updatePopup(view);

  // Ensure keyboard handler is set up
  setupKeyboardHandler(view);
}

/**
 * Debounced version of checkForTrigger
 */
let checkTimeout: number | null = null;
function debouncedCheck(view: EditorView) {
  if (checkTimeout) {
    clearTimeout(checkTimeout);
  }
  checkTimeout = window.setTimeout(() => {
    checkForTrigger(view);
  }, 50);
}

/**
 * ProseMirror plugin for link autocomplete
 */
export const linkAutocompletePlugin = $prose(() => {
  return new Plugin({
    key: linkAutocompletePluginKey,

    view(_editorView) {
      createPopup();

      return {
        update(view, prevState) {
          // Check for trigger on every update
          if (view.state.selection !== prevState.selection || view.state.doc !== prevState.doc) {
            debouncedCheck(view);
          }
        },
        destroy() {
          closeAutocomplete();
          if (keydownHandler) {
            window.removeEventListener('keydown', keydownHandler, true);
            keydownHandler = null;
          }
          if (popupElement) {
            popupElement.remove();
            popupElement = null;
          }
        },
      };
    },
  });
});
