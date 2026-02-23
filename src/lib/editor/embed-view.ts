/**
 * Milkdown Embed View
 *
 * Custom node view for rendering Obsidian-style embeds.
 * Supports images, audio, video, PDF, and note transclusion.
 */

import { $view } from '@milkdown/utils';
import { sanitizeUrl } from '../security';
import type { NodeViewConstructor } from '@milkdown/prose/view';
import { embedSchema } from './embed-schema';
import {
  AssetIndex,
  EmbedFileType,
  getFileType,
  resolveAsset,
} from './asset-index';
import { NoteIndex, resolveWikilink } from './note-index';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';

// Module-level state (same pattern as wikilink-plugin.ts)
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
 * Get the asset:// URL for a local file path
 */
function getMediaSrc(resolvedPath: string): string {
  return convertFileSrc(resolvedPath);
}

/**
 * Render an image embed
 */
function renderImage(
  container: HTMLElement,
  resolvedPath: string,
  width: number | null,
  height: number | null
): void {
  const img = document.createElement('img');
  img.src = getMediaSrc(resolvedPath);
  img.alt = resolvedPath.split('/').pop() || 'embedded image';
  img.className = 'embed-image';

  if (width) {
    img.style.width = `${width}px`;
  }
  if (height) {
    img.style.height = `${height}px`;
  }

  img.onerror = () => {
    container.innerHTML = '';
    renderBroken(container, resolvedPath, 'image');
  };

  container.appendChild(img);
}

/**
 * Render an audio embed
 */
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

/**
 * Render a video embed
 */
function renderVideo(
  container: HTMLElement,
  resolvedPath: string,
  width: number | null,
  height: number | null
): void {
  const video = document.createElement('video');
  video.src = getMediaSrc(resolvedPath);
  video.controls = true;
  video.className = 'embed-video';
  video.preload = 'metadata';

  if (width) {
    video.style.width = `${width}px`;
  }
  if (height) {
    video.style.height = `${height}px`;
  }

  video.onerror = () => {
    container.innerHTML = '';
    renderBroken(container, resolvedPath, 'video');
  };

  container.appendChild(video);
}

/**
 * Render a PDF embed
 * anchor can be "page=N" or "height=N"
 */
function renderPdf(
  container: HTMLElement,
  resolvedPath: string,
  anchor: string | null,
  height: number | null
): void {
  const iframe = document.createElement('iframe');
  let src = getMediaSrc(resolvedPath);

  // Parse anchor for page number
  if (anchor) {
    const pageMatch = anchor.match(/^page=(\d+)$/);
    if (pageMatch) {
      src += `#page=${pageMatch[1]}`;
    }
    // Parse height from anchor if not provided
    if (!height) {
      const heightMatch = anchor.match(/^height=(\d+)$/);
      if (heightMatch) {
        height = parseInt(heightMatch[1], 10);
      }
    }
  }

  iframe.src = src;
  iframe.className = 'embed-pdf';
  iframe.style.width = '100%';
  iframe.style.height = height ? `${height}px` : '500px';
  iframe.style.border = 'none';

  iframe.onerror = () => {
    container.innerHTML = '';
    renderBroken(container, resolvedPath, 'pdf');
  };

  container.appendChild(iframe);
}

/**
 * Render a note transclusion
 */
async function renderNote(
  container: HTMLElement,
  target: string,
  anchor: string | null
): Promise<void> {
  if (!currentNoteIndex || !currentVaultPath) {
    renderBroken(container, target, 'note');
    return;
  }

  // Resolve the note path
  const resolved = resolveWikilink(
    target,
    currentFilePath || '',
    currentNoteIndex,
    currentVaultPath
  );

  if (!resolved.exists || !resolved.path) {
    renderBroken(container, target, 'note');
    return;
  }

  // Show loading state
  const loading = document.createElement('div');
  loading.className = 'embed-loading';
  loading.textContent = 'Loading...';
  container.appendChild(loading);

  try {
    // Read the note content
    const content = await invoke<string>('read_file', { path: resolved.path, vaultPath: currentVaultPath });

    container.innerHTML = '';

    // Extract relevant content based on anchor
    let displayContent = content;
    if (anchor) {
      displayContent = extractAnchoredContent(content, anchor);
    }

    // Create note embed container
    const noteContainer = document.createElement('div');
    noteContainer.className = 'embed-note';

    // Add header with note name
    const header = document.createElement('div');
    header.className = 'embed-note-header';
    const noteName = resolved.path.split('/').pop()?.replace(/\.md$/i, '') || target;
    header.textContent = anchor ? `${noteName} > ${anchor}` : noteName;
    noteContainer.appendChild(header);

    // Add content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'embed-note-content';

    // Simple markdown to HTML conversion for display
    // This is a basic implementation - a full markdown parser could be used
    contentDiv.innerHTML = simpleMarkdownToHtml(displayContent);
    noteContainer.appendChild(contentDiv);

    container.appendChild(noteContainer);
  } catch (err) {
    container.innerHTML = '';
    renderBroken(container, target, 'note');
  }
}

/**
 * Extract content under a specific heading or block reference
 */
function extractAnchoredContent(content: string, anchor: string): string {
  // Block reference (^blockid)
  if (anchor.startsWith('^')) {
    const blockId = anchor.substring(1);
    const lines = content.split('\n');

    // Find line with ^blockid at the end
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`^${blockId}`)) {
        // Return the line without the block reference
        return lines[i].replace(new RegExp(`\\s*\\^${blockId}\\s*$`), '');
      }
    }

    return `Block reference "${anchor}" not found`;
  }

  // Heading reference
  const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegex(anchor)}\\s*$`, 'mi');
  const match = content.match(headingRegex);

  if (!match) {
    return `Heading "${anchor}" not found`;
  }

  const headingLevel = match[1].length;
  const startIndex = match.index! + match[0].length;

  // Find the end (next heading of same or higher level)
  const restContent = content.substring(startIndex);
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
  const nextMatch = restContent.match(nextHeadingRegex);

  if (nextMatch && nextMatch.index !== undefined) {
    return restContent.substring(0, nextMatch.index).trim();
  }

  return restContent.trim();
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Very basic markdown to HTML conversion for note transclusion display
 */
function simpleMarkdownToHtml(markdown: string): string {
  let html = markdown
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links (but not wikilinks)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, text: string, url: string) => {
      const safeUrl = sanitizeUrl(url);
      return `<a href="${safeUrl}">${text}</a>`;
    })
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<p>${html}</p>`;
}

/**
 * Render a broken/missing embed
 */
function renderBroken(
  container: HTMLElement,
  target: string,
  fileType: EmbedFileType
): void {
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

/**
 * Get an SVG icon for a file type
 */
function getFileTypeIcon(fileType: EmbedFileType): string {
  switch (fileType) {
    case 'image':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    case 'audio':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    case 'video':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    case 'pdf':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    case 'note':
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    default:
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  }
}

/**
 * Main render function that dispatches to specific renderers
 */
async function renderEmbed(
  container: HTMLElement,
  target: string,
  anchor: string | null,
  width: number | null,
  height: number | null
): Promise<void> {
  container.innerHTML = '';

  const fileType = getFileType(target);
  container.dataset.fileType = fileType;

  // For notes, handle separately
  if (fileType === 'note') {
    await renderNote(container, target, anchor);
    return;
  }

  // Resolve the asset path
  const resolved = resolveAsset(
    target,
    currentFilePath || '',
    currentAssetIndex,
    currentVaultPath || ''
  );

  if (!resolved.exists || !resolved.path) {
    renderBroken(container, target, fileType);
    return;
  }

  switch (fileType) {
    case 'image':
      renderImage(container, resolved.path, width, height);
      break;
    case 'audio':
      renderAudio(container, resolved.path);
      break;
    case 'video':
      renderVideo(container, resolved.path, width, height);
      break;
    case 'pdf':
      renderPdf(container, resolved.path, anchor, height);
      break;
    default:
      renderBroken(container, target, fileType);
  }
}

/**
 * Create the custom node view for embeds
 */
export const embedView = $view(embedSchema.node, (): NodeViewConstructor => {
  return (node, _view, _getPos) => {
    const dom = document.createElement('div');
    dom.className = 'milkdown-embed';
    dom.contentEditable = 'false';

    const { target, anchor, width, height } = node.attrs;

    // Render the embed asynchronously
    renderEmbed(dom, target, anchor, width, height);

    return {
      dom,
      update: (updatedNode) => {
        if (updatedNode.type.name !== 'embed') return false;

        const newTarget = updatedNode.attrs.target;
        const newAnchor = updatedNode.attrs.anchor;
        const newWidth = updatedNode.attrs.width;
        const newHeight = updatedNode.attrs.height;

        // Only re-render if attributes changed
        if (
          newTarget !== target ||
          newAnchor !== anchor ||
          newWidth !== width ||
          newHeight !== height
        ) {
          renderEmbed(dom, newTarget, newAnchor, newWidth, newHeight);
        }

        return true;
      },
      selectNode: () => {
        dom.classList.add('selected');
      },
      deselectNode: () => {
        dom.classList.remove('selected');
      },
      destroy: () => {
        // Cleanup if needed
      },
      stopEvent: () => false,
      ignoreMutation: () => true,
    };
  };
});
