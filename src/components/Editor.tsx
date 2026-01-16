import { Component, onCleanup, Show, createSignal, createEffect, on } from 'solid-js';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { TextSelection } from '@milkdown/prose/state';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { readFile, writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { hashtagPlugin, setHashtagClickHandler } from '../lib/hashtagPlugin';
import { wikilinkPlugin, setWikilinkClickHandler, setWikilinkNoteIndex } from '../lib/editor/wikilink-plugin';
import { NoteIndex } from '../lib/editor/note-index';
import { taskPlugin } from '../lib/taskPlugin';
import { headingPlugin, headingPluginKey, HeadingInfo } from '../lib/editor/heading-plugin';
import { blockPlugin, blockPluginKey } from '../lib/editor/block-plugin';
import { linkAutocompletePlugin, setAutocompleteContext } from '../lib/editor/link-autocomplete-plugin';
import {
  embedSchema,
  embedView,
  embedInputRule,
  embedProsePlugin,
  setEmbedAssetIndex,
  setEmbedNoteIndex,
  setEmbedVaultPath,
  setEmbedCurrentFilePath,
} from '../lib/editor/embed-plugin';
import { highlightPlugin } from '../lib/editor/highlight-plugin';
import { commentPlugin } from '../lib/editor/comment-plugin';
import { calloutPlugin } from '../lib/editor/callout-plugin';
import { AssetIndex } from '../lib/editor/asset-index';
import {
  vaultUploadPlugin,
  setUploadVaultPath,
  setOnFilesUploaded,
  joinPath,
  sanitizeFileName,
  getUniqueFileNameInVault,
  ALL_EXTENSIONS,
} from '../lib/editor/upload-config';

import '@milkdown/theme-nord/style.css';

interface EditorProps {
  content: string;
  onContentChange: (content: string) => void;
  filePath: string | null;
  vaultPath: string | null;
  onCreateFile?: () => void;
  onHashtagClick?: (tag: string) => void;
  scrollToLine?: number | null;
  onScrollComplete?: () => void;
  onWikilinkClick?: (target: string, heading?: string | null, blockId?: string | null) => void;
  noteIndex?: NoteIndex | null;
  assetIndex?: AssetIndex | null;
  // File contents map for autocomplete
  fileContents?: Map<string, string>;
  // Heading plugin props
  onHeadingsChange?: (headings: HeadingInfo[]) => void;
  onActiveHeadingChange?: (id: string | null) => void;
  scrollToHeadingId?: string | null;
  // Anchor navigation props (for wikilink heading/block references)
  scrollToHeadingText?: string | null;
  scrollToBlockId?: string | null;
  // Upload callback for when files are dropped/pasted
  onFilesUploaded?: () => void;
}

const MilkdownEditor: Component<EditorProps> = (props) => {
  const [saving, setSaving] = createSignal(false);
  const [currentPath, setCurrentPath] = createSignal<string | null>(null);
  let editorInstance: Editor | null = null;
  let containerRef: HTMLDivElement | undefined;
  let scrollDebounce: number | null = null;
  let scrollHandler: (() => void) | null = null;
  let unlistenDragDrop: UnlistenFn | null = null;

  const saveFile = async () => {
    if (!props.filePath || saving()) return;
    setSaving(true);
    try {
      await invoke('write_file', {
        path: props.filePath,
        content: props.content,
      });
      console.log('File saved:', props.filePath);
    } catch (err) {
      console.error('Failed to save file:', err);
    } finally {
      setSaving(false);
    }
  };

  const createEditor = async (container: HTMLDivElement, initialContent: string) => {
    if (editorInstance) {
      await editorInstance.destroy();
      editorInstance = null;
    }

    // Set up click handlers (same pattern for hashtags and wikilinks)
    setHashtagClickHandler(props.onHashtagClick || null);
    setWikilinkClickHandler(props.onWikilinkClick || null);
    setWikilinkNoteIndex(props.noteIndex || null);

    // Set up embed context
    setEmbedAssetIndex(props.assetIndex || null);
    setEmbedNoteIndex(props.noteIndex || null);
    setEmbedVaultPath(props.vaultPath || null);
    setEmbedCurrentFilePath(props.filePath || null);

    // Set up autocomplete context for heading/block suggestions
    setAutocompleteContext(props.vaultPath || null, props.filePath || null, props.fileContents);

    // Set up upload context for drag-drop and paste
    setUploadVaultPath(props.vaultPath || null);
    setOnFilesUploaded(props.onFilesUploaded || null);

    editorInstance = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, container);
        ctx.set(defaultValueCtx, initialContent);
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(embedSchema)
      .use(embedView)
      .use(embedInputRule)
      .use(embedProsePlugin)
      .use(vaultUploadPlugin) // Custom upload plugin for paste/drop
      .use(listener)
      .use(hashtagPlugin)
      .use(wikilinkPlugin)
      .use(taskPlugin)
      .use(headingPlugin)
      .use(blockPlugin)
      .use(linkAutocompletePlugin)
      .use(highlightPlugin)
      .use(commentPlugin)
      .use(calloutPlugin)
      // Configure listener after the plugin is loaded
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
          props.onContentChange(markdown);

          // Export headings from plugin state
          const view = ctx.get(editorViewCtx);
          const headings = headingPluginKey.getState(view.state);
          props.onHeadingsChange?.(headings || []);
        });
      })
      .create();

    return editorInstance;
  };

  const initEditor = async (container: HTMLDivElement) => {
    containerRef = container;

    // Apply editor settings from localStorage
    const fontFamily = localStorage.getItem('editor_font_family') || 'system-ui, sans-serif';
    const fontSize = localStorage.getItem('editor_font_size') || '16';
    const lineHeight = localStorage.getItem('editor_line_height') || '1.6';
    const spellCheck = localStorage.getItem('spell_check') !== 'false';

    container.style.fontFamily = fontFamily;
    container.style.fontSize = `${fontSize}px`;
    container.style.lineHeight = lineHeight;
    container.setAttribute('spellcheck', spellCheck.toString());

    // Add keyboard listener for save
    container.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
      }
    });

    // Initialize with the content passed in props
    if (props.filePath && props.content !== undefined) {
      setCurrentPath(props.filePath);
      await createEditor(container, props.content);

      // Set up scroll tracking for active heading after editor is created
      if (editorInstance?.ctx) {
        const view = editorInstance.ctx.get(editorViewCtx);

        // Export initial headings
        const initialHeadings = headingPluginKey.getState(view.state) || [];
        props.onHeadingsChange?.(initialHeadings);

        // Create scroll handler for tracking active heading
        scrollHandler = () => {
          if (scrollDebounce) clearTimeout(scrollDebounce);
          scrollDebounce = window.setTimeout(() => {
            if (!editorInstance?.ctx) return;

            const view = editorInstance.ctx.get(editorViewCtx);
            const headings = headingPluginKey.getState(view.state) || [];
            const containerRect = view.dom.getBoundingClientRect();

            for (const heading of headings) {
              try {
                const coords = view.coordsAtPos(heading.pos);
                if (coords.top >= containerRect.top - 50) {
                  props.onActiveHeadingChange?.(heading.id);
                  return;
                }
              } catch (e) {
                // Position may be invalid if doc changed, skip
              }
            }

            const last = headings[headings.length - 1];
            props.onActiveHeadingChange?.(last?.id || null);
          }, 100);
        };

        // Attach scroll listener to the editor content
        view.dom.addEventListener('scroll', scrollHandler, true);
      }

      // Set up Tauri drag-drop listener for file drops from OS
      // Tauri 2.x webview doesn't forward external OS file drops to DOM dataTransfer.files
      // so we use Tauri's native drag-drop event instead
      if (!unlistenDragDrop) {
        unlistenDragDrop = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
          console.log('[DragDrop] Received tauri://drag-drop event:', event.payload.paths);

          if (!props.vaultPath || !editorInstance?.ctx) {
            console.log('[DragDrop] No vault path or editor, skipping');
            return;
          }

          const view = editorInstance.ctx.get(editorViewCtx);

          for (const sourcePath of event.payload.paths) {
            // Check if file type is supported by extension
            const ext = sourcePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase();
            if (!ext || !ALL_EXTENSIONS.includes(ext)) {
              console.log('[DragDrop] Unsupported extension:', ext);
              continue;
            }

            // Extract and sanitize filename
            const rawName = sourcePath.replace(/\\/g, '/').split('/').pop() || `file.${ext}`;
            const fileName = await getUniqueFileNameInVault(props.vaultPath, 'attachments', sanitizeFileName(rawName));

            // Ensure attachments directory exists
            const attachmentsDir = joinPath(props.vaultPath, 'attachments');
            if (!(await exists(attachmentsDir))) {
              console.log('[DragDrop] Creating attachments directory:', attachmentsDir);
              await mkdir(attachmentsDir, { recursive: true });
            }

            try {
              // Read source file and write to attachments
              console.log('[DragDrop] Reading source file:', sourcePath);
              const data = await readFile(sourcePath);
              console.log('[DragDrop] Read', data.length, 'bytes');

              const destPath = joinPath(attachmentsDir, fileName);
              console.log('[DragDrop] Writing to:', destPath);
              await writeFile(destPath, data);

              // Insert embed at cursor position
              const embedType = view.state.schema.nodes.embed;
              if (embedType) {
                const relativePath = `attachments/${fileName}`;
                const node = embedType.create({
                  target: relativePath,
                  anchor: null,
                  width: null,
                  height: null,
                });
                const tr = view.state.tr.replaceSelectionWith(node);
                view.dispatch(tr);
                console.log('[DragDrop] Embed inserted:', relativePath);
              }
            } catch (err) {
              console.error('[DragDrop] Failed to process file:', err);
            }
          }

          // Notify that files were uploaded
          props.onFilesUploaded?.();
        });
      }
    }
  };

  // Helper function to scroll to a line
  const scrollToLineNumber = (line: number) => {
    if (!editorInstance) return;

    try {
      const ctx = editorInstance.ctx;
      if (!ctx) return;

      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;

      // Calculate character position at the start of target line
      const content = props.content || '';
      const lines = content.split('\n');

      let charPos = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
        charPos += lines[i].length + 1; // +1 for newline
      }

      // Find the closest position in the doc
      let targetPos = Math.min(charPos, doc.content.size - 1);

      // Resolve to a valid position
      const resolvedPos = doc.resolve(Math.max(0, targetPos));

      // Find the DOM element at this position and scroll to it
      if (resolvedPos.pos >= 0) {
        const domInfo = view.domAtPos(resolvedPos.pos);

        if (domInfo.node) {
          let element: Element | null = null;
          if (domInfo.node instanceof Element) {
            element = domInfo.node;
          } else if (domInfo.node.parentElement) {
            element = domInfo.node.parentElement;
          }

          // Find the nearest block-level parent
          while (element && !['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'DIV'].includes(element.tagName)) {
            element = element.parentElement;
          }

          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }

      // Clear the scroll target
      props.onScrollComplete?.();
    } catch (err) {
      console.error('Failed to scroll to line:', err);
    }
  };

  // Watch for file path changes (tab switches)
  createEffect(
    on(
      () => props.filePath,
      async (filePath, prevPath) => {
        if (filePath && filePath !== currentPath() && containerRef) {
          setCurrentPath(filePath);

          // Remove old scroll listener before destroying editor
          if (scrollHandler && editorInstance?.ctx) {
            try {
              const view = editorInstance.ctx.get(editorViewCtx);
              view.dom.removeEventListener('scroll', scrollHandler, true);
            } catch (e) {
              // Ignore errors if view is already destroyed
            }
          }

          // Always recreate editor on tab switch for reliability
          // Destroy existing instance first
          if (editorInstance) {
            await editorInstance.destroy();
            editorInstance = null;
          }

          // Create fresh editor with new content
          const editor = await createEditor(containerRef, props.content);

          // Set up scroll tracking for active heading after editor is created
          if (editor?.ctx) {
            const view = editor.ctx.get(editorViewCtx);

            // Export initial headings
            const initialHeadings = headingPluginKey.getState(view.state) || [];
            props.onHeadingsChange?.(initialHeadings);

            // Attach scroll listener
            if (scrollHandler) {
              view.dom.addEventListener('scroll', scrollHandler, true);
            }
          }

          // After editor is ready, scroll to line if specified
          if (props.scrollToLine) {
            // Give the editor a moment to fully render
            setTimeout(() => {
              scrollToLineNumber(props.scrollToLine!);
            }, 100);
          }
        }
      }
    )
  );

  // Handle scroll to line (for when file is already open)
  createEffect(
    on(
      () => props.scrollToLine,
      (line) => {
        // Only handle if we have a line to scroll to and an editor that's ready
        // The filePath effect handles scrolling when opening a new file
        if (line && editorInstance && props.filePath === currentPath()) {
          // Small delay to ensure the view is stable
          setTimeout(() => {
            scrollToLineNumber(line);
          }, 50);
        }
      }
    )
  );

  // Handle scroll to heading (from outline panel click)
  createEffect(
    on(
      () => props.scrollToHeadingId,
      (id) => {
        if (!id || !editorInstance?.ctx) return;

        const view = editorInstance.ctx.get(editorViewCtx);
        const headings = headingPluginKey.getState(view.state) || [];
        const heading = headings.find(h => h.id === id);

        if (heading) {
          try {
            // Use nodeDOM to get the heading element directly (h1-h6)
            const domNode = view.nodeDOM(heading.pos);
            if (domNode instanceof HTMLElement) {
              domNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return;
            }

            // Fallback: use transaction with scrollIntoView
            const { tr } = view.state;
            const $pos = view.state.doc.resolve(heading.pos);
            view.dispatch(tr.setSelection(TextSelection.near($pos)).scrollIntoView());
          } catch (e) {
            console.error('Failed to scroll to heading:', e);
          }
        }
      }
    )
  );

  // Handle scroll to heading by text (from wikilink anchor navigation)
  createEffect(
    on(
      () => props.scrollToHeadingText,
      (headingText) => {
        if (!headingText || !editorInstance?.ctx) return;

        const view = editorInstance.ctx.get(editorViewCtx);
        const headings = headingPluginKey.getState(view.state) || [];
        // Find heading by text (case-insensitive)
        const heading = headings.find(
          h => h.text.toLowerCase() === headingText.toLowerCase()
        );

        if (heading) {
          try {
            const domNode = view.nodeDOM(heading.pos);
            if (domNode instanceof HTMLElement) {
              domNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return;
            }

            const { tr } = view.state;
            const $pos = view.state.doc.resolve(heading.pos);
            view.dispatch(tr.setSelection(TextSelection.near($pos)).scrollIntoView());
          } catch (e) {
            console.error('Failed to scroll to heading:', e);
          }
        }
      }
    )
  );

  // Handle scroll to block (from wikilink anchor navigation)
  createEffect(
    on(
      () => props.scrollToBlockId,
      (blockId) => {
        if (!blockId || !editorInstance?.ctx) return;

        const view = editorInstance.ctx.get(editorViewCtx);
        const blocks = blockPluginKey.getState(view.state) || [];
        const block = blocks.find(b => b.id === blockId);

        if (block) {
          try {
            // Use nodeDOM like heading navigation does
            const domNode = view.nodeDOM(block.pos);
            if (domNode instanceof HTMLElement) {
              domNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return;
            }

            // Fallback to selection-based scrolling
            const { tr } = view.state;
            const $pos = view.state.doc.resolve(block.pos);
            view.dispatch(tr.setSelection(TextSelection.near($pos)).scrollIntoView());
          } catch (e) {
            console.error('Failed to scroll to block:', e);
          }
        }
      }
    )
  );

  onCleanup(async () => {
    // Remove scroll listener
    if (scrollHandler && editorInstance?.ctx) {
      try {
        const view = editorInstance.ctx.get(editorViewCtx);
        view.dom.removeEventListener('scroll', scrollHandler, true);
      } catch (e) {
        // Ignore errors if view is already destroyed
      }
    }
    // Clean up Tauri drag-drop listener
    if (unlistenDragDrop) {
      unlistenDragDrop();
      unlistenDragDrop = null;
    }
    if (scrollDebounce) {
      clearTimeout(scrollDebounce);
    }
    if (editorInstance) {
      await editorInstance.destroy();
      editorInstance = null;
    }
  });

  return (
    <Show
      when={props.filePath}
      fallback={
        <div class="welcome-screen">
          <Show
            when={props.vaultPath}
            fallback={
              <>
                <h1>Onyx</h1>
                <p>Open a vault to get started</p>
              </>
            }
          >
            <h1>Onyx</h1>
            <p>Select a note from the sidebar or create a new one</p>
            <Show when={props.onCreateFile}>
              <button class="welcome-create-btn" onClick={props.onCreateFile}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="12" y1="18" x2="12" y2="12"></line>
                  <line x1="9" y1="15" x2="15" y2="15"></line>
                </svg>
                Create new note
              </button>
            </Show>
          </Show>
        </div>
      }
    >
      <div class="editor-container milkdown-editor" ref={initEditor} />
    </Show>
  );
};

export default MilkdownEditor;
