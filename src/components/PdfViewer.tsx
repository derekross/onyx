import { Component, createSignal, createEffect, onCleanup, Show, untrack } from 'solid-js';
import { platform } from '@platform';

interface PdfViewerProps {
  path: string;
  vaultPath: string | null;
}

interface PageSlot {
  el: HTMLDivElement;
  baseWidth: number;
  baseHeight: number;
  canvas: HTMLCanvasElement | null;
  /** Scale the current canvas was rendered at; null means stale/never rendered. */
  renderedScale: number | null;
  /** In-flight pdf.js RenderTask, if any. */
  renderTask: { cancel: () => void; promise: Promise<unknown> } | null;
  /** Scale of the in-flight render task. */
  renderingScale: number | null;
  visible: boolean;
}

const PdfViewer: Component<PdfViewerProps> = (props) => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [numPages, setNumPages] = createSignal(0);
  const [scale, setScale] = createSignal(1.5);

  let containerRef: HTMLDivElement | undefined;
  let pages: any[] = [];
  let slots: PageSlot[] = [];
  let observer: IntersectionObserver | null = null;
  let cancelled = false;

  // Render a single page's canvas at the current scale, guarding against
  // overlapping renders of the same page.
  const renderPage = async (index: number) => {
    const slot = slots[index];
    const page = pages[index];
    if (!slot || !page || cancelled) return;

    const targetScale = untrack(scale);
    // Already up to date
    if (slot.canvas && slot.renderedScale === targetScale) return;
    if (slot.renderTask) {
      // A render at the right scale is already in flight
      if (slot.renderingScale === targetScale) return;
      // Stale in-flight render: cancel it
      slot.renderTask.cancel();
      slot.renderTask = null;
      slot.renderingScale = null;
    }

    const viewport = page.getViewport({ scale: targetScale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    // The placeholder div owns layout size; the canvas just fills it.
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';

    const task = page.render({ canvas, viewport });
    slot.renderTask = task;
    slot.renderingScale = targetScale;

    try {
      await task.promise;
    } catch {
      // RenderingCancelledException (or destroyed doc) — drop this attempt
      if (slot.renderTask === task) {
        slot.renderTask = null;
        slot.renderingScale = null;
      }
      return;
    }

    if (cancelled || slot.renderTask !== task) return;
    slot.renderTask = null;
    slot.renderingScale = null;
    slot.el.replaceChildren(canvas);
    slot.canvas = canvas;
    slot.renderedScale = targetScale;
  };

  // Create a sized placeholder per page and lazily render via IntersectionObserver.
  const setupPages = async (pdf: any, currentScale: number) => {
    if (!containerRef || cancelled) return;
    observer?.disconnect();
    observer = null;
    containerRef.innerHTML = '';
    pages = [];
    slots = [];

    const root = containerRef;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (cancelled) return;
      pages.push(page);

      const base = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'pdf-page-placeholder';
      el.dataset.pageIndex = String(i - 1);
      // Mirror .pdf-page-canvas sizing behavior: explicit width at current scale,
      // capped to the container, height following the page's aspect ratio.
      el.style.width = `${Math.floor(base.width * currentScale)}px`;
      el.style.maxWidth = '100%';
      el.style.aspectRatio = `${base.width} / ${base.height}`;
      el.style.background = 'white';
      el.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)';
      el.style.flexShrink = '0';
      root.appendChild(el);

      slots.push({
        el,
        baseWidth: base.width,
        baseHeight: base.height,
        canvas: null,
        renderedScale: null,
        renderTask: null,
        renderingScale: null,
        visible: false,
      });
    }

    if (cancelled) return;

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
          const slot = slots[idx];
          if (!slot) continue;
          slot.visible = entry.isIntersecting;
          if (entry.isIntersecting) void renderPage(idx);
        }
      },
      { root, rootMargin: '600px 0px 600px 0px' }
    );
    for (const slot of slots) observer.observe(slot.el);
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
        // Read binary file via platform adapter
        const uint8Array = await platform.vault.readBinary(filePath, props.vaultPath ?? '');
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
        const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        setNumPages(pdf.numPages);
        setLoading(false);

        // Build placeholders; the observer renders pages as they near the viewport
        await setupPages(pdf, untrack(scale));
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to render PDF:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    onCleanup(() => {
      cancelled = true;
      observer?.disconnect();
      observer = null;
      for (const slot of slots) {
        slot.renderTask?.cancel();
        slot.renderTask = null;
      }
      slots = [];
      pages = [];
    });
  });

  const applyScale = (newScale: number) => {
    if (newScale === scale()) return;
    setScale(newScale);
    // Resize all placeholders and invalidate rendered canvases. The stale canvas
    // is kept as a stretched preview until the re-render lands.
    for (const slot of slots) {
      slot.el.style.width = `${Math.floor(slot.baseWidth * newScale)}px`;
      if (slot.renderTask) {
        slot.renderTask.cancel();
        slot.renderTask = null;
        slot.renderingScale = null;
      }
      slot.renderedScale = null;
    }
    // Re-render only the pages currently near the viewport; the observer
    // handles the rest as the user scrolls.
    slots.forEach((slot, idx) => {
      if (slot.visible) void renderPage(idx);
    });
  };

  const zoomIn = () => applyScale(Math.min(scale() + 0.25, 4));

  const zoomOut = () => applyScale(Math.max(scale() - 0.25, 0.5));

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
