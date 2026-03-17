import { Component, createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface XlsxViewerProps {
  path: string;
  vaultPath: string | null;
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
        const data = await invoke<number[]>('read_binary_file', { path: filePath, vaultPath: props.vaultPath });
        if (cancelled) return;

        // Lazy-load xlsx and HyperFormula
        const [XLSX, { HyperFormula }] = await Promise.all([
          import('xlsx'),
          import('hyperformula'),
        ]);
        if (cancelled) return;

        // Parse workbook with formulas preserved
        const arrayBuffer = new Uint8Array(data);
        const workbook = XLSX.read(arrayBuffer, { type: 'array', cellFormula: true, sheetStubs: true });

        // Build sheet data for HyperFormula: array of arrays per sheet
        const sheetData: Record<string, (string | number | boolean | null)[][]> = {};
        const sheetNames: string[] = [];

        for (const sheetName of workbook.SheetNames) {
          sheetNames.push(sheetName);
          const worksheet = workbook.Sheets[sheetName];
          const ref = worksheet['!ref'];
          if (!ref) {
            sheetData[sheetName] = [[]];
            continue;
          }

          const range = XLSX.utils.decode_range(ref);
          const rows: (string | number | boolean | null)[][] = [];

          for (let r = range.s.r; r <= range.e.r; r++) {
            const row: (string | number | boolean | null)[] = [];
            for (let c = range.s.c; c <= range.e.c; c++) {
              const cellRef = XLSX.utils.encode_cell({ r, c });
              const cell = worksheet[cellRef];
              if (!cell) {
                row.push(null);
              } else if (cell.f) {
                // Cell has a formula - pass it to HyperFormula for evaluation
                row.push('=' + cell.f);
              } else if (cell.v !== undefined && cell.v !== null) {
                row.push(cell.v);
              } else {
                row.push(null);
              }
            }
            rows.push(row);
          }

          sheetData[sheetName] = rows.length > 0 ? rows : [[]];
        }

        // Build HyperFormula instance with all sheets for cross-sheet references
        const hfSheets: Record<string, (string | number | boolean | null)[][]> = {};
        for (const name of sheetNames) {
          hfSheets[name] = sheetData[name];
        }

        const hf = HyperFormula.buildFromSheets(hfSheets, {
          licenseKey: 'gpl-v3',
        });

        // Extract computed values from HyperFormula
        const parsedSheets: SheetData[] = [];
        for (let si = 0; si < sheetNames.length; si++) {
          const sheetName = sheetNames[si];
          const computed = hf.getSheetSerialized(si);

          if (!computed || computed.length === 0) {
            parsedSheets.push({ name: sheetName, headers: [], rows: [] });
            continue;
          }

          // Use getSheetValues to get the calculated values (not formulas)
          const values = hf.getSheetValues(si);
          const allRows: string[][] = values.map((row: any[]) =>
            row.map((cell: any) => {
              if (cell === null || cell === undefined) return '';
              return String(cell);
            })
          );

          const headers = allRows[0] || [];
          const dataRows = allRows.slice(1);

          parsedSheets.push({ name: sheetName, headers, rows: dataRows });
        }

        hf.destroy();

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
