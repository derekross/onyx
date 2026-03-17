import { Component, createSignal, createEffect, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface PdfViewerProps {
  path: string;
  vaultPath: string | null;
}

const PdfViewer: Component<PdfViewerProps> = (props) => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [numPages, setNumPages] = createSignal(0);
  const [scale, setScale] = createSignal(1.5);

  let containerRef: HTMLDivElement | undefined;
  let pdfDoc: any = null;
  let cancelled = false;

  const renderAllPages = async (pdf: any, currentScale: number) => {
    if (!containerRef || cancelled) return;
    // Clear existing canvases
    containerRef.innerHTML = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      if (cancelled) return;
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: currentScale });

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      containerRef.appendChild(canvas);

      await page.render({ canvas, viewport }).promise;
    }
  };

  createEffect(() => {
    const filePath = props.path;
    if (!filePath) return;

    cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);

    (async () => {
      try {
        // Read binary file from disk via Tauri
        const data = await invoke<number[]>('read_binary_file', { path: filePath, vaultPath: props.vaultPath });
        if (cancelled) return;

        // Lazy-load PDF.js
        const pdfjsLib = await import('pdfjs-dist');
        if (cancelled) return;

        // Set worker source
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url
        ).toString();

        // Load the PDF document
        const uint8Array = new Uint8Array(data);
        const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        pdfDoc = pdf;
        setNumPages(pdf.numPages);

        // Render all pages
        await renderAllPages(pdf, scale());
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to render PDF:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    onCleanup(() => {
      cancelled = true;
      pdfDoc = null;
    });
  });

  const zoomIn = async () => {
    const newScale = Math.min(scale() + 0.25, 4);
    setScale(newScale);
    if (pdfDoc) await renderAllPages(pdfDoc, newScale);
  };

  const zoomOut = async () => {
    const newScale = Math.max(scale() - 0.25, 0.5);
    setScale(newScale);
    if (pdfDoc) await renderAllPages(pdfDoc, newScale);
  };

  return (
    <div class="pdf-viewer">
      {loading() && (
        <div class="viewer-loading">Loading PDF...</div>
      )}
      {error() && (
        <div class="viewer-error">Failed to load PDF: {error()}</div>
      )}
      <Show when={!loading() && !error() && numPages() > 0}>
        <div class="pdf-toolbar">
          <span class="pdf-page-info">{numPages()} page{numPages() !== 1 ? 's' : ''}</span>
          <div class="pdf-zoom-controls">
            <button class="pdf-zoom-btn" onClick={zoomOut} title="Zoom out">-</button>
            <span class="pdf-zoom-level">{Math.round(scale() * 100)}%</span>
            <button class="pdf-zoom-btn" onClick={zoomIn} title="Zoom in">+</button>
          </div>
        </div>
      </Show>
      <div class="pdf-canvas-container" ref={containerRef} />
    </div>
  );
};

export default PdfViewer;
