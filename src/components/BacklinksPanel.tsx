import { Component, For, Show, createSignal, createMemo } from 'solid-js';
import { NoteGraph } from '../lib/editor/note-index';
import { BacklinksData, getBacklinksForNote } from '../lib/editor/backlinks';

interface BacklinksPanelProps {
  currentFilePath: string | null;
  currentFileName: string | null;
  graph: NoteGraph | null;
  fileContents: Map<string, string>;
  onBacklinkClick: (path: string, line?: number) => void;
  onClose: () => void;
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
                  {(backlink) => (
                    <div
                      class="backlinks-item"
                      onClick={() => props.onBacklinkClick(backlink.sourcePath, backlink.lineNumber)}
                    >
                      <span class="backlinks-item-name">{backlink.sourceName}</span>
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
        </Show>
      </div>
    </div>
  );
};

export default BacklinksPanel;
