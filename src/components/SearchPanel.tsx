import { Component, createSignal, For, onMount, onCleanup } from 'solid-js';
import { platform } from '@platform';
import type { SearchResult } from '@platform';
import { searchFileContents } from '../lib/editor/note-index';

interface SearchPanelProps {
  vaultPath: string | null;
  fileContents?: Map<string, string>;
  onSelect: (path: string) => void;
  onClose: () => void;
}

const SearchPanel: Component<SearchPanelProps> = (props) => {
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [isSearching, setIsSearching] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let searchTimeout: number | null = null;
  let searchRequestId = 0;

  onMount(() => {
    inputRef?.focus();
  });

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchRequestId++; // discard any in-flight fallback search
  });

  const performSearch = async (searchQuery: string) => {
    if (!props.vaultPath || !searchQuery.trim()) {
      setResults([]);
      return;
    }

    const requestId = ++searchRequestId;

    // Fast path: search the in-memory content cache (zero IPC)
    const contents = props.fileContents;
    if (contents && contents.size > 0) {
      setResults(searchFileContents(contents, searchQuery));
      return;
    }

    // Fallback: cache not loaded yet (e.g. during startup) — use platform search
    setIsSearching(true);
    try {
      const searchResults = await platform.search.searchVault(props.vaultPath, searchQuery);
      if (requestId === searchRequestId) setResults(searchResults);
    } catch (err) {
      console.error('Search failed:', err);
      if (requestId === searchRequestId) setResults([]);
    } finally {
      if (requestId === searchRequestId) setIsSearching(false);
    }
  };

  const handleInput = (value: string) => {
    setQuery(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => {
      performSearch(value);
    }, 300);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Consume Escape so the OS default (e.g. exit native fullscreen on
      // macOS) does not also fire while closing the dialog.
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === 'Enter') {
      performSearch(query());
    }
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="search-panel" onClick={(e) => e.stopPropagation()}>
        <div class="search-header">
          <input
            ref={inputRef}
            type="text"
            class="search-input"
            placeholder="Search in files..."
            value={query()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button class="search-close" onClick={props.onClose}>×</button>
        </div>
        <div class="search-results">
          {isSearching() && <div class="search-loading">Searching...</div>}
          <For each={results()}>
            {(result) => (
              <div class="search-result">
                <div
                  class="search-result-file"
                  onClick={() => props.onSelect(result.path)}
                >
                  {result.name}
                </div>
                <For each={result.matches.slice(0, 3)}>
                  {(match) => (
                    <div
                      class="search-result-match"
                      onClick={() => props.onSelect(result.path)}
                    >
                      <span class="match-line">L{match.line}:</span>
                      <span class="match-content">{match.content}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
          {!isSearching() && query() && results().length === 0 && (
            <div class="search-empty">No results found</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SearchPanel;
