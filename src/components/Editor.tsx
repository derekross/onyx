import { Component, onCleanup, Show, createSignal, createEffect, on } from 'solid-js';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { invoke } from '@tauri-apps/api/core';

import '@milkdown/theme-nord/style.css';

interface EditorProps {
  content: string;
  onContentChange: (content: string) => void;
  filePath: string | null;
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

    editorInstance = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, container);
        ctx.set(defaultValueCtx, initialContent);
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(listener)
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
          <h1>Onyx</h1>
          <p>Open a vault to get started</p>
        </div>
      }
    >
      <div class="editor-container milkdown-editor" ref={initEditor} />
    </Show>
  );
};

export default MilkdownEditor;
