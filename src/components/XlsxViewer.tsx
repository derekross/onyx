import { Component, createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface XlsxViewerProps {
  path: string;
}

interface SheetData {
  name: string;
  headers: string[];
  rows: string[][];
}

const XlsxViewer: Component<XlsxViewerProps> = (props) => {
  const [sheets, setSheets] = createSignal<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const filePath = props.path;
    if (!filePath) return;

    setLoading(true);
    setError(null);
    setSheets([]);
    setActiveSheet(0);

    let cancelled = false;

    (async () => {
      try {
        // Read binary file from disk via Tauri
        const data = await invoke<number[]>('read_binary_file', { path: filePath });
        if (cancelled) return;

        // Lazy-load xlsx
        const XLSX = await import('xlsx');
        if (cancelled) return;

        // Parse workbook
        const arrayBuffer = new Uint8Array(data);
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });

        const parsedSheets: SheetData[] = [];
        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          // Convert to array of arrays
          const jsonData = XLSX.utils.sheet_to_json<string[]>(worksheet, {
            header: 1,
            defval: '',
          });

          if (jsonData.length === 0) {
            parsedSheets.push({ name: sheetName, headers: [], rows: [] });
            continue;
          }

          // First row as headers
          const headers = (jsonData[0] || []).map(String);
          const rows = jsonData.slice(1).map(row => row.map(String));

          parsedSheets.push({ name: sheetName, headers, rows });
        }

        if (cancelled) return;
        setSheets(parsedSheets);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to render XLSX:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    onCleanup(() => { cancelled = true; });
  });

  const currentSheet = () => sheets()[activeSheet()] || null;

  return (
    <div class="xlsx-viewer">
      {loading() && (
        <div class="viewer-loading">Loading spreadsheet...</div>
      )}
      {error() && (
        <div class="viewer-error">Failed to load spreadsheet: {error()}</div>
      )}
      <Show when={!loading() && !error() && sheets().length > 0}>
        {/* Sheet tabs */}
        <Show when={sheets().length > 1}>
          <div class="xlsx-sheet-tabs">
            <For each={sheets()}>
              {(sheet, index) => (
                <button
                  class={`xlsx-sheet-tab ${index() === activeSheet() ? 'active' : ''}`}
                  onClick={() => setActiveSheet(index())}
                >
                  {sheet.name}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Table */}
        <div class="xlsx-table-container">
          <Show when={currentSheet()}>
            <table class="xlsx-table">
              <Show when={currentSheet()!.headers.length > 0}>
                <thead>
                  <tr>
                    <th class="xlsx-row-number">#</th>
                    <For each={currentSheet()!.headers}>
                      {(header) => <th>{header}</th>}
                    </For>
                  </tr>
                </thead>
              </Show>
              <tbody>
                <For each={currentSheet()!.rows}>
                  {(row, rowIndex) => (
                    <tr>
                      <td class="xlsx-row-number">{rowIndex() + 1}</td>
                      <For each={row}>
                        {(cell) => <td>{cell}</td>}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default XlsxViewer;
