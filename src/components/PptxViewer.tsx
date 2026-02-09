import { Component, createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import JSZip from 'jszip';

interface PptxViewerProps {
  path: string;
}

interface ShapeElement {
  type: 'text' | 'image';
  x: number;      // percentage of slide width
  y: number;      // percentage of slide height
  width: number;  // percentage of slide width
  height: number; // percentage of slide height
  // Text props
  texts?: { content: string; fontSize: number; color: string; bold: boolean }[];
  // Image props
  imageSrc?: string;
}

interface SlideData {
  number: number;
  backgroundColor: string;
  elements: ShapeElement[];
  slideWidthPt: number; // slide width in points for font scaling
  notes: string[];      // speaker notes paragraphs
}

// EMU to percentage conversion
function emuToPercent(emu: number, total: number): number {
  return (emu / total) * 100;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractNotesText(xml: string): string[] {
  const notes: string[] = [];
  const paraRegex = /<a:p[\s>][\s\S]*?<\/a:p>/g;
  let match;
  while ((match = paraRegex.exec(xml)) !== null) {
    const textRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let tm;
    let para = '';
    while ((tm = textRegex.exec(match[0])) !== null) {
      para += decodeXmlEntities(tm[1]);
    }
    // Skip slide number placeholder and empty lines
    if (para.trim() && para.trim() !== '<number>') {
      notes.push(para.trim());
    }
  }
  return notes;
}

function parseRelsXml(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relRegex = /<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
  let match;
  while ((match = relRegex.exec(xml)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

function parseShapes(xml: string, slideW: number, slideH: number, rIdToImage: Map<string, string>): ShapeElement[] {
  const elements: ShapeElement[] = [];

  // Parse text shapes (<p:sp>)
  const spRegex = /<p:sp>[\s\S]*?<\/p:sp>/g;
  let match;
  while ((match = spRegex.exec(xml)) !== null) {
    const sp = match[0];
    const offMatch = sp.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
    const extMatch = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!offMatch || !extMatch) continue;

    const x = emuToPercent(parseInt(offMatch[1]), slideW);
    const y = emuToPercent(parseInt(offMatch[2]), slideH);
    const width = emuToPercent(parseInt(extMatch[1]), slideW);
    const height = emuToPercent(parseInt(extMatch[2]), slideH);

    // Extract paragraphs with formatting
    const texts: { content: string; fontSize: number; color: string; bold: boolean }[] = [];
    const paraRegex = /<a:p[\s>][\s\S]*?<\/a:p>/g;
    let paraMatch;
    while ((paraMatch = paraRegex.exec(sp)) !== null) {
      const paraXml = paraMatch[0];
      
      // Get run-level properties for this paragraph
      let paraText = '';
      let fontSize = 18; // default
      let color = '';
      let bold = false;

      // Extract all runs with their properties
      const runRegex = /<a:r>([\s\S]*?)<\/a:r>/g;
      let runMatch;
      while ((runMatch = runRegex.exec(paraXml)) !== null) {
        const runXml = runMatch[1];
        const tMatch = runXml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/);
        if (tMatch) {
          paraText += decodeXmlEntities(tMatch[1]);
        }
        // Run properties
        const rPrMatch = runXml.match(/<a:rPr[^>]*>/);
        if (rPrMatch) {
          const szMatch = rPrMatch[0].match(/sz="(\d+)"/);
          if (szMatch) fontSize = parseInt(szMatch[1]) / 100;
          const bMatch = rPrMatch[0].match(/\bb="1"/);
          if (bMatch) bold = true;
        }
        // Font color from run
        const colorMatch = runXml.match(/<a:rPr[\s\S]*?<a:solidFill>[\s\S]*?<a:srgbClr val="([^"]+)"[\s\S]*?<\/a:solidFill>/);
        if (colorMatch) color = '#' + colorMatch[1];
      }

      // Also check for bare <a:t> not in a run
      if (!paraText) {
        const bareTextRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
        let bareMatch;
        while ((bareMatch = bareTextRegex.exec(paraXml)) !== null) {
          paraText += decodeXmlEntities(bareMatch[1]);
        }
      }

      if (paraText.trim()) {
        texts.push({ content: paraText.trim(), fontSize, color, bold });
      }
    }

    if (texts.length > 0) {
      elements.push({ type: 'text', x, y, width, height, texts });
    }
  }

  // Parse picture shapes (<p:pic>)
  const picRegex = /<p:pic>[\s\S]*?<\/p:pic>/g;
  while ((match = picRegex.exec(xml)) !== null) {
    const pic = match[0];
    const offMatch = pic.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
    const extMatch = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    const embedMatch = pic.match(/r:embed="([^"]+)"/);
    if (!offMatch || !extMatch || !embedMatch) continue;

    const imageSrc = rIdToImage.get(embedMatch[1]);
    if (!imageSrc) continue;

    elements.push({
      type: 'image',
      x: emuToPercent(parseInt(offMatch[1]), slideW),
      y: emuToPercent(parseInt(offMatch[2]), slideH),
      width: emuToPercent(parseInt(extMatch[1]), slideW),
      height: emuToPercent(parseInt(extMatch[2]), slideH),
      imageSrc,
    });
  }

  return elements;
}

const SLIDE_ASPECT = 16 / 9; // Standard widescreen

const PptxViewer: Component<PptxViewerProps> = (props) => {
  const [slides, setSlides] = createSignal<SlideData[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const filePath = props.path;
    if (!filePath) return;

    setLoading(true);
    setError(null);
    setSlides([]);

    let cancelled = false;

    (async () => {
      try {
        const data = await invoke<number[]>('read_binary_file', { path: filePath });
        if (cancelled) return;

        const zip = await JSZip.loadAsync(new Uint8Array(data));

        // Get slide dimensions from presentation.xml
        let slideW = 12192000; // default 10" widescreen
        let slideH = 6858000;  // default 7.5"
        const presFile = zip.files['ppt/presentation.xml'];
        if (presFile) {
          const presXml = await presFile.async('text');
          const sizeMatch = presXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
          if (sizeMatch) {
            slideW = parseInt(sizeMatch[1]);
            slideH = parseInt(sizeMatch[2]);
          }
        }

        // Find slide files
        const slideFiles: { num: number; path: string }[] = [];
        zip.forEach((relativePath) => {
          const m = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
          if (m) slideFiles.push({ num: parseInt(m[1], 10), path: relativePath });
        });
        slideFiles.sort((a, b) => a.num - b.num);

        // Pre-load all media images as base64
        const imageMap = new Map<string, string>();
        const mediaFiles = Object.keys(zip.files).filter(p => p.startsWith('ppt/media/'));
        for (const mediaPath of mediaFiles) {
          const blob = await zip.files[mediaPath].async('base64');
          const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
          const mimeMap: Record<string, string> = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp',
          };
          const mime = mimeMap[ext] || 'image/png';
          imageMap.set(mediaPath.split('/').pop() || '', `data:${mime};base64,${blob}`);
        }

        const parsedSlides: SlideData[] = [];

        for (const slideFile of slideFiles) {
          if (cancelled) return;

          // Build rId -> image data URI map and find notes reference
          const relsPath = slideFile.path.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
          const rIdToImage = new Map<string, string>();
          let notesPath: string | null = null;
          const relsFile = zip.files[relsPath];
          if (relsFile) {
            const relsXml = await relsFile.async('text');
            const relsMap = parseRelsXml(relsXml);
            for (const [rId, target] of relsMap) {
              const mediaName = target.split('/').pop() || '';
              if (mediaName && imageMap.has(mediaName)) {
                rIdToImage.set(rId, imageMap.get(mediaName)!);
              }
              // Notes reference: Target="../notesSlides/notesSlide1.xml"
              if (target.includes('notesSlide')) {
                // Resolve relative path: ../notesSlides/X.xml -> ppt/notesSlides/X.xml
                notesPath = 'ppt/notesSlides/' + target.split('/').pop();
              }
            }
          }

          const xml = await zip.files[slideFile.path].async('text');

          // Extract background color
          let backgroundColor = '#ffffff';
          const bgMatch = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/);
          if (bgMatch) {
            const colorMatch = bgMatch[0].match(/<a:srgbClr val="([^"]+)"/);
            if (colorMatch) backgroundColor = '#' + colorMatch[1];
          }

          const elements = parseShapes(xml, slideW, slideH, rIdToImage);

          // Extract speaker notes
          let notes: string[] = [];
          if (notesPath && zip.files[notesPath]) {
            const notesXml = await zip.files[notesPath].async('text');
            notes = extractNotesText(notesXml);
          }

          parsedSlides.push({
            number: slideFile.num,
            backgroundColor,
            elements,
            slideWidthPt: slideW / 12700,
            notes,
          });
        }

        if (cancelled) return;
        if (parsedSlides.length === 0) {
          setError('No slides found in the presentation.');
        }
        setSlides(parsedSlides);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to render PPTX:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    onCleanup(() => { cancelled = true; });
  });

  return (
    <div class="pptx-viewer">
      {loading() && (
        <div class="viewer-loading">Loading presentation...</div>
      )}
      {error() && (
        <div class="viewer-error">Failed to load presentation: {error()}</div>
      )}
      <Show when={!loading() && !error() && slides().length > 0}>
        <div class="pptx-slides">
          <For each={slides()}>
            {(slide) => (
              <div class="pptx-slide-wrapper">
                <div class="pptx-slide-label">Slide {slide.number}</div>
                <div
                  class="pptx-slide-canvas"
                  style={{
                    'background-color': slide.backgroundColor,
                    'padding-bottom': `${(1 / SLIDE_ASPECT) * 100}%`,
                  }}
                >
                  <div class="pptx-slide-inner">
                    <For each={slide.elements}>
                      {(el) => (
                        <div
                          class={`pptx-element pptx-element-${el.type}`}
                          style={{
                            left: `${el.x}%`,
                            top: `${el.y}%`,
                            width: `${el.width}%`,
                            height: `${el.height}%`,
                          }}
                        >
                          {el.type === 'image' && el.imageSrc && (
                            <img src={el.imageSrc} alt="" draggable={false} />
                          )}
                          {el.type === 'text' && el.texts && (
                            <For each={el.texts}>
                              {(t) => (
                                <p
                                  class="pptx-text-line"
                                  style={{
                                    'font-size': `${t.fontSize}px`,
                                    color: t.color || 'inherit',
                                    'font-weight': t.bold ? '700' : '400',
                                  }}
                                >
                                  {t.content}
                                </p>
                              )}
                            </For>
                          )}
                        </div>
                      )}
                    </For>
                  </div>
                </div>
                {slide.notes.length > 0 && (
                  <div class="pptx-slide-notes">
                    <div class="pptx-notes-label">Speaker Notes</div>
                    <For each={slide.notes}>
                      {(note) => <p class="pptx-note-text">{note}</p>}
                    </For>
                  </div>
                )}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default PptxViewer;
