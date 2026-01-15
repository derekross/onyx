import { Component, createSignal, For, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface SearchResult {
  path: string;
  name: string;
  matches: { line: number; content: string }[];
}

interface SearchPanelProps {
  vaultPath: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
}

const SearchPanel: Component<SearchPanelProps> = (props) => {
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [isSearching, setIsSearching] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let searchTimeout: number | null = null;

  onMount(() => {
    inputRef?.focus();
  });

  const performSearch = async (searchQuery: string) => {
    if (!props.vaultPath || !searchQuery.trim()) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const searchResults = await invoke<SearchResult[]>('search_files', {
        path: props.vaultPath,
        query: searchQuery,
      });
      setResults(searchResults);
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
    } finally {
      setIsSearching(false);
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
