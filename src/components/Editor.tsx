import { Component, onCleanup, Show, createSignal, createEffect, on } from 'solid-js';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { invoke } from '@tauri-apps/api/core';
import { hashtagPlugin, setHashtagClickHandler } from '../lib/hashtagPlugin';

import '@milkdown/theme-nord/style.css';

interface EditorProps {
  content: string;
  onContentChange: (content: string) => void;
  filePath: string | null;
  vaultPath: string | null;
  onCreateFile?: () => void;
  onHashtagClick?: (tag: string) => void;
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

    // Set up hashtag click handler
    setHashtagClickHandler(props.onHashtagClick || null);

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

  // Watch for file path changes (tab switches)
  createEffect(
    on(
      () => props.filePath,
      async (filePath, prevPath) => {
        console.log('Effect triggered:', {
          filePath,
          prevPath,
          currentPath: currentPath(),
          hasContainerRef: !!containerRef,
          hasEditor: !!editorInstance
        });

        if (filePath && filePath !== currentPath() && containerRef) {
          console.log('Switching to file:', filePath, 'content length:', props.content?.length);
          setCurrentPath(filePath);

          // Always recreate editor on tab switch for reliability
          // Destroy existing instance first
          if (editorInstance) {
            console.log('Destroying old editor');
            await editorInstance.destroy();
            editorInstance = null;
          }

          // Create fresh editor with new content
          console.log('Creating new editor with content:', props.content?.substring(0, 50));
          await createEditor(containerRef, props.content);
          console.log('Editor created successfully');
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
