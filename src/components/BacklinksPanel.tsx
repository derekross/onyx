import { Component, For, Show, createSignal, createMemo } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { NoteGraph } from '../lib/editor/note-index';
import { BacklinksData, getBacklinksForNote, BacklinkInfo } from '../lib/editor/backlinks';

interface BacklinksPanelProps {
  currentFilePath: string | null;
  currentFileName: string | null;
  graph: NoteGraph | null;
  fileContents: Map<string, string>;
  vaultPath: string | null;
  onBacklinkClick: (path: string, line?: number) => void;
  onClose: () => void;
  onLinkMention?: (sourcePath: string, lineNumber: number, mention: string) => Promise<void>;
}

// Helper component for highlighting mention in context (Obsidian-style)
const HighlightedContext: Component<{
  text: string;
  start: number;
  end: number;
}> = (props) => {
  const before = () => props.text.substring(0, Math.max(0, props.start));
  const highlight = () => props.text.substring(props.start, props.end);
  const after = () => props.text.substring(props.end);

  return (
    <span class="backlinks-item-context">
      {before()}
      <span class="backlinks-highlight">{highlight()}</span>
      {after()}
    </span>
  );
};

const BacklinksPanel: Component<BacklinksPanelProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal('');
  const [linkedCollapsed, setLinkedCollapsed] = createSignal(false);
  const [unlinkedCollapsed, setUnlinkedCollapsed] = createSignal(false);
  const [linkingMention, setLinkingMention] = createSignal<string | null>(null);

  // Compute backlinks for current file
  const backlinks = createMemo((): BacklinksData => {
    if (!props.currentFilePath || !props.currentFileName || !props.graph) {
      return { linked: [], unlinked: [] };
    }
    return getBacklinksForNote(
      props.currentFilePath,
      props.currentFileName,
      props.graph,
      props.fileContents
    );
  });

  // Convert an unlinked mention to a wikilink
  const handleLinkMention = async (backlink: BacklinkInfo) => {
    if (!props.currentFileName) return;
    
    const key = `${backlink.sourcePath}:${backlink.lineNumber}`;
    setLinkingMention(key);
    
    try {
      // Read the source file
      const content = await invoke<string>('read_file', { path: backlink.sourcePath, vaultPath: props.vaultPath });
      const lines = content.split('\n');
      const lineIndex = backlink.lineNumber - 1;
      
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const line = lines[lineIndex];
        
        // Find the mention in the line (case-insensitive)
        const lowerLine = line.toLowerCase();
        const lowerTarget = props.currentFileName.toLowerCase();
        const idx = lowerLine.indexOf(lowerTarget);
        
        if (idx !== -1) {
          // Get the actual text (preserving original case)
          const actualMention = line.substring(idx, idx + props.currentFileName.length);
          
          // Replace with wikilink
          const newLine = line.substring(0, idx) + `[[${actualMention}]]` + line.substring(idx + actualMention.length);
          lines[lineIndex] = newLine;
          
          // Write the file back
          const newContent = lines.join('\n');
          await invoke('write_file', { path: backlink.sourcePath, content: newContent, vaultPath: props.vaultPath });
          
          // Update fileContents to reflect the change (will trigger re-render)
          if (props.onLinkMention) {
            await props.onLinkMention(backlink.sourcePath, backlink.lineNumber, actualMention);
          }
        }
      }
    } catch (err) {
      console.error('Failed to link mention:', err);
    } finally {
      setLinkingMention(null);
    }
  };

  // Filter by search query
  const filteredBacklinks = createMemo(() => {
    const q = searchQuery().toLowerCase();
    const data = backlinks();
    if (!q) return data;
    return {
      linked: data.linked.filter(b =>
        b.sourceName.toLowerCase().includes(q) ||
        b.context.toLowerCase().includes(q)
      ),
      unlinked: data.unlinked.filter(b =>
        b.sourceName.toLowerCase().includes(q) ||
        b.context.toLowerCase().includes(q)
      )
    };
  });

  return (
    <div class="backlinks-panel">
      <div class="backlinks-header">
        <span class="backlinks-header-title">Backlinks</span>
        <button class="backlinks-close" onClick={props.onClose} title="Close">×</button>
      </div>

      <div class="backlinks-search">
        <input
          type="text"
          placeholder="Filter backlinks..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </div>

      <div class="backlinks-content">
        <Show when={props.graph} fallback={<div class="backlinks-empty">Loading...</div>}>
          {/* Linked Mentions Section */}
          <div class="backlinks-section">
            <div
              class="backlinks-section-header"
              onClick={() => setLinkedCollapsed(!linkedCollapsed())}
            >
              <span class={`backlinks-chevron ${linkedCollapsed() ? 'collapsed' : ''}`}>▼</span>
              <span>Linked mentions</span>
              <span class="backlinks-count">({filteredBacklinks().linked.length})</span>
            </div>
            <Show when={!linkedCollapsed()}>
              <Show
                when={filteredBacklinks().linked.length > 0}
                fallback={<div class="backlinks-empty-section">No linked mentions</div>}
              >
                <For each={filteredBacklinks().linked}>
                  {(backlink) => (
                    <div
                      class="backlinks-item"
                      onClick={() => props.onBacklinkClick(backlink.sourcePath, backlink.lineNumber)}
                    >
                      <div class="backlinks-item-header">
                        <span class="backlinks-item-name">{backlink.sourceName}</span>
                        {backlink.heading && (
                          <span class="backlinks-anchor">#{backlink.heading}</span>
                        )}
                        {backlink.blockId && (
                          <span class="backlinks-anchor">^{backlink.blockId}</span>
                        )}
                      </div>
                      <HighlightedContext
                        text={backlink.context}
                        start={backlink.mentionStart}
                        end={backlink.mentionEnd}
                      />
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>

          {/* Unlinked Mentions Section */}
          <div class="backlinks-section">
            <div
              class="backlinks-section-header"
              onClick={() => setUnlinkedCollapsed(!unlinkedCollapsed())}
            >
              <span class={`backlinks-chevron ${unlinkedCollapsed() ? 'collapsed' : ''}`}>▼</span>
              <span>Unlinked mentions</span>
              <span class="backlinks-count">({filteredBacklinks().unlinked.length})</span>
            </div>
            <Show when={!unlinkedCollapsed()}>
              <Show
                when={filteredBacklinks().unlinked.length > 0}
                fallback={<div class="backlinks-empty-section">No unlinked mentions</div>}
              >
                <For each={filteredBacklinks().unlinked}>
                  {(backlink) => {
                    const key = `${backlink.sourcePath}:${backlink.lineNumber}`;
                    const isLinking = () => linkingMention() === key;
                    
                    return (
                      <div class="backlinks-item unlinked">
                        <div 
                          class="backlinks-item-content"
                          onClick={() => props.onBacklinkClick(backlink.sourcePath, backlink.lineNumber)}
                        >
                          <span class="backlinks-item-name">{backlink.sourceName}</span>
                          <HighlightedContext
                            text={backlink.context}
                            start={backlink.mentionStart}
                            end={backlink.mentionEnd}
                          />
                        </div>
                        <button
                          class="backlinks-link-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleLinkMention(backlink);
                          }}
                          disabled={isLinking()}
                          title="Convert to wikilink"
                        >
                          {isLinking() ? (
                            <span class="spinner-small"></span>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                            </svg>
                          )}
                        </button>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default BacklinksPanel;
