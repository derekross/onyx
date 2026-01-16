import { Component, onCleanup, Show, createSignal, createEffect, on } from 'solid-js';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { invoke } from '@tauri-apps/api/core';
import { hashtagPlugin, setHashtagClickHandler } from '../lib/hashtagPlugin';
import { wikilinkPlugin, setWikilinkClickHandler, setWikilinkNoteIndex } from '../lib/editor/wikilink-plugin';
import { NoteIndex } from '../lib/editor/note-index';
import { taskPlugin } from '../lib/taskPlugin';

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
  onWikilinkClick?: (target: string) => void;
  noteIndex?: NoteIndex | null;
}

const MilkdownEditor: Component<EditorProps> = (props) => {
  const [saving, setSaving] = createSignal(false);
  const [currentPath, setCurrentPath] = createSignal<string | null>(null);
  let editorInstance: Editor | null = null;
  let containerRef: HTMLDivElement | undefined;

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

    editorInstance = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, container);
        ctx.set(defaultValueCtx, initialContent);
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(hashtagPlugin)
      .use(wikilinkPlugin)
      .use(taskPlugin)
      // Configure listener after the plugin is loaded
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
          props.onContentChange(markdown);
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

          // Always recreate editor on tab switch for reliability
          // Destroy existing instance first
          if (editorInstance) {
            await editorInstance.destroy();
            editorInstance = null;
          }

          // Create fresh editor with new content
          await createEditor(containerRef, props.content);

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

  onCleanup(async () => {
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
