import { Component, createSignal, createEffect, For, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

interface QuickSwitcherProps {
  vaultPath: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
}

const QuickSwitcher: Component<QuickSwitcherProps> = (props) => {
  const [query, setQuery] = createSignal('');
  const [files, setFiles] = createSignal<{ name: string; path: string }[]>([]);
  const [filtered, setFiltered] = createSignal<{ name: string; path: string }[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  // Flatten file tree to get all files
  const flattenFiles = (entries: FileEntry[], result: { name: string; path: string }[] = []) => {
    for (const entry of entries) {
      if (entry.isDirectory && entry.children) {
        flattenFiles(entry.children, result);
      } else if (!entry.isDirectory) {
        result.push({ name: entry.name, path: entry.path });
      }
    }
    return result;
  };

  onMount(async () => {
    if (props.vaultPath) {
      try {
        const entries = await invoke<FileEntry[]>('list_files', { path: props.vaultPath });
        setFiles(flattenFiles(entries));
        setFiltered(flattenFiles(entries));
      } catch (err) {
        console.error('Failed to load files:', err);
      }
    }
    inputRef?.focus();
  });

  // Filter files based on query
  createEffect(() => {
    const q = query().toLowerCase();
    if (!q) {
      setFiltered(files());
    } else {
      setFiltered(
        files().filter(f =>
          f.name.toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q)
        ).sort((a, b) => {
          // Prioritize matches at start of name
          const aStartsWith = a.name.toLowerCase().startsWith(q);
          const bStartsWith = b.name.toLowerCase().startsWith(q);
          if (aStartsWith && !bStartsWith) return -1;
          if (!aStartsWith && bStartsWith) return 1;
          return a.name.localeCompare(b.name);
        })
      );
    }
    setSelectedIndex(0);
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(Math.min(selectedIndex() + 1, filtered().length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(Math.max(selectedIndex() - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filtered()[selectedIndex()];
      if (selected) {
        props.onSelect(selected.path);
      }
    } else if (e.key === 'Escape') {
      props.onClose();
    }
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="quick-switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          class="quick-switcher-input"
          placeholder="Search files..."
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <div class="quick-switcher-results">
          <For each={filtered().slice(0, 20)}>
            {(file, index) => (
              <div
                class={`quick-switcher-item ${index() === selectedIndex() ? 'selected' : ''}`}
                onClick={() => props.onSelect(file.path)}
                onMouseEnter={() => setSelectedIndex(index())}
              >
                <span class="file-name">{file.name}</span>
                <span class="file-path">{file.path.replace(props.vaultPath + '/', '')}</span>
              </div>
            )}
          </For>
          {filtered().length === 0 && (
            <div class="quick-switcher-empty">No files found</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickSwitcher;
