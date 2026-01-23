/**
 * Milkdown Embed Plugin
 *
 * Handles Obsidian-style ![[embed]] syntax using ProseMirror input rules
 * and custom node rendering. This approach is more reliable than remark
 * AST transformation for milkdown.
 */

import { $prose, $nodeSchema, $view, $inputRule } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { InputRule } from '@milkdown/prose/inputrules';
import type { NodeViewConstructor } from '@milkdown/prose/view';
import {
  AssetIndex,
  EmbedFileType,
  getFileType,
  resolveAsset,
} from './asset-index';
import { NoteIndex, resolveWikilink } from './note-index';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';

// Plugin key
export const embedPluginKey = new PluginKey('embed');

// Module-level state
let currentAssetIndex: AssetIndex | null = null;
let currentNoteIndex: NoteIndex | null = null;
let currentVaultPath: string | null = null;
let currentFilePath: string | null = null;

export const setEmbedAssetIndex = (index: AssetIndex | null) => {
  currentAssetIndex = index;
};

export const setEmbedNoteIndex = (index: NoteIndex | null) => {
  currentNoteIndex = index;
};

export const setEmbedVaultPath = (path: string | null) => {
  currentVaultPath = path;
};

export const setEmbedCurrentFilePath = (path: string | null) => {
  currentFilePath = path;
};

/**
 * Parse the size string into width and height
 */
function parseSize(sizeStr: string | undefined): { width: number | null; height: number | null } {
  if (!sizeStr) {
    return { width: null, height: null };
  }
  const trimmed = sizeStr.trim();
  if (trimmed.includes('x')) {
    const parts = trimmed.split('x');
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);
    return {
      width: isNaN(width) ? null : width,
      height: isNaN(height) ? null : height,
    };
  }
  const width = parseInt(trimmed, 10);
  return { width: isNaN(width) ? null : width, height: null };
}

/**
 * Embed node schema
 */
export const embedSchema = $nodeSchema('embed', () => ({
  inline: false,
  group: 'block',
  selectable: true,
  draggable: true,
  atom: true,
  marks: '',
  attrs: {
    target: { default: '' },
    anchor: { default: null },
    width: { default: null },
    height: { default: null },
  },
  parseDOM: [{
    tag: 'div[data-type="embed"]',
    getAttrs: (dom: HTMLElement) => ({
      target: dom.getAttribute('data-target') || '',
      anchor: dom.getAttribute('data-anchor') || null,
      width: dom.getAttribute('data-width') ? parseInt(dom.getAttribute('data-width')!, 10) : null,
      height: dom.getAttribute('data-height') ? parseInt(dom.getAttribute('data-height')!, 10) : null,
    }),
  }],
  toDOM: (node) => ['div', {
    'data-type': 'embed',
    'data-target': node.attrs.target,
    'data-anchor': node.attrs.anchor,
    'data-width': node.attrs.width,
    'data-height': node.attrs.height,
    'class': 'milkdown-embed',
  }],
  parseMarkdown: {
    match: ({ type }) => type === 'embed',
    runner: (state, node, type) => {
      state.addNode(type, {
        target: node.target as string,
        anchor: node.anchor as string | null,
        width: node.width as number | null,
        height: node.height as number | null,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'embed',
    runner: (state, node) => {
      let text = `![[${node.attrs.target}`;
      if (node.attrs.anchor) text += `#${node.attrs.anchor}`;
      if (node.attrs.width) {
        text += `|${node.attrs.width}`;
        if (node.attrs.height) text += `x${node.attrs.height}`;
      }
      text += ']]';
      // Use 'html' node type to avoid markdown escaping of brackets and pipes
      state.addNode('html', undefined, text);
    },
  },
}));

/**
 * Input rule to convert ![[target]] into embed node
 * Matches: ![[target]], ![[target#anchor]], ![[target|size]], ![[target#anchor|size]]
 */
export const embedInputRule = $inputRule(() => {
  // Match ![[...]] at the end of input, capturing the full syntax
  const regex = /!\[\[([^\]#|]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]$/;

  return new InputRule(regex, (state, match, start, end) => {
    const target = match[1].trim();
    const anchor = match[2]?.trim() || null;
    const { width, height } = parseSize(match[3]);

    const embedType = state.schema.nodes.embed;
    if (!embedType) return null;

    const node = embedType.create({ target, anchor, width, height });
    return state.tr.replaceWith(start, end, node);
  });
});

// ============================================================================
// Node View Rendering
// ============================================================================

function getMediaSrc(resolvedPath: string): string {
  return convertFileSrc(resolvedPath);
}

function renderImage(container: HTMLElement, resolvedPath: string, width: number | null, height: number | null): void {
  const img = document.createElement('img');
  img.src = getMediaSrc(resolvedPath);
  img.alt = resolvedPath.split('/').pop() || 'embedded image';
  img.className = 'embed-image';
  if (width) img.style.width = `${width}px`;
  if (height) img.style.height = `${height}px`;
  img.onerror = () => {
    container.innerHTML = '';
    renderBroken(container, resolvedPath, 'image');
  };
  container.appendChild(img);
}

function renderAudio(container: HTMLElement, resolvedPath: string): void {
  const audio = document.createElement('audio');
  audio.src = getMediaSrc(resolvedPath);
  audio.controls = true;
  audio.className = 'embed-audio';
  audio.preload = 'metadata';
  audio.onerror = () => {
    container.innerHTML = '';
    renderBroken(container, resolvedPath, 'audio');
  };
  container.appendChild(audio);
}

function renderVideo(container: HTMLElement, resolvedPath: string, width: number | null, height: number | null): void {
  const video = document.createElement('video');
  video.src = getMediaSrc(resolvedPath);
  video.controls = true;
  video.className = 'embed-video';
  video.preload = 'metadata';
  if (width) video.style.width = `${width}px`;
  if (height) video.style.height = `${height}px`;
  video.onerror = () => {
    container.innerHTML = '';
    renderBroken(container, resolvedPath, 'video');
  };
  container.appendChild(video);
}

function renderPdf(container: HTMLElement, resolvedPath: string, anchor: string | null, height: number | null): void {
  const iframe = document.createElement('iframe');
  let src = getMediaSrc(resolvedPath);

  if (anchor) {
    const pageMatch = anchor.match(/^page=(\d+)$/);
    if (pageMatch) src += `#page=${pageMatch[1]}`;
    if (!height) {
      const heightMatch = anchor.match(/^height=(\d+)$/);
      if (heightMatch) height = parseInt(heightMatch[1], 10);
    }
  }

  iframe.src = src;
  iframe.className = 'embed-pdf';
  iframe.style.width = '100%';
  iframe.style.height = height ? `${height}px` : '500px';
  iframe.style.border = 'none';
  container.appendChild(iframe);
}

async function renderNote(container: HTMLElement, target: string, anchor: string | null): Promise<void> {
  if (!currentNoteIndex || !currentVaultPath) {
    renderBroken(container, target, 'note');
    return;
  }

  const resolved = resolveWikilink(target, currentFilePath || '', currentNoteIndex, currentVaultPath);
  if (!resolved.exists || !resolved.path) {
    renderBroken(container, target, 'note');
    return;
  }

  const loading = document.createElement('div');
  loading.className = 'embed-loading';
  loading.textContent = 'Loading...';
  container.appendChild(loading);

  try {
    const content = await invoke<string>('read_file', { path: resolved.path });
    container.innerHTML = '';

    let displayContent = content;
    if (anchor) {
      displayContent = extractAnchoredContent(content, anchor);
    }

    const noteContainer = document.createElement('div');
    noteContainer.className = 'embed-note';

    const header = document.createElement('div');
    header.className = 'embed-note-header';
    const noteName = resolved.path.split('/').pop()?.replace(/\.md$/i, '') || target;
    header.textContent = anchor ? `${noteName} > ${anchor}` : noteName;
    noteContainer.appendChild(header);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'embed-note-content';
    contentDiv.innerHTML = simpleMarkdownToHtml(displayContent);
    noteContainer.appendChild(contentDiv);

    container.appendChild(noteContainer);
  } catch (err) {
    container.innerHTML = '';
    renderBroken(container, target, 'note');
  }
}

function extractAnchoredContent(content: string, anchor: string): string {
  if (anchor.startsWith('^')) {
    const blockId = anchor.substring(1);
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.includes(`^${blockId}`)) {
        return line.replace(new RegExp(`\\s*\\^${blockId}\\s*$`), '');
      }
    }
    return `Block reference "${anchor}" not found`;
  }

  const headingRegex = new RegExp(`^(#{1,6})\\s+${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi');
  const match = content.match(headingRegex);
  if (!match) return `Heading "${anchor}" not found`;

  const headingLevel = match[1].length;
  const startIndex = match.index! + match[0].length;
  const restContent = content.substring(startIndex);
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
  const nextMatch = restContent.match(nextHeadingRegex);

  return nextMatch?.index !== undefined
    ? restContent.substring(0, nextMatch.index).trim()
    : restContent.trim();
}

function simpleMarkdownToHtml(markdown: string): string {
  return '<p>' + markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>') + '</p>';
}

function renderBroken(container: HTMLElement, target: string, fileType: EmbedFileType): void {
  const broken = document.createElement('div');
  broken.className = 'embed-broken';

  const icon = document.createElement('span');
  icon.className = 'embed-broken-icon';
  icon.innerHTML = getFileTypeIcon(fileType);

  const text = document.createElement('span');
  text.className = 'embed-broken-text';
  text.textContent = `${target} (not found)`;

  broken.appendChild(icon);
  broken.appendChild(text);
  container.appendChild(broken);
}

function getFileTypeIcon(fileType: EmbedFileType): string {
  const icons: Record<EmbedFileType, string> = {
    image: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    audio: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    video: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    pdf: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    note: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    unknown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  return icons[fileType];
}

async function renderEmbed(container: HTMLElement, target: string, anchor: string | null, width: number | null, height: number | null): Promise<void> {
  container.innerHTML = '';
  const fileType = getFileType(target);
  container.dataset.fileType = fileType;

  if (fileType === 'note') {
    await renderNote(container, target, anchor);
    return;
  }

  const resolved = resolveAsset(target, currentFilePath || '', currentAssetIndex, currentVaultPath || '');

  if (!resolved.exists || !resolved.path) {
    renderBroken(container, target, fileType);
    return;
  }

  switch (fileType) {
    case 'image': renderImage(container, resolved.path, width, height); break;
    case 'audio': renderAudio(container, resolved.path); break;
    case 'video': renderVideo(container, resolved.path, width, height); break;
    case 'pdf': renderPdf(container, resolved.path, anchor, height); break;
    default: renderBroken(container, target, fileType);
  }
}

/**
 * Custom node view for embeds
 */
export const embedView = $view(embedSchema.node, (): NodeViewConstructor => {
  return (node) => {
    const dom = document.createElement('div');
    dom.className = 'milkdown-embed';
    dom.contentEditable = 'false';

    const { target, anchor, width, height } = node.attrs;
    renderEmbed(dom, target, anchor, width, height);

    return {
      dom,
      update: (updatedNode) => {
        if (updatedNode.type.name !== 'embed') return false;
        const { target: t, anchor: a, width: w, height: h } = updatedNode.attrs;
        if (t !== target || a !== anchor || w !== width || h !== height) {
          renderEmbed(dom, t, a, w, h);
        }
        return true;
      },
      selectNode: () => dom.classList.add('selected'),
      deselectNode: () => dom.classList.remove('selected'),
      destroy: () => {},
      stopEvent: () => false,
      ignoreMutation: () => true,
    };
  };
});

/**
 * Find and convert all ![[embed]] patterns in a document
 */
function convertEmbedsInDoc(state: any): any | null {
  const tr = state.tr;
  let modified = false;

  // Collect all matches first to avoid position issues
  const allMatches: { start: number; end: number; target: string; anchor: string | null; width: number | null; height: number | null }[] = [];

  state.doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;

    const text = node.text || '';
    const regex = /!\[\[([^\]#|]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const target = match[1].trim();
      const anchor = match[2]?.trim() || null;
      const { width, height } = parseSize(match[3]);
      allMatches.push({
        start: pos + match.index,
        end: pos + match.index + match[0].length,
        target,
        anchor,
        width,
        height,
      });
    }
  });

  // Apply in reverse order to not invalidate positions
  for (let i = allMatches.length - 1; i >= 0; i--) {
    const m = allMatches[i];
    const embedType = state.schema.nodes.embed;
    if (embedType) {
      const embedNode = embedType.create({
        target: m.target,
        anchor: m.anchor,
        width: m.width,
        height: m.height,
      });
      tr.replaceWith(m.start, m.end, embedNode);
      modified = true;
    }
  }

  return modified ? tr : null;
}

/**
 * Prose plugin to handle existing ![[embed]] in document
 * Converts text patterns to embed nodes on document load and changes
 */
export const embedProsePlugin = $prose(() => {
  return new Plugin({
    key: embedPluginKey,

    // Convert embeds on initial view creation
    view(editorView) {
      // Run conversion after a short delay to ensure editor is ready
      setTimeout(() => {
        const tr = convertEmbedsInDoc(editorView.state);
        if (tr) {
          editorView.dispatch(tr);
        }
      }, 0);

      return {};
    },

    // Convert embeds on document changes
    appendTransaction(transactions, _oldState, newState) {
      // Only run on doc changes that aren't from our own conversion
      if (!transactions.some(tr => tr.docChanged && !tr.getMeta(embedPluginKey))) return null;

      const tr = convertEmbedsInDoc(newState);
      if (tr) {
        tr.setMeta(embedPluginKey, true); // Mark to prevent recursion
      }
      return tr;
    },
  });
});
