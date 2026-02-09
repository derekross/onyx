import { Component, createSignal, createEffect, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface DocxViewerProps {
  path: string;
}

const DocxViewer: Component<DocxViewerProps> = (props) => {
  const [html, setHtml] = createSignal<string>('');
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const filePath = props.path;
    if (!filePath) return;

    setLoading(true);
    setError(null);
    setHtml('');

    let cancelled = false;

    (async () => {
      try {
        // Read binary file from disk via Tauri
        const data = await invoke<number[]>('read_binary_file', { path: filePath });
        if (cancelled) return;

        // Lazy-load mammoth
        const mammoth = await import('mammoth');
        if (cancelled) return;

        // Convert DOCX to HTML
        const arrayBuffer = new Uint8Array(data).buffer;
        const result = await mammoth.convertToHtml(
          { arrayBuffer },
          {
            // Convert embedded images to inline base64
            convertImage: mammoth.images.imgElement((image: { read: (encoding: string) => Promise<string>; contentType: string }) => {
              return image.read('base64').then((imageBuffer: string) => {
                return { src: `data:${image.contentType};base64,${imageBuffer}` };
              });
            }),
          }
        );
        if (cancelled) return;

        setHtml(result.value);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to render DOCX:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    onCleanup(() => { cancelled = true; });
  });

  return (
    <div class="docx-viewer">
      {loading() && (
        <div class="viewer-loading">Loading document...</div>
      )}
      {error() && (
        <div class="viewer-error">Failed to load document: {error()}</div>
      )}
      {!loading() && !error() && (
        <div class="docx-content" innerHTML={html()} />
      )}
    </div>
  );
};

export default DocxViewer;
